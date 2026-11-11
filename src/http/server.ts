import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { requireAccess, type Principal } from "../domain/authorization.js";
import { pool, withPrincipal } from "../infrastructure/db.js";
import { recordHttpRequest, renderMetrics } from "../infrastructure/metrics.js";
import { handleAuth0Login } from "../infrastructure/auth0-login.js";
import { IdentityError, resolvePrincipal } from "../infrastructure/identity.js";
import { handleFinanceRoutes } from "./finance.js";
import { handleInventoryRoutes } from "./inventory.js";
import { handleReportRoutes } from "./reports.js";
import { handleImportRoutes } from "./imports.js";
import { handlePlatformAdminRoutes } from "./platform-admin.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stationRoles = new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]);
const membershipManagers = new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]);
const membershipRoleValues = new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER"]);
const port = Number(process.env.PORT ?? 3000);
const metricsPort = Number(process.env.METRICS_PORT ?? 9464);
if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65_535) {
  throw new Error("METRICS_PORT must be an integer from 1 through 65535");
}

type JsonRecord = Record<string, unknown>;

function send(response: ServerResponse, status: number, body: JsonRecord): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new IdentityError(400, "Request body is too large");
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    return value as JsonRecord;
  } catch {
    throw new IdentityError(400, "Expected a valid JSON object");
  }
}

function requireRole(principal: Principal, accepted: ReadonlySet<string>): void {
  if (!accepted.has(principal.role)) throw new IdentityError(403, "Insufficient role");
}

function requiredText(value: unknown, field: string, max = 120): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new IdentityError(400, `Invalid ${field}`);
  }
  return value.trim();
}

function stationSettings(body: JsonRecord): {
  meterMode: "NOZZLE" | "PUMP_TOTALIZER";
  closingCutoff: string;
  timeZone: string;
  closingDayRule: "CUTOFF_STARTS_DAY" | "CUTOFF_ENDS_DAY" | null | undefined;
} {
  const meterMode = body.meterMode;
  if (meterMode !== "NOZZLE" && meterMode !== "PUMP_TOTALIZER") {
    throw new IdentityError(400, "meterMode must be NOZZLE or PUMP_TOTALIZER");
  }
  const closingCutoff = requiredText(body.closingCutoff, "closing cut-off", 8);
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(closingCutoff)) {
    throw new IdentityError(400, "closingCutoff must use 24-hour HH:mm or HH:mm:ss format");
  }
  const timeZone = requiredText(body.timeZone, "time zone", 80);
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new IdentityError(400, "timeZone must be a valid IANA time zone");
  }
  let closingDayRule: "CUTOFF_STARTS_DAY" | "CUTOFF_ENDS_DAY" | null | undefined;
  if (Object.hasOwn(body, "closingDayRule")) {
    if (body.closingDayRule === null) closingDayRule = null;
    else if (body.closingDayRule === "CUTOFF_STARTS_DAY" || body.closingDayRule === "CUTOFF_ENDS_DAY") {
      closingDayRule = body.closingDayRule;
    } else {
      throw new IdentityError(400, "closingDayRule must be CUTOFF_STARTS_DAY, CUTOFF_ENDS_DAY, or null");
    }
  }
  return { meterMode, closingCutoff, timeZone, closingDayRule };
}

async function priceDailyFuel(
  client: PoolClient,
  station: { clientId: string; stationId: string; businessDate: string; meterMode: string;
    closingCutoff: string; timeZone: string; closingDayRule: string | null },
): Promise<JsonRecord> {
  if (!station.closingDayRule) return { status: "CLOSING_DAY_RULE_REQUIRED", totalSalesValue: null, products: [] };
  const result = await client.query(
    `WITH period AS (
       SELECT start_at AS starts_at, end_at AS ends_at
       FROM station_business_window($3::date, $5::time, $6, $4)
     ), by_product AS (
       SELECT COALESCE(allocation.product_id, equipment.product_id) AS product_id,
              product.code AS product_code, product.name AS product_name,
              SUM(CASE WHEN station.meter_mode = 'PUMP_TOTALIZER' THEN allocation.volume ELSE reading.volume END) AS volume
       FROM meter_reading_batches batch
       JOIN stations station ON station.client_id = batch.client_id AND station.id = batch.station_id
       JOIN meter_readings reading ON reading.client_id = batch.client_id
         AND reading.station_id = batch.station_id AND reading.batch_id = batch.id
       JOIN station_equipment equipment ON equipment.client_id = reading.client_id
         AND equipment.station_id = reading.station_id AND equipment.id = reading.equipment_id
       LEFT JOIN meter_reading_product_allocations allocation ON allocation.client_id = reading.client_id
         AND allocation.station_id = reading.station_id AND allocation.reading_id = reading.id
       JOIN products product ON product.client_id = batch.client_id
         AND product.id = COALESCE(allocation.product_id, equipment.product_id)
       WHERE batch.client_id = $1 AND batch.station_id = $2 AND batch.business_date = $3
         AND batch.status = 'VALIDATED'
       GROUP BY COALESCE(allocation.product_id, equipment.product_id), product.code, product.name
     ), price_check AS (
       SELECT volume.*, tariff.covering_count, tariff.intersecting_count, tariff.unit_price,
         CASE WHEN tariff.covering_count = 1 THEN 'PRICED'
              WHEN tariff.intersecting_count = 0 THEN 'MISSING_TARIFF'
              WHEN tariff.intersecting_count > 1 THEN 'INTRADAY_TARIFF_CHANGE'
              ELSE 'TARIFF_GAP' END AS status,
         CASE WHEN tariff.covering_count = 1 THEN round(volume.volume * tariff.unit_price, 2) END AS sales_value
       FROM by_product volume CROSS JOIN period
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE price.valid_from <= period.starts_at
           AND (price.valid_until IS NULL OR price.valid_until >= period.ends_at)) AS covering_count,
           count(*) AS intersecting_count,
           max(price.unit_price) FILTER (WHERE price.valid_from <= period.starts_at
             AND (price.valid_until IS NULL OR price.valid_until >= period.ends_at)) AS unit_price
         FROM fuel_tariffs price
         WHERE price.client_id = $1 AND price.station_id = $2 AND price.product_id = volume.product_id
           AND price.valid_from < period.ends_at
           AND COALESCE(price.valid_until, 'infinity'::timestamptz) > period.starts_at
       ) tariff ON true
     )
     SELECT CASE WHEN count(*) = 0 THEN 'NO_VALIDATED_VOLUMES'
                 WHEN bool_and(status = 'PRICED') THEN 'PRICED' ELSE 'INCOMPLETE' END AS status,
       CASE WHEN count(*) > 0 AND bool_and(status = 'PRICED') THEN round(sum(sales_value), 2) END AS total_sales_value,
       COALESCE(jsonb_agg(jsonb_build_object(
         'productId', product_id, 'productCode', product_code, 'productName', product_name,
         'volumeLiters', volume, 'unitPrice', unit_price, 'status', status, 'salesValue', sales_value
       ) ORDER BY product_code), '[]'::jsonb) AS products,
       (SELECT starts_at FROM period) AS starts_at, (SELECT ends_at FROM period) AS ends_at
     FROM price_check`,
    [station.clientId, station.stationId, station.businessDate, station.closingDayRule,
      station.closingCutoff, station.timeZone],
  );
  return {
    status: result.rows[0].status,
    totalSalesValue: result.rows[0].total_sales_value,
    periodStartsAt: result.rows[0].starts_at,
    periodEndsAt: result.rows[0].ends_at,
    products: result.rows[0].products,
  };
}

async function stationClosingWindow(
  client: PoolClient,
  station: { businessDate: string; closingCutoff: string; timeZone: string; closingDayRule: string | null },
): Promise<JsonRecord> {
  if (!station.closingDayRule) {
    return { status: "DAY_BOUNDARY_RULE_REQUIRED", canClose: false, startsAt: null, endsAt: null };
  }
  const result = await client.query(
    `SELECT start_at, end_at, end_at <= now() AS closing_window_ended
     FROM station_business_window($1::date, $2::time, $3, $4)`,
    [station.businessDate, station.closingCutoff, station.timeZone, station.closingDayRule],
  );
  const window = result.rows[0] as {
    start_at: Date; end_at: Date; closing_window_ended: boolean;
  } | undefined;
  if (!window) throw new Error("Could not calculate the station business-day window");
  return {
    status: window.closing_window_ended ? "CUTOFF_PASSED" : "WAITING_FOR_CUTOFF",
    canClose: window.closing_window_ended,
    startsAt: window.start_at,
    endsAt: window.end_at,
  };
}

function clientRole(value: unknown): "OWNER" | "MANAGER" | "ACCOUNTANT" | "CASHIER" {
  const role = requiredText(value, "client role", 20).toUpperCase();
  if (!membershipRoleValues.has(role)) throw new IdentityError(400, "Invalid client role");
  return role as "OWNER" | "MANAGER" | "ACCOUNTANT" | "CASHIER";
}

function stationIdList(value: unknown, allowMissing = false): string[] | undefined {
  if (allowMissing && value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && uuidPattern.test(id))) {
    throw new IdentityError(400, "stationIds must be an array of station identifiers");
  }
  return [...new Set(value as string[])];
}

function requiredDecimal(value: unknown, field: string): string {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/.test(text)) {
    throw new IdentityError(400, `Invalid ${field}`);
  }
  const [integer, fraction = ""] = text.split(".");
  return `${integer}.${fraction.padEnd(4, "0")}`;
}

function requiredIndex(value: unknown, field: string): string {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9]\d{0,10})(\.\d{1,3})?$/.test(text)) {
    throw new IdentityError(400, `Invalid ${field}; use a non-negative value with at most three decimal places`);
  }
  const [integer, fraction = ""] = text.split(".");
  return `${integer}.${fraction.padEnd(3, "0")}`;
}

function indexThousandths(value: string): bigint {
  const [integer, fraction = ""] = value.split(".");
  return BigInt(integer) * 1000n + BigInt(fraction.padEnd(3, "0"));
}

function formatThousandths(value: bigint): string {
  const whole = value / 1000n;
  const fraction = (value % 1000n).toString().padStart(3, "0");
  return `${whole}.${fraction}`;
}

function requiredMoney(value: unknown, field: string): string {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(text)) {
    throw new IdentityError(400, `Invalid ${field}; use a non-negative amount with at most two decimal places`);
  }
  const [integer, fraction = ""] = text.split(".");
  return `${integer}.${fraction.padEnd(2, "0")}`;
}

function requiredBusinessDate(value: unknown): string {
  const text = requiredText(value, "businessDate", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new IdentityError(400, "businessDate must use YYYY-MM-DD");
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new IdentityError(400, "businessDate is not a valid calendar date");
  }
  return text;
}

function requiredTimestamp(value: unknown, field: string): string {
  const text = requiredText(value, field, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/i.test(text)
    || Number.isNaN(Date.parse(text))) {
    throw new IdentityError(400, `${field} must be an ISO timestamp with a time zone`);
  }
  return text;
}

async function validateStations(client: PoolClient, clientId: string, stationIds: readonly string[]): Promise<void> {
  if (stationIds.length === 0) return;
  const result = await client.query(
    "SELECT id FROM stations WHERE client_id = $1 AND id = ANY($2::uuid[])",
    [clientId, stationIds],
  );
  if (result.rowCount !== stationIds.length) {
    throw new IdentityError(400, "Every station assignment must belong to the selected client");
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (await handleAuth0Login(request, response)) return;
  if (request.method === "GET" && url.pathname === "/app") {
    const page = await readFile(new URL("../ui/operations.html", import.meta.url));
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(page);
    return;
  }
  if (request.method === "GET" && url.pathname === "/admin/platform") {
    const page = await readFile(new URL("../ui/platform-admin.html", import.meta.url));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(page); return;
  }
  if (request.method === "GET" && url.pathname === "/admin/platform.js") {
    const file = await readFile(new URL("../ui/platform-admin.js", import.meta.url));
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(file); return;
  }
  if (request.method === "GET" && url.pathname === "/app/operations.css") {
    const file = await readFile(new URL("../ui/operations.css", import.meta.url));
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    response.end(file);
    return;
  }
  if (request.method === "GET" && url.pathname === "/app/read-excel-file.min.js") {
    const file = await readFile(new URL("../ui/vendor/read-excel-file.min.js", import.meta.url));
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(file); return;
  }
  if (request.method === "GET" && url.pathname === "/app/import-parser.js") {
    const file = await readFile(new URL("../ui/import-parser.js", import.meta.url));
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(file); return;
  }
  if (request.method === "GET" && url.pathname === "/app/operations.js") {
    const file = await readFile(new URL("../ui/operations.js", import.meta.url));
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(file);
    return;
  }
  if (request.method === "GET" && url.pathname === "/app/french.js") {
    const file = await readFile(new URL("../ui/french.js", import.meta.url));
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(file);
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    try {
      await pool.query("SELECT 1");
      send(response, 200, { status: "ok", database: "ready" });
    } catch {
      send(response, 503, { status: "unavailable", database: "unavailable" });
    }
    return;
  }

  const principal = await resolvePrincipal(request);

  if (request.method === "GET" && url.pathname === "/workspaces") {
    const result = await withPrincipal(principal, async (client) => {
      const workspaces = await client.query<{ workspaces: unknown }>("SELECT app_list_workspaces() AS workspaces");
      return workspaces.rows[0]?.workspaces ?? [];
    });
    send(response, 200, { workspaces: result });
    return;
  }

  if (request.method === "GET" && url.pathname === "/me") {
    send(response, 200, {
      userId: principal.userId,
      clientId: principal.clientId,
      role: principal.role,
    });
    return;
  }

  if (await handleFinanceRoutes(request, response, principal, url)) return;
  if (await handleInventoryRoutes(request, response, principal, url)) return;
  if (await handleReportRoutes(request, response, principal, url)) return;
  if (await handleImportRoutes(request, response, principal, url)) return;
  if (await handlePlatformAdminRoutes(request, response, principal, url)) return;

  const tankCalibrationsRoute = url.pathname.match(/^\/stations\/([^/]+)\/tanks\/([^/]+)\/calibrations$/);
  if (tankCalibrationsRoute && (request.method === "GET" || request.method === "POST")) {
    const [, stationId, tankId] = tankCalibrationsRoute;
    if (!uuidPattern.test(stationId) || !uuidPattern.test(tankId)) throw new IdentityError(404, "Tank not found");
    requireRole(principal, request.method === "GET"
      ? new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"])
      : new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]));
    const result = await withPrincipal(principal, async (client) => {
      const tankResult = await client.query(
        `SELECT client_id FROM station_equipment
         WHERE station_id = $1 AND id = $2 AND kind = 'TANK' AND retired_at IS NULL`,
        [stationId, tankId],
      );
      const tank = tankResult.rows[0] as { client_id: string } | undefined;
      if (!tank) throw new IdentityError(404, "Active station tank not found");
      requireAccess(principal, { clientId: tank.client_id, stationId });
      if (principal.clientId !== tank.client_id) {
        throw new IdentityError(403, "Select this client before managing tank calibration");
      }

      if (request.method === "GET") {
        const calibrations = await client.query(
          `SELECT calibration.id, calibration.effective_from, calibration.status,
                  calibration.created_by, calibration.created_at, calibration.activated_by, calibration.activated_at,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'depthMm', point.depth_mm, 'volumeLiters', point.volume_liters
                  ) ORDER BY point.depth_mm)
                    FROM tank_calibration_points point WHERE point.calibration_id = calibration.id), '[]'::jsonb) AS points
           FROM tank_calibrations calibration
           WHERE calibration.client_id = $1 AND calibration.station_id = $2 AND calibration.tank_id = $3
           ORDER BY calibration.effective_from DESC`,
          [tank.client_id, stationId, tankId],
        );
        return { stationId, tankId, calibrations: calibrations.rows };
      }

      const body = await readJson(request);
      const effectiveFrom = requiredBusinessDate(body.effectiveFrom);
      if (!Array.isArray(body.points) || body.points.length < 2 || body.points.length > 500) {
        throw new IdentityError(400, "points must contain between 2 and 500 depth/volume pairs");
      }
      const points = body.points.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new IdentityError(400, "Each calibration point must be an object");
        }
        const point = entry as JsonRecord;
        return {
          depthMm: requiredIndex(point.depthMm, "calibration depth in millimetres"),
          volumeLiters: requiredIndex(point.volumeLiters, "calibration volume in litres"),
        };
      }).sort((a, b) => {
        const difference = indexThousandths(a.depthMm) - indexThousandths(b.depthMm);
        return difference < 0n ? -1 : difference > 0n ? 1 : 0;
      });
      for (let index = 1; index < points.length; index += 1) {
        if (indexThousandths(points[index].depthMm) <= indexThousandths(points[index - 1].depthMm)
          || indexThousandths(points[index].volumeLiters) <= indexThousandths(points[index - 1].volumeLiters)) {
          throw new IdentityError(400, "Calibration depths and volumes must both increase strictly");
        }
      }

      const inserted = await client.query(
        `INSERT INTO tank_calibrations
           (client_id, station_id, tank_id, effective_from, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, effective_from, status, created_by, created_at`,
        [tank.client_id, stationId, tankId, effectiveFrom, principal.userId],
      );
      const calibration = inserted.rows[0];
      for (const point of points) {
        await client.query(
          `INSERT INTO tank_calibration_points (client_id, station_id, calibration_id, depth_mm, volume_liters)
           VALUES ($1, $2, $3, $4, $5)`,
          [tank.client_id, stationId, calibration.id, point.depthMm, point.volumeLiters],
        );
      }
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'TANK_CALIBRATION_DRAFT_CREATED', 'tank_calibrations', $4, $5::jsonb)`,
        [tank.client_id, stationId, principal.userId, calibration.id, JSON.stringify({ tankId, effectiveFrom, pointCount: points.length })],
      );
      return { calibration: { ...calibration, points } };
    });
    send(response, request.method === "POST" ? 201 : 200, result);
    return;
  }

  const activateTankCalibrationRoute = url.pathname.match(/^\/stations\/([^/]+)\/tanks\/([^/]+)\/calibrations\/([^/]+)\/activate$/);
  if (request.method === "POST" && activateTankCalibrationRoute) {
    const [, stationId, tankId, calibrationId] = activateTankCalibrationRoute;
    if (![stationId, tankId, calibrationId].every((value) => uuidPattern.test(value))) {
      throw new IdentityError(404, "Tank calibration not found");
    }
    requireRole(principal, new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]));
    const result = await withPrincipal(principal, async (client) => {
      const tankResult = await client.query(
        `SELECT client_id FROM station_equipment
         WHERE station_id = $1 AND id = $2 AND kind = 'TANK'`,
        [stationId, tankId],
      );
      const tank = tankResult.rows[0] as { client_id: string } | undefined;
      if (!tank) throw new IdentityError(404, "Tank not found");
      requireAccess(principal, { clientId: tank.client_id, stationId });
      if (principal.clientId !== tank.client_id) {
        throw new IdentityError(403, "Select this client before activating tank calibration");
      }
      const activated = await client.query(
        `UPDATE tank_calibrations SET status = 'ACTIVE', activated_by = $4, activated_at = now()
         WHERE client_id = $1 AND station_id = $2 AND tank_id = $3 AND id = $5 AND status = 'DRAFT'
         RETURNING id, effective_from, status, activated_by, activated_at`,
        [tank.client_id, stationId, tankId, principal.userId, calibrationId],
      );
      if (!activated.rowCount) throw new IdentityError(409, "Draft calibration was not found or is already active");
      const calibration = activated.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'TANK_CALIBRATION_ACTIVATED', 'tank_calibrations', $4, $5::jsonb)`,
        [tank.client_id, stationId, principal.userId, calibration.id, JSON.stringify({ tankId, effectiveFrom: calibration.effective_from })],
      );
      return { calibration };
    });
    send(response, 200, result);
    return;
  }

  const closingAdjustmentsRoute = url.pathname.match(/^\/stations\/([^/]+)\/daily-closing\/([^/]+)\/adjustments$/);
  if (closingAdjustmentsRoute && (request.method === "GET" || request.method === "POST")) {
    const [, stationId, closingId] = closingAdjustmentsRoute;
    if (!uuidPattern.test(stationId) || !uuidPattern.test(closingId)) throw new IdentityError(404, "Station-day closing not found");
    requireRole(principal, request.method === "GET"
      ? new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"])
      : new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]));
    const result = await withPrincipal(principal, async (client) => {
      const closingResult = await client.query(
        `SELECT id, client_id, station_id, business_date, snapshot
         FROM station_day_closings WHERE id = $1 AND station_id = $2`,
        [closingId, stationId],
      );
      const closing = closingResult.rows[0] as {
        id: string; client_id: string; station_id: string; business_date: string; snapshot: JsonRecord;
      } | undefined;
      if (!closing) throw new IdentityError(404, "Station-day closing not found");
      requireAccess(principal, { clientId: closing.client_id, stationId });
      if (principal.clientId !== closing.client_id) {
        throw new IdentityError(403, "Select this client before viewing or adjusting the station-day close");
      }

      if (request.method === "GET") {
        const history = await client.query(
          `SELECT id, adjustment_number, reason, before_snapshot, after_snapshot, created_by, created_at
           FROM station_day_closing_adjustments
           WHERE client_id = $1 AND station_id = $2 AND closing_id = $3
           ORDER BY adjustment_number`,
          [closing.client_id, stationId, closingId],
        );
        return { closingId, businessDate: closing.business_date, adjustments: history.rows };
      }

      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [closingId]);
      const body = await readJson(request);
      const reason = requiredText(body.reason, "adjustment reason", 1000);
      const changesCash = Object.hasOwn(body, "cashTotal");
      const changesCard = Object.hasOwn(body, "cardTotal");
      const changesDips = Object.hasOwn(body, "dips");
      if (!changesCash && !changesCard && !changesDips) {
        throw new IdentityError(400, "Provide a cashTotal, cardTotal, or dips correction");
      }
      const cashTotal = changesCash ? requiredMoney(body.cashTotal, "cash total") : undefined;
      const cardTotal = changesCard ? requiredMoney(body.cardTotal, "card total") : undefined;
      const currentAdjustment = await client.query(
        `SELECT adjustment_number, after_snapshot FROM station_day_closing_adjustments
         WHERE closing_id = $1 ORDER BY adjustment_number DESC LIMIT 1`,
        [closingId],
      );
      const beforeSnapshot = (currentAdjustment.rows[0]?.after_snapshot ?? closing.snapshot) as JsonRecord;
      const previousCollections = beforeSnapshot.collectionsAndDips as JsonRecord | undefined;
      if (!previousCollections) throw new IdentityError(409, "Station-day close snapshot is incomplete and cannot be adjusted");
      const currentTanks = Array.isArray(previousCollections.tanks) ? previousCollections.tanks : [];
      let tanks = currentTanks;
      if (changesDips) {
        if (!Array.isArray(body.dips) || body.dips.length > 100) {
          throw new IdentityError(400, "dips must be an array with at most 100 tank readings");
        }
        const correctedDips = body.dips.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new IdentityError(400, "Each corrected dip must be an object");
          }
          const item = entry as JsonRecord;
          const tankId = requiredText(item.tankId, "tank identifier", 36);
          if (!uuidPattern.test(tankId)) throw new IdentityError(400, "Invalid tank identifier");
          const productDepthMm = requiredIndex(item.productDepthMm, "product depth in millimetres");
          const waterDepthMm = item.waterDepthMm === undefined || item.waterDepthMm === null
            ? null : requiredIndex(item.waterDepthMm, "water depth in millimetres");
          if (waterDepthMm !== null && indexThousandths(waterDepthMm) > indexThousandths(productDepthMm)) {
            throw new IdentityError(400, "Water depth cannot exceed product depth");
          }
          return { tankId, productDepthMm, waterDepthMm };
        });
        if (new Set(correctedDips.map((dip) => dip.tankId)).size !== correctedDips.length) {
          throw new IdentityError(400, "A tank can appear only once in a correction");
        }
        const activeTanks = await client.query(
          `SELECT id FROM station_equipment
           WHERE client_id = $1 AND station_id = $2 AND kind = 'TANK' AND retired_at IS NULL ORDER BY code`,
          [closing.client_id, stationId],
        );
        if (activeTanks.rows.length !== correctedDips.length
          || activeTanks.rows.some((row: { id: string }) => !correctedDips.some((dip) => dip.tankId === row.id))) {
          throw new IdentityError(400, "A correction must include one dip for every active station tank");
        }
        tanks = [];
        for (const dip of correctedDips) {
          const tankResult = await client.query(
            `SELECT e.id, e.code,
                    (SELECT effective_from FROM tank_calibrations calibration
                     WHERE calibration.client_id = e.client_id AND calibration.station_id = e.station_id
                       AND calibration.tank_id = e.id AND calibration.status = 'ACTIVE'
                       AND calibration.effective_from <= $3::date
                     ORDER BY effective_from DESC LIMIT 1) AS calibration_effective_from,
                    tank_volume_at_depth($1, $2, e.id, $3::date, $4::numeric) AS estimated_volume_liters
             FROM station_equipment e WHERE e.client_id = $1 AND e.station_id = $2 AND e.id = $5`,
            [closing.client_id, stationId, closing.business_date, dip.productDepthMm, dip.tankId],
          );
          const tank = tankResult.rows[0];
          if (!tank) throw new IdentityError(400, "Every corrected dip must reference an active station tank");
          tanks.push({
            tank_id: tank.id,
            tank_code: tank.code,
            product_depth_mm: dip.productDepthMm,
            water_depth_mm: dip.waterDepthMm,
            calibration_effective_from: tank.calibration_effective_from,
            estimated_volume_liters: tank.estimated_volume_liters,
          });
        }
      }

      const actualBeforeSnapshot = beforeSnapshot;
      const actualCollections = previousCollections;
      const afterSnapshot = {
        ...actualBeforeSnapshot,
        collectionsAndDips: {
          ...actualCollections,
          cashTotal: cashTotal ?? actualCollections.cashTotal,
          cardTotal: cardTotal ?? actualCollections.cardTotal,
          tanks,
        },
      };
      const adjustmentNumber = Number(currentAdjustment.rows[0]?.adjustment_number ?? 0) + 1;
      const adjustmentResult = await client.query(
        `INSERT INTO station_day_closing_adjustments
           (client_id, station_id, closing_id, adjustment_number, reason, before_snapshot, after_snapshot, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
         RETURNING id, adjustment_number, reason, before_snapshot, after_snapshot, created_by, created_at`,
        [closing.client_id, stationId, closingId, adjustmentNumber, reason,
          JSON.stringify(actualBeforeSnapshot), JSON.stringify(afterSnapshot), principal.userId],
      );
      const adjustment = adjustmentResult.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'STATION_DAY_CLOSING_ADJUSTED', 'station_day_closing_adjustments', $4, $5::jsonb)`,
        [closing.client_id, stationId, principal.userId, adjustment.id,
          JSON.stringify({ closingId, adjustmentNumber, reason })],
      );
      return { adjustment };
    });
    send(response, request.method === "POST" ? 201 : 200, result);
    return;
  }

  const dailyClosingRoute = url.pathname.match(/^\/stations\/([^/]+)\/daily-closing$/);
  if (request.method === "GET" && dailyClosingRoute) {
    const stationId = dailyClosingRoute[1];
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    requireRole(principal, new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"]));
    const businessDate = requiredBusinessDate(url.searchParams.get("date"));
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query("SELECT client_id FROM stations WHERE id = $1", [stationId]);
      const station = stationResult.rows[0] as { client_id: string } | undefined;
      if (!station) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId: station.client_id, stationId });
      if (principal.clientId !== station.client_id) {
        throw new IdentityError(403, "Select this client before viewing its station-day closing");
      }
      const closingResult = await client.query(
        `SELECT closing.id, closing.business_date, closing.snapshot AS original_snapshot,
                closing.closed_by, closing.closed_at,
                adjustment.adjustment_number AS last_adjustment_number,
                adjustment.after_snapshot AS current_snapshot,
                adjustment.created_at AS last_adjusted_at
         FROM station_day_closings closing
         LEFT JOIN LATERAL (
           SELECT adjustment_number, after_snapshot, created_at
           FROM station_day_closing_adjustments
           WHERE client_id = closing.client_id AND station_id = closing.station_id
             AND closing_id = closing.id
           ORDER BY adjustment_number DESC LIMIT 1
         ) adjustment ON true
         WHERE closing.client_id = $1 AND closing.station_id = $2 AND closing.business_date = $3`,
        [station.client_id, stationId, businessDate],
      );
      const closing = closingResult.rows[0];
      if (!closing) throw new IdentityError(404, "Station-day closing not found");
      const history = await client.query(
        `SELECT id, adjustment_number, reason, before_snapshot, after_snapshot, created_by, created_at
         FROM station_day_closing_adjustments
         WHERE client_id = $1 AND station_id = $2 AND closing_id = $3
         ORDER BY adjustment_number`,
        [station.client_id, stationId, closing.id],
      );
      return { stationId, closing: { ...closing, adjustments: history.rows } };
    });
    send(response, 200, result);
    return;
  }
  if (request.method === "POST" && dailyClosingRoute) {
    const stationId = dailyClosingRoute[1];
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    requireRole(principal, new Set(["OWNER", "MANAGER", "CASHIER", "SUPER_ADMIN"]));
    const businessDate = requiredBusinessDate(url.searchParams.get("date"));
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query(
        `SELECT id, client_id, meter_mode, closing_cutoff::text, time_zone, closing_day_rule
         FROM stations WHERE id = $1`, [stationId],
      );
      const station = stationResult.rows[0] as {
        id: string; client_id: string; meter_mode: string; closing_cutoff: string;
        time_zone: string; closing_day_rule: string | null;
      } | undefined;
      if (!station) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId: station.client_id, stationId });
      if (principal.clientId !== station.client_id) {
        throw new IdentityError(403, "Select this client before closing the station day");
      }
      const closingWindow = await stationClosingWindow(client, {
        businessDate,
        closingCutoff: station.closing_cutoff,
        timeZone: station.time_zone,
        closingDayRule: station.closing_day_rule,
      });
      if (closingWindow.status === "DAY_BOUNDARY_RULE_REQUIRED") {
        throw new IdentityError(409, "Configure the station closing-day rule before closing a station day");
      }
      if (!closingWindow.canClose) {
        throw new IdentityError(409, "The station business day has not reached its configured closing cut-off");
      }

      const [batchResult, inputsResult] = await Promise.all([
        client.query(
          `SELECT id, status FROM meter_reading_batches
           WHERE client_id = $1 AND station_id = $2 AND business_date = $3 FOR UPDATE`,
          [station.client_id, stationId, businessDate],
        ),
        client.query(
          `SELECT id, cash_total, card_total, currency_code, status FROM station_day_inputs
           WHERE client_id = $1 AND station_id = $2 AND business_date = $3 FOR UPDATE`,
          [station.client_id, stationId, businessDate],
        ),
      ]);
      const batch = batchResult.rows[0] as { id: string; status: string } | undefined;
      const inputs = inputsResult.rows[0] as {
        id: string; cash_total: string; card_total: string; currency_code: string | null; status: string;
      } | undefined;
      if (!batch || batch.status !== "VALIDATED") {
        throw new IdentityError(409, "Validate meter readings before closing this station day");
      }
      if (!inputs || inputs.status !== "VALIDATED") {
        throw new IdentityError(409, "Validate cash/card totals and tank dips before closing this station day");
      }
      if (!inputs.currency_code) throw new IdentityError(409, "Set the daily cash/card currency before closing this station day");

      const existing = await client.query(
        `SELECT id, closed_at FROM station_day_closings
         WHERE client_id = $1 AND station_id = $2 AND business_date = $3`,
        [station.client_id, stationId, businessDate],
      );
      if (existing.rowCount) throw new IdentityError(409, "This station day is already closed");

      const volumes = await client.query(
        `SELECT source.product_id, p.code AS product_code, p.name AS product_name,
                SUM(source.volume)::numeric(14, 3) AS volume
         FROM (
           SELECT COALESCE(a.product_id, e.product_id) AS product_id,
                  CASE WHEN s.meter_mode = 'PUMP_TOTALIZER' THEN a.volume ELSE r.volume END AS volume
           FROM meter_reading_batches b
           JOIN stations s ON s.client_id = b.client_id AND s.id = b.station_id
           JOIN meter_readings r ON r.client_id = b.client_id AND r.station_id = b.station_id AND r.batch_id = b.id
           JOIN station_equipment e ON e.client_id = r.client_id AND e.station_id = r.station_id AND e.id = r.equipment_id
           LEFT JOIN meter_reading_product_allocations a ON a.client_id = r.client_id
             AND a.station_id = r.station_id AND a.reading_id = r.id
           WHERE b.id = $1
         ) source
         JOIN products p ON p.client_id = $2 AND p.id = source.product_id
         GROUP BY source.product_id, p.code, p.name ORDER BY p.code`,
        [batch.id, station.client_id],
      );
      const dips = await client.query(
        `SELECT e.id AS tank_id, e.code AS tank_code, dip.product_depth_mm, dip.water_depth_mm,
                calibration.effective_from AS calibration_effective_from,
                tank_volume_at_depth($1, $2, e.id, $3::date, dip.product_depth_mm) AS estimated_volume_liters
         FROM station_day_dips dip
         JOIN station_equipment e ON e.client_id = dip.client_id AND e.station_id = dip.station_id AND e.id = dip.tank_id
         LEFT JOIN LATERAL (
           SELECT effective_from FROM tank_calibrations
           WHERE client_id = $1 AND station_id = $2 AND tank_id = e.id
             AND status = 'ACTIVE' AND effective_from <= $3::date
           ORDER BY effective_from DESC LIMIT 1
         ) calibration ON true
         WHERE dip.day_input_id = $4 ORDER BY e.code`,
        [station.client_id, stationId, businessDate, inputs.id],
      );
      const reconciliation = await client.query(
        `SELECT id, revision_number, reported_cash_total, reported_card_total,
                counted_cash_total, card_settlement_total, cash_variance, card_variance,
                currency_code AS "currencyCode",max_abs_cash_variance AS "maxAbsCashVariance",
                max_abs_card_variance AS "maxAbsCardVariance",
                CASE WHEN max_abs_cash_variance IS NULL THEN NULL ELSE abs(cash_variance)<=max_abs_cash_variance END AS "cashWithinTolerance",
                CASE WHEN max_abs_card_variance IS NULL THEN NULL ELSE abs(card_variance)<=max_abs_card_variance END AS "cardWithinTolerance",
                (cash_variance = 0 AND card_variance = 0) AS balanced,
                card_settlement_reference, reason, recorded_by, recorded_at
         FROM station_day_reconciliations
         WHERE client_id = $1 AND station_id = $2 AND day_input_id = $3
         ORDER BY revision_number DESC LIMIT 1`,
        [station.client_id, stationId, inputs.id],
      );
      const snapshot = {
        businessWindow: {
          closingDayRule: station.closing_day_rule,
          startsAt: closingWindow.startsAt,
          endsAt: closingWindow.endsAt,
        },
        meterReadings: { batchId: batch.id, products: volumes.rows },
        salesPricing: await priceDailyFuel(client, {
          clientId: station.client_id, stationId, businessDate, meterMode: station.meter_mode,
          closingCutoff: station.closing_cutoff, timeZone: station.time_zone,
          closingDayRule: station.closing_day_rule,
        }),
        collectionsAndDips: {
          dayInputId: inputs.id,
          cashTotal: inputs.cash_total,
          cardTotal: inputs.card_total,
          currencyCode: inputs.currency_code,
          manualReconciliation: reconciliation.rows[0] ?? null,
          tanks: dips.rows,
        },
      };
      const closed = await client.query(
        `INSERT INTO station_day_closings
           (client_id, station_id, business_date, meter_reading_batch_id, station_day_input_id, snapshot, closed_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id, business_date, snapshot, closed_by, closed_at`,
        [station.client_id, stationId, businessDate, batch.id, inputs.id, JSON.stringify(snapshot), principal.userId],
      );
      const closing = closed.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'STATION_DAY_CLOSED', 'station_day_closings', $4, $5::jsonb)`,
        [station.client_id, stationId, principal.userId, closing.id, JSON.stringify({ businessDate })],
      );
      return {
        closing,
        closingWindow,
        scope: "operational; fuel-stock reconciliation and financial sale allocation are not included",
      };
    });
    send(response, 201, result);
    return;
  }

  const dailyStateRoute = url.pathname.match(/^\/stations\/([^/]+)\/daily-state$/);
  if (request.method === "GET" && dailyStateRoute) {
    const stationId = dailyStateRoute[1];
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    requireRole(principal, new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"]));
    const businessDate = requiredBusinessDate(url.searchParams.get("date"));
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query(
        "SELECT id, client_id, meter_mode, closing_cutoff::text, time_zone, closing_day_rule FROM stations WHERE id = $1",
        [stationId],
      );
      const station = stationResult.rows[0] as {
        id: string; client_id: string; meter_mode: string; closing_cutoff: string;
        time_zone: string; closing_day_rule: string | null;
      } | undefined;
      if (!station) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId: station.client_id, stationId });
      if (principal.clientId !== station.client_id) {
        throw new IdentityError(403, "Select this client before viewing daily operations");
      }

      const [batchResult, inputsResult, volumesResult, closingResult, reconciliationResult] = await Promise.all([
        client.query(
          `SELECT id, status, submitted_at, validated_at
           FROM meter_reading_batches WHERE client_id = $1 AND station_id = $2 AND business_date = $3`,
          [station.client_id, stationId, businessDate],
        ),
        client.query(
          `SELECT id, cash_total, card_total, currency_code AS "currencyCode", status, entered_at, validated_at
           FROM station_day_inputs WHERE client_id = $1 AND station_id = $2 AND business_date = $3`,
          [station.client_id, stationId, businessDate],
        ),
        client.query(
          `SELECT product_id, product_code, product_name, SUM(volume) AS volume
           FROM (
             SELECT COALESCE(a.product_id, e.product_id) AS product_id,
                    p.code AS product_code, p.name AS product_name,
                    CASE WHEN b.status = 'VALIDATED' THEN
                      CASE WHEN s.meter_mode = 'PUMP_TOTALIZER' THEN a.volume ELSE r.volume END
                    ELSE NULL END AS volume
             FROM meter_reading_batches b
             JOIN stations s ON s.client_id = b.client_id AND s.id = b.station_id
             JOIN meter_readings r ON r.client_id = b.client_id AND r.station_id = b.station_id AND r.batch_id = b.id
             JOIN station_equipment e ON e.client_id = r.client_id AND e.station_id = r.station_id AND e.id = r.equipment_id
             LEFT JOIN meter_reading_product_allocations a ON a.client_id = r.client_id
               AND a.station_id = r.station_id AND a.reading_id = r.id
             JOIN products p ON p.client_id = b.client_id AND p.id = COALESCE(a.product_id, e.product_id)
             WHERE b.client_id = $1 AND b.station_id = $2 AND b.business_date = $3
           ) by_product
           GROUP BY product_id, product_code, product_name ORDER BY product_code`,
          [station.client_id, stationId, businessDate],
        ),
        client.query(
          `SELECT closing.id, closing.closed_by, closing.closed_at,
                  adjustment.adjustment_number, adjustment.created_at AS last_adjusted_at,
                  adjustment.after_snapshot AS current_snapshot
           FROM station_day_closings closing
           LEFT JOIN LATERAL (
             SELECT adjustment_number, created_at, after_snapshot
             FROM station_day_closing_adjustments
             WHERE closing_id = closing.id
             ORDER BY adjustment_number DESC LIMIT 1
           ) adjustment ON true
           WHERE closing.client_id = $1 AND closing.station_id = $2 AND closing.business_date = $3`,
          [station.client_id, stationId, businessDate],
        ),
        client.query(
          `SELECT r.id, r.revision_number, r.reported_cash_total, r.reported_card_total,
                  r.counted_cash_total, r.card_settlement_total, r.cash_variance, r.card_variance,
                  r.currency_code AS "currencyCode",r.max_abs_cash_variance AS "maxAbsCashVariance",
                  r.max_abs_card_variance AS "maxAbsCardVariance",
                  CASE WHEN r.max_abs_cash_variance IS NULL THEN NULL ELSE abs(r.cash_variance)<=r.max_abs_cash_variance END AS "cashWithinTolerance",
                  CASE WHEN r.max_abs_card_variance IS NULL THEN NULL ELSE abs(r.card_variance)<=r.max_abs_card_variance END AS "cardWithinTolerance",
                  (r.cash_variance = 0 AND r.card_variance = 0) AS balanced,
                  r.card_settlement_reference, r.reason, r.recorded_by, r.recorded_at
           FROM station_day_reconciliations r
           JOIN station_day_inputs d ON d.client_id = r.client_id AND d.station_id = r.station_id
             AND d.id = r.day_input_id
           WHERE r.client_id = $1 AND r.station_id = $2 AND d.business_date = $3
           ORDER BY revision_number DESC LIMIT 1`,
          [station.client_id, stationId, businessDate],
        ),
      ]);
      const dipsResult = await client.query(
        `SELECT e.id AS tank_id, e.code AS tank_code, dip.product_depth_mm, dip.water_depth_mm,
                calibration.effective_from AS calibration_effective_from,
                tank_volume_at_depth($1, $2, e.id, $4::date, dip.product_depth_mm) AS estimated_volume_liters
         FROM station_equipment e
         LEFT JOIN station_day_dips dip ON dip.client_id = e.client_id AND dip.station_id = e.station_id
           AND dip.tank_id = e.id AND dip.day_input_id = $3
         LEFT JOIN LATERAL (
           SELECT effective_from FROM tank_calibrations
           WHERE client_id = $1 AND station_id = $2 AND tank_id = e.id
             AND status = 'ACTIVE' AND effective_from <= $4::date
           ORDER BY effective_from DESC LIMIT 1
         ) calibration ON true
         WHERE e.client_id = $1 AND e.station_id = $2 AND e.kind = 'TANK' AND e.retired_at IS NULL
         ORDER BY e.code`,
        [station.client_id, stationId, inputsResult.rows[0]?.id ?? null, businessDate],
      );
      const batch = batchResult.rows[0] ?? null;
      const dayInputs = inputsResult.rows[0] ?? null;
      const closingWindow = await stationClosingWindow(client, {
        businessDate,
        closingCutoff: station.closing_cutoff,
        timeZone: station.time_zone,
        closingDayRule: station.closing_day_rule,
      });
      const readingsValidated = batch?.status === "VALIDATED";
      const inputsValidated = dayInputs?.status === "VALIDATED";
      const salesPricing = readingsValidated ? await priceDailyFuel(client, {
        clientId: station.client_id, stationId, businessDate, meterMode: station.meter_mode,
        closingCutoff: station.closing_cutoff, timeZone: station.time_zone,
        closingDayRule: station.closing_day_rule,
      }) : { status: "READINGS_NOT_VALIDATED", totalSalesValue: null, products: [] };
      return {
        station: {
          id: stationId, meterMode: station.meter_mode, closingCutoff: station.closing_cutoff,
          timeZone: station.time_zone, closingDayRule: station.closing_day_rule,
        },
        businessDate,
        meterReadings: {
          status: batch?.status ?? "MISSING",
          validatedAt: batch?.validated_at ?? null,
          products: readingsValidated ? volumesResult.rows : [],
          totalVolume: readingsValidated
            ? formatThousandths(volumesResult.rows.reduce(
              (sum: bigint, item: { volume: string }) => sum + indexThousandths(item.volume), 0n,
            ))
            : null,
        },
        collectionsAndDips: {
          status: dayInputs?.status ?? "MISSING",
          cashTotal: dayInputs?.cash_total ?? null,
          cardTotal: dayInputs?.card_total ?? null,
          currencyCode: dayInputs?.currencyCode ?? null,
          validatedAt: dayInputs?.validated_at ?? null,
          manualReconciliation: reconciliationResult.rows[0] ?? null,
          tanks: dipsResult.rows,
        },
        salesPricing,
        closingWindow,
        closing: closingResult.rows[0] ?? null,
        readyToClose: readingsValidated && inputsValidated && !closingResult.rows[0] && closingWindow.canClose,
        closingNote: "Readiness requires validated meter readings, cash/card totals and daily dips, plus an elapsed station cut-off in the configured time zone. Manual cash/card comparison is captured separately; fuel-stock reconciliation is not included.",
      };
    });
    send(response, 200, result);
    return;
  }

  const dayReconciliationsRoute = url.pathname.match(
    /^\/stations\/([^/]+)\/day-inputs\/(\d{4}-\d{2}-\d{2})\/reconciliations$/,
  );
  if (dayReconciliationsRoute && (request.method === "GET" || request.method === "POST")) {
    const [, stationId, dateText] = dayReconciliationsRoute;
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    requireRole(principal, request.method === "GET"
      ? new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"])
      : new Set(["OWNER", "MANAGER", "CASHIER", "SUPER_ADMIN"]));
    const businessDate = requiredBusinessDate(dateText);
    const body = request.method === "POST" ? await readJson(request) : null;
    const countedCashTotal = body ? requiredMoney(body.countedCashTotal, "counted cash total") : null;
    const cardSettlementTotal = body ? requiredMoney(body.cardSettlementTotal, "card settlement total") : null;
    const currencyCode = body && body.currencyCode != null && body.currencyCode !== ""
      ? requiredText(body.currencyCode, "reconciliation currency", 3).toUpperCase() : null;
    if (currencyCode && !/^[A-Z]{3}$/.test(currencyCode)) throw new IdentityError(400, "Currency code must be three letters");
    const reason = body ? requiredText(body.reason, "reconciliation note", 1000) : null;
    const cardSettlementReference = body && body.cardSettlementReference !== undefined
      && body.cardSettlementReference !== null
      ? requiredText(body.cardSettlementReference, "card settlement reference", 120)
      : null;
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query(
        "SELECT id, client_id FROM stations WHERE id = $1", [stationId],
      );
      const station = stationResult.rows[0] as { id: string; client_id: string } | undefined;
      if (!station) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId: station.client_id, stationId });
      if (principal.clientId !== station.client_id) {
        throw new IdentityError(403, "Select this client before managing daily reconciliation");
      }
      if (request.method === "GET") {
        const history = await client.query(
          `SELECT r.id, r.revision_number, r.reported_cash_total, r.reported_card_total,
                  r.counted_cash_total, r.card_settlement_total, r.cash_variance, r.card_variance,
                  r.currency_code AS "currencyCode",r.max_abs_cash_variance AS "maxAbsCashVariance",
                  r.max_abs_card_variance AS "maxAbsCardVariance",
                  CASE WHEN r.max_abs_cash_variance IS NULL THEN NULL ELSE abs(r.cash_variance)<=r.max_abs_cash_variance END AS "cashWithinTolerance",
                  CASE WHEN r.max_abs_card_variance IS NULL THEN NULL ELSE abs(r.card_variance)<=r.max_abs_card_variance END AS "cardWithinTolerance",
                  (r.cash_variance = 0 AND r.card_variance = 0) AS balanced,
                  r.card_settlement_reference, r.reason, r.recorded_by, r.recorded_at
           FROM station_day_reconciliations r
           JOIN station_day_inputs d ON d.client_id = r.client_id AND d.station_id = r.station_id
             AND d.id = r.day_input_id
           WHERE r.client_id = $1 AND r.station_id = $2 AND d.business_date = $3
           ORDER BY r.revision_number`,
          [station.client_id, stationId, businessDate],
        );
        return { stationId, businessDate, reconciliations: history.rows };
      }

      const dayResult = await client.query(
        `SELECT id, cash_total, card_total, currency_code, status FROM station_day_inputs
         WHERE client_id = $1 AND station_id = $2 AND business_date = $3 FOR UPDATE`,
        [station.client_id, stationId, businessDate],
      );
      const day = dayResult.rows[0] as {
        id: string; cash_total: string; card_total: string; currency_code: string | null; status: string;
      } | undefined;
      if (!day || day.status !== "VALIDATED") {
        throw new IdentityError(409, "Validate daily cash/card totals and tank dips before reconciling");
      }
      if (!day.currency_code || currencyCode !== day.currency_code) {
        throw new IdentityError(409, `Reconciliation currency must match the daily cash/card currency (${day.currency_code ?? "unset"})`);
      }
      const closing = await client.query(
        `SELECT 1 FROM station_day_closings
         WHERE client_id = $1 AND station_id = $2 AND business_date = $3`,
        [station.client_id, stationId, businessDate],
      );
      if (closing.rowCount) {
        throw new IdentityError(409, "Record reconciliation before closing this station day");
      }
      const thresholdResult=await client.query(
        `SELECT currency_code,max_abs_cash_variance,max_abs_card_variance FROM station_cash_card_variance_thresholds
         WHERE client_id=$1 AND station_id=$2 FOR SHARE`,[station.client_id,stationId]);
      const threshold=thresholdResult.rows[0] as {currency_code:string;max_abs_cash_variance:string|null;max_abs_card_variance:string|null}|undefined;
      if(threshold&&(currencyCode!==threshold.currency_code)){
        throw new IdentityError(409,`Reconciliation currency must match the configured variance policy (${threshold.currency_code})`);
      }
      const latest = await client.query(
        `SELECT COALESCE(max(revision_number), 0) AS current_revision
         FROM station_day_reconciliations WHERE day_input_id = $1`,
        [day.id],
      );
      const revisionNumber = Number(latest.rows[0].current_revision) + 1;
      const inserted = await client.query(
        `INSERT INTO station_day_reconciliations
           (client_id, station_id, day_input_id, revision_number, reported_cash_total, reported_card_total,
            counted_cash_total, card_settlement_total, card_settlement_reference, reason, recorded_by,
            currency_code,max_abs_cash_variance,max_abs_card_variance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,$12,$13,$14)
         RETURNING id, revision_number, reported_cash_total, reported_card_total,
                   counted_cash_total, card_settlement_total, cash_variance, card_variance,
                   currency_code AS "currencyCode",max_abs_cash_variance AS "maxAbsCashVariance",
                   max_abs_card_variance AS "maxAbsCardVariance",
                   CASE WHEN max_abs_cash_variance IS NULL THEN NULL ELSE abs(cash_variance)<=max_abs_cash_variance END AS "cashWithinTolerance",
                   CASE WHEN max_abs_card_variance IS NULL THEN NULL ELSE abs(card_variance)<=max_abs_card_variance END AS "cardWithinTolerance",
                   (cash_variance = 0 AND card_variance = 0) AS balanced,
                   card_settlement_reference, reason, recorded_by, recorded_at`,
        [station.client_id, stationId, day.id, revisionNumber, day.cash_total, day.card_total,
          countedCashTotal, cardSettlementTotal, cardSettlementReference, reason, principal.userId,currencyCode,
          threshold?.max_abs_cash_variance??null,threshold?.max_abs_card_variance??null],
      );
      const reconciliation = inserted.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, reason, details)
         VALUES ($1, $2, $3, 'STATION_DAY_RECONCILIATION_RECORDED', 'station_day_reconciliation', $4, $5, $6::jsonb)`,
        [station.client_id, stationId, principal.userId, reconciliation.id, reason, JSON.stringify({
          businessDate, revisionNumber, balanced: reconciliation.balanced,
          cashVariance: reconciliation.cash_variance, cardVariance: reconciliation.card_variance,
          currencyCode:reconciliation.currencyCode,cashWithinTolerance:reconciliation.cashWithinTolerance,
          cardWithinTolerance:reconciliation.cardWithinTolerance,
        })],
      );
      return { stationId, businessDate, reconciliation };
    });
    send(response, request.method === "POST" ? 201 : 200, result as JsonRecord);
    return;
  }

  const dayInputsRoute = url.pathname.match(/^\/stations\/([^/]+)\/day-inputs$/);
  if (dayInputsRoute && (request.method === "GET" || request.method === "PUT")) {
    const stationId = dayInputsRoute[1];
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    requireRole(principal, request.method === "GET"
      ? new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"])
      : new Set(["OWNER", "MANAGER", "CASHIER", "SUPER_ADMIN"]));
    const businessDate = requiredBusinessDate(url.searchParams.get("date"));
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query(
        "SELECT id, client_id FROM stations WHERE id = $1",
        [stationId],
      );
      const station = stationResult.rows[0] as { id: string; client_id: string } | undefined;
      if (!station) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId: station.client_id, stationId });
      if (principal.clientId !== station.client_id) {
        throw new IdentityError(403, "Select this client before managing daily inputs");
      }

      if (request.method === "GET") {
        const rows = await client.query(
          `SELECT d.id, d.business_date, d.cash_total, d.card_total, d.currency_code AS "currencyCode", d.status,
                  d.entered_by, d.entered_at, d.validated_by, d.validated_at,
                  COALESCE(jsonb_agg(jsonb_build_object(
                    'id', dip.id, 'tankId', dip.tank_id, 'tankCode', e.code,
                    'productDepthMm', dip.product_depth_mm, 'waterDepthMm', dip.water_depth_mm,
                    'recordedBy', dip.recorded_by, 'recordedAt', dip.recorded_at
                  ) ORDER BY e.code) FILTER (WHERE dip.id IS NOT NULL), '[]'::jsonb) AS dips
           FROM station_day_inputs d
           LEFT JOIN station_day_dips dip ON dip.client_id = d.client_id
             AND dip.station_id = d.station_id AND dip.day_input_id = d.id
           LEFT JOIN station_equipment e ON e.client_id = dip.client_id
             AND e.station_id = dip.station_id AND e.id = dip.tank_id
           WHERE d.client_id = $1 AND d.station_id = $2 AND d.business_date = $3
           GROUP BY d.id`,
          [station.client_id, stationId, businessDate],
        );
        return { stationId, businessDate, dayInputs: rows.rows[0] ?? null };
      }

      const body = await readJson(request);
      const cashTotal = requiredMoney(body.cashTotal, "cash total");
      const cardTotal = requiredMoney(body.cardTotal, "card total");
      const currencyCode = requiredText(body.currencyCode, "daily cash/card currency", 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) throw new IdentityError(400, "Currency code must be three letters");
      if (!Array.isArray(body.dips) || body.dips.length > 100) {
        throw new IdentityError(400, "dips must be an array with at most 100 tank readings");
      }
      const dips = body.dips.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new IdentityError(400, "Each dip must be an object");
        }
        const item = entry as JsonRecord;
        const tankId = requiredText(item.tankId, "tank identifier", 36);
        if (!uuidPattern.test(tankId)) throw new IdentityError(400, "Invalid tank identifier");
        const productDepthMm = requiredIndex(item.productDepthMm, "product depth in millimetres");
        const waterDepthMm = item.waterDepthMm === undefined || item.waterDepthMm === null
          ? null
          : requiredIndex(item.waterDepthMm, "water depth in millimetres");
        if (waterDepthMm !== null && Number(waterDepthMm) > Number(productDepthMm)) {
          throw new IdentityError(400, "Water depth cannot exceed product depth");
        }
        return { tankId, productDepthMm, waterDepthMm };
      });
      if (new Set(dips.map((dip) => dip.tankId)).size !== dips.length) {
        throw new IdentityError(400, "A tank can appear only once in a station-day input");
      }
      for (const dip of dips) {
        const tank = await client.query(
          `SELECT 1 FROM station_equipment
           WHERE client_id = $1 AND station_id = $2 AND id = $3
             AND kind = 'TANK' AND retired_at IS NULL`,
          [station.client_id, stationId, dip.tankId],
        );
        if (!tank.rowCount) throw new IdentityError(400, "Every dip must reference an active tank at this station");
      }

      const existing = await client.query(
        `SELECT id, status, cash_total, card_total, currency_code FROM station_day_inputs
         WHERE client_id = $1 AND station_id = $2 AND business_date = $3 FOR UPDATE`,
        [station.client_id, stationId, businessDate],
      );
      const current = existing.rows[0] as {
        id: string; status: string; cash_total: string; card_total: string; currency_code: string | null;
      } | undefined;
      if (current?.status === "VALIDATED") {
        throw new IdentityError(409, "This station-day input is validated and locked");
      }
      const previousDips = current
        ? await client.query(
          `SELECT tank_id, product_depth_mm, water_depth_mm FROM station_day_dips
           WHERE day_input_id = $1 ORDER BY tank_id`,
          [current.id],
        )
        : { rows: [] };

      const dayResult = await client.query(
        `INSERT INTO station_day_inputs
           (client_id, station_id, business_date, cash_total, card_total, currency_code, entered_by, entered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (client_id, station_id, business_date)
         DO UPDATE SET cash_total = EXCLUDED.cash_total, card_total = EXCLUDED.card_total,
                       currency_code = EXCLUDED.currency_code,
                       entered_by = EXCLUDED.entered_by, entered_at = now()
         WHERE station_day_inputs.status = 'DRAFT'
         RETURNING id, business_date, cash_total, card_total, currency_code AS "currencyCode", status, entered_by, entered_at`,
        [station.client_id, stationId, businessDate, cashTotal, cardTotal, currencyCode, principal.userId],
      );
      const day = dayResult.rows[0];
      if (!day) throw new IdentityError(409, "This station-day input is validated and locked");
      await client.query("DELETE FROM station_day_dips WHERE day_input_id = $1", [day.id]);
      for (const dip of dips) {
        await client.query(
          `INSERT INTO station_day_dips
             (client_id, station_id, day_input_id, tank_id, product_depth_mm, water_depth_mm, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [station.client_id, stationId, day.id, dip.tankId, dip.productDepthMm, dip.waterDepthMm, principal.userId],
        );
      }
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'STATION_DAY_INPUTS_SAVED', 'station_day_inputs', $4, $5::jsonb)`,
        [station.client_id, stationId, principal.userId, day.id, JSON.stringify({
          businessDate,
          before: current ? {
            cashTotal: current.cash_total,
            cardTotal: current.card_total,
            currencyCode: current.currency_code,
            dips: previousDips.rows,
          } : null,
          after: { cashTotal, cardTotal, currencyCode, dips },
        })],
      );
      return { stationId, dayInputs: { ...day, dips } };
    });
    send(response, 200, result);
    return;
  }

  const validateDayInputsRoute = url.pathname.match(/^\/stations\/([^/]+)\/day-inputs\/([^/]+)\/validate$/);
  if (request.method === "POST" && validateDayInputsRoute) {
    const [, stationId, dateText] = validateDayInputsRoute;
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    requireRole(principal, new Set(["OWNER", "MANAGER", "CASHIER", "SUPER_ADMIN"]));
    const businessDate = requiredBusinessDate(dateText);
    const result = await withPrincipal(principal, async (client) => {
      const dayResult = await client.query(
        `SELECT id, client_id, station_id, status, currency_code FROM station_day_inputs
         WHERE station_id = $1 AND business_date = $2 FOR UPDATE`,
        [stationId, businessDate],
      );
      const day = dayResult.rows[0] as { id: string; client_id: string; station_id: string; status: string; currency_code: string | null } | undefined;
      if (!day) throw new IdentityError(404, "Station-day inputs not found");
      requireAccess(principal, { clientId: day.client_id, stationId });
      if (principal.clientId !== day.client_id) throw new IdentityError(403, "Select this client before validating daily inputs");
      if (day.status !== "DRAFT") throw new IdentityError(409, "These station-day inputs are already validated and locked");
      if (!day.currency_code) throw new IdentityError(409, "Set the daily cash/card currency before validating these inputs");

      const missingTanks = await client.query(
        `SELECT e.id FROM station_equipment e
         WHERE e.client_id = $1 AND e.station_id = $2 AND e.kind = 'TANK' AND e.retired_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM station_day_dips dip
             WHERE dip.day_input_id = $3 AND dip.tank_id = e.id
           )`,
        [day.client_id, stationId, day.id],
      );
      if (missingTanks.rowCount) throw new IdentityError(409, "Record a dip for every active tank before validating daily inputs");
      const updated = await client.query(
        `UPDATE station_day_inputs SET status = 'VALIDATED', validated_by = $2, validated_at = now()
         WHERE id = $1 RETURNING id, business_date, cash_total, card_total, currency_code AS "currencyCode", status, validated_by, validated_at`,
        [day.id, principal.userId],
      );
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'STATION_DAY_INPUTS_VALIDATED', 'station_day_inputs', $4, $5::jsonb)`,
        [day.client_id, stationId, principal.userId, day.id, JSON.stringify({ businessDate, currencyCode: day.currency_code })],
      );
      return { dayInputs: updated.rows[0] };
    });
    send(response, 200, result);
    return;
  }

  const stationReadingsRoute = url.pathname.match(/^\/stations\/([^/]+)\/readings$/);
  if (stationReadingsRoute && (request.method === "GET" || request.method === "POST")) {
    const stationId = stationReadingsRoute[1];
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    requireRole(principal, new Set(["OWNER", "MANAGER", "CASHIER", "SUPER_ADMIN"]));
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query(
        "SELECT id, client_id, meter_mode FROM stations WHERE id = $1",
        [stationId],
      );
      const station = stationResult.rows[0] as { id: string; client_id: string; meter_mode: string } | undefined;
      if (!station) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId: station.client_id, stationId });
      if (principal.clientId !== station.client_id) {
        throw new IdentityError(403, "Select this client before managing meter readings");
      }

      if (request.method === "GET") {
        const date = url.searchParams.get("date");
        const beforeDate = url.searchParams.get("before");
        if (date && beforeDate) throw new IdentityError(400, "Use either date or before, not both");
        if (beforeDate) {
          const before = requiredBusinessDate(beforeDate);
          const priorRows = await client.query(
            `SELECT e.id AS equipment_id, prior.batch_id, prior.business_date, prior.status,
                    prior.reading_id, prior.final_index, reset.new_initial_index AS reset_initial_index
             FROM station_equipment e
             LEFT JOIN LATERAL (
               SELECT b.id AS batch_id, b.business_date, b.status, r.id AS reading_id, r.final_index
               FROM meter_reading_batches b
               JOIN meter_readings r ON r.client_id = b.client_id AND r.station_id = b.station_id
                 AND r.batch_id = b.id AND r.equipment_id = e.id
               WHERE b.client_id = $1 AND b.station_id = $2 AND b.status = 'VALIDATED'
                 AND b.business_date < $3::date
               ORDER BY b.business_date DESC
               LIMIT 1
             ) prior ON true
             LEFT JOIN meter_resets reset ON reset.client_id = e.client_id AND reset.station_id = e.station_id
               AND reset.equipment_id = e.id AND reset.business_date = $3::date
             WHERE e.client_id = $1 AND e.station_id = $2
               AND e.kind IN ('NOZZLE', 'PUMP', 'METER') AND e.retired_at IS NULL
             ORDER BY e.code`,
            [station.client_id, stationId, before],
          );
          return { stationId, meterMode: station.meter_mode, readings: priorRows.rows };
        }
        const rows = await client.query(
          `SELECT b.id AS batch_id, b.business_date, b.status, b.submitted_by, b.submitted_at,
                  b.validated_by, b.validated_at, r.id AS reading_id, r.equipment_id,
                  e.code AS equipment_code, e.kind AS equipment_kind, r.initial_index,
                  r.final_index, r.volume,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'id', c.id, 'previousInitialIndex', c.previous_initial_index,
                      'previousFinalIndex', c.previous_final_index, 'previousVolume', c.previous_volume,
                      'correctedInitialIndex', c.corrected_initial_index,
                      'correctedFinalIndex', c.corrected_final_index,
                      'correctedVolume', c.corrected_volume, 'reason', c.reason,
                      'approvedBy', c.approved_by, 'occurredAt', c.occurred_at
                    ) ORDER BY c.occurred_at)
                    FROM meter_reading_corrections c WHERE c.reading_id = r.id
                  ), '[]'::jsonb) AS corrections,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'productId', a.product_id, 'productCode', p.code,
                      'productName', p.name, 'volume', a.volume
                    ) ORDER BY p.code)
                    FROM meter_reading_product_allocations a
                    JOIN products p ON p.client_id = a.client_id AND p.id = a.product_id
                    WHERE a.reading_id = r.id
                  ), '[]'::jsonb) AS product_allocations
           FROM meter_reading_batches b
           LEFT JOIN meter_readings r ON r.client_id = b.client_id
             AND r.station_id = b.station_id AND r.batch_id = b.id
           LEFT JOIN station_equipment e ON e.client_id = r.client_id
             AND e.station_id = r.station_id AND e.id = r.equipment_id
           WHERE b.client_id = $1 AND b.station_id = $2
             AND ($3::date IS NULL OR b.business_date = $3::date)
           ORDER BY b.business_date DESC, e.code NULLS LAST`,
          [station.client_id, stationId, date ? requiredBusinessDate(date) : null],
        );
        return { stationId, meterMode: station.meter_mode, readings: rows.rows };
      }

      const body = await readJson(request);
      const businessDate = requiredBusinessDate(body.businessDate);
      if (!Array.isArray(body.readings) || body.readings.length === 0 || body.readings.length > 100) {
        throw new IdentityError(400, "readings must contain between 1 and 100 meter entries");
      }
      const entries = body.readings.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new IdentityError(400, "Each reading must be an object");
        }
        const item = entry as JsonRecord;
        const equipmentId = requiredText(item.equipmentId, "equipment identifier", 36);
        if (!uuidPattern.test(equipmentId)) throw new IdentityError(400, "Invalid equipment identifier");
        if (item.productAllocations !== undefined && !Array.isArray(item.productAllocations)) {
          throw new IdentityError(400, "productAllocations must be an array");
        }
        const rawAllocations = (item.productAllocations ?? []) as unknown[];
        if (rawAllocations.length > 100) throw new IdentityError(400, "A reading may have at most 100 product allocations");
        const productAllocations = rawAllocations.map((allocation) => {
          if (!allocation || typeof allocation !== "object" || Array.isArray(allocation)) {
            throw new IdentityError(400, "Each product allocation must be an object");
          }
          const value = allocation as JsonRecord;
          const productId = requiredText(value.productId, "product identifier", 36);
          if (!uuidPattern.test(productId)) throw new IdentityError(400, "Invalid product identifier");
          return { productId, volume: requiredIndex(value.volume, "allocated product volume") };
        });
        if (new Set(productAllocations.map((allocation) => allocation.productId)).size !== productAllocations.length) {
          throw new IdentityError(400, "A product can appear only once in a meter allocation");
        }
        if (station.meter_mode === "NOZZLE" && productAllocations.length > 0) {
          throw new IdentityError(400, "Nozzle readings already identify their fuel product; do not send product allocations");
        }
        if (station.meter_mode === "PUMP_TOTALIZER" && productAllocations.length === 0) {
          throw new IdentityError(400, "Pump-totalizer readings require productAllocations to distribute volume by fuel");
        }
        return {
          equipmentId,
          initialIndex: requiredIndex(item.initialIndex, "initial index"),
          finalIndex: requiredIndex(item.finalIndex, "final index"),
          productAllocations,
        };
      });
      if (new Set(entries.map((entry) => entry.equipmentId)).size !== entries.length) {
        throw new IdentityError(400, "A meter can appear only once in a station-day batch");
      }

      for (const entry of entries) {
        const equipmentResult = await client.query(
          `SELECT kind FROM station_equipment
           WHERE client_id = $1 AND station_id = $2 AND id = $3 AND retired_at IS NULL`,
          [station.client_id, stationId, entry.equipmentId],
        );
        const kind = equipmentResult.rows[0]?.kind as string | undefined;
        const validKind = station.meter_mode === "NOZZLE"
          ? kind === "NOZZLE"
          : kind === "PUMP" || kind === "METER";
        if (!validKind) {
          throw new IdentityError(400, `Equipment ${entry.equipmentId} does not match this station's ${station.meter_mode} meter mode`);
        }
        for (const allocation of entry.productAllocations) {
          const assignedFuel = await client.query(
            `SELECT 1 FROM station_products sp
             JOIN products p ON p.client_id = sp.client_id AND p.id = sp.product_id
             WHERE sp.client_id = $1 AND sp.station_id = $2 AND sp.product_id = $3
               AND p.product_type = 'FUEL' AND p.is_active`,
            [station.client_id, stationId, allocation.productId],
          );
          if (!assignedFuel.rowCount) {
            throw new IdentityError(400, "Every meter product allocation must reference an active fuel assigned to this station");
          }
        }
      }

      const batchResult = await client.query(
        `INSERT INTO meter_reading_batches (client_id, station_id, business_date, submitted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_id, station_id, business_date)
         DO UPDATE SET submitted_by = EXCLUDED.submitted_by, submitted_at = now()
         WHERE meter_reading_batches.status = 'DRAFT'
         RETURNING id, business_date, status, submitted_at`,
        [station.client_id, stationId, businessDate, principal.userId],
      );
      const batch = batchResult.rows[0];
      if (!batch) throw new IdentityError(409, "This station-day reading batch is already validated and locked");
      await client.query("DELETE FROM meter_readings WHERE batch_id = $1", [batch.id]);
      const readings = [];
      for (const entry of entries) {
        const inserted = await client.query(
          `INSERT INTO meter_readings
             (client_id, station_id, batch_id, equipment_id, initial_index, final_index)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, equipment_id, initial_index, final_index, volume`,
          [station.client_id, stationId, batch.id, entry.equipmentId, entry.initialIndex, entry.finalIndex],
        );
        const reading = inserted.rows[0] as { id: string; equipment_id: string; initial_index: string; final_index: string; volume: string | null };
        for (const allocation of entry.productAllocations) {
          await client.query(
            `INSERT INTO meter_reading_product_allocations
               (client_id, station_id, reading_id, product_id, volume)
             VALUES ($1, $2, $3, $4, $5)`,
            [station.client_id, stationId, reading.id, allocation.productId, allocation.volume],
          );
        }
        readings.push({ ...reading, productAllocations: entry.productAllocations });
      }
      return { batch, readings };
    });
    send(response, request.method === "POST" ? 201 : 200, result);
    return;
  }

  const correctReadingRoute = url.pathname.match(/^\/stations\/([^/]+)\/readings\/([^/]+)$/);
  if (request.method === "PATCH" && correctReadingRoute) {
    const [, stationId, readingId] = correctReadingRoute;
    if (!uuidPattern.test(stationId) || !uuidPattern.test(readingId)) throw new IdentityError(404, "Meter reading not found");
    requireRole(principal, new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]));
    const body = await readJson(request);
    const initialIndex = requiredIndex(body.initialIndex, "initial index");
    const finalIndex = requiredIndex(body.finalIndex, "final index");
    const reason = requiredText(body.reason, "correction reason", 1000);
    if (Number(finalIndex) < Number(initialIndex)) {
      throw new IdentityError(400, "Final meter index cannot be lower than the initial index");
    }
    const correction = await withPrincipal(principal, async (client) => {
      const currentResult = await client.query(
        `SELECT r.id, r.client_id, r.station_id, r.equipment_id, r.initial_index, r.final_index,
                r.volume, b.business_date, b.status
         FROM meter_readings r JOIN meter_reading_batches b
           ON b.client_id = r.client_id AND b.station_id = r.station_id AND b.id = r.batch_id
         WHERE r.id = $1 AND r.station_id = $2 FOR UPDATE OF r, b`,
        [readingId, stationId],
      );
      const current = currentResult.rows[0] as {
        id: string; client_id: string; station_id: string; equipment_id: string;
        initial_index: string; final_index: string; volume: string | null; business_date: string; status: string;
      } | undefined;
      if (!current) throw new IdentityError(404, "Meter reading not found");
      requireAccess(principal, { clientId: current.client_id, stationId });
      if (principal.clientId !== current.client_id) {
        throw new IdentityError(403, "Select this client before correcting meter readings");
      }
      if (current.status !== "VALIDATED" || current.volume === null) {
        throw new IdentityError(409, "Only validated readings can be corrected");
      }
      const newer = await client.query(
        `SELECT 1 FROM meter_readings r JOIN meter_reading_batches b
           ON b.client_id = r.client_id AND b.station_id = r.station_id AND b.id = r.batch_id
         WHERE r.client_id = $1 AND r.station_id = $2 AND r.equipment_id = $3
           AND b.status = 'VALIDATED' AND b.business_date > $4::date LIMIT 1`,
        [current.client_id, stationId, current.equipment_id, current.business_date],
      );
      if (newer.rowCount) throw new IdentityError(409, "Correct the latest validated reading first");
      const previous = await client.query(
        `SELECT r.final_index FROM meter_readings r JOIN meter_reading_batches b
           ON b.client_id = r.client_id AND b.station_id = r.station_id AND b.id = r.batch_id
         WHERE r.client_id = $1 AND r.station_id = $2 AND r.equipment_id = $3
           AND b.status = 'VALIDATED' AND b.business_date < $4::date
         ORDER BY b.business_date DESC LIMIT 1`,
        [current.client_id, stationId, current.equipment_id, current.business_date],
      );
      if (previous.rows[0] && Number(initialIndex) < Number(previous.rows[0].final_index)) {
        throw new IdentityError(409, "Corrected initial index cannot be lower than the previous validated index");
      }
      const closingResult = await client.query(
        `SELECT id, snapshot FROM station_day_closings
         WHERE client_id = $1 AND station_id = $2 AND business_date = $3::date
         FOR UPDATE`,
        [current.client_id, stationId, current.business_date],
      );
      const updated = await client.query(
        `UPDATE meter_readings
         SET initial_index = $2, final_index = $3, volume = $3::numeric - $2::numeric
         WHERE id = $1
         RETURNING id, equipment_id, initial_index, final_index, volume`,
        [readingId, initialIndex, finalIndex],
      );
      const row = updated.rows[0];
      let closingAdjustmentNumber: number | null = null;
      await client.query(
        `INSERT INTO meter_reading_corrections
           (client_id, station_id, reading_id, previous_initial_index, previous_final_index,
            previous_volume, corrected_initial_index, corrected_final_index, corrected_volume,
            reason, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [current.client_id, stationId, readingId, current.initial_index, current.final_index,
          current.volume, row.initial_index, row.final_index, row.volume, reason, principal.userId],
      );
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, reason, details)
         VALUES ($1, $2, $3, 'METER_READING_CORRECTED', 'meter_reading', $4, $5, $6::jsonb)`,
        [current.client_id, stationId, principal.userId, readingId, reason, JSON.stringify({
          before: { initialIndex: current.initial_index, finalIndex: current.final_index, volume: current.volume },
          after: { initialIndex: row.initial_index, finalIndex: row.final_index, volume: row.volume },
        })],
      );
      const closing = closingResult.rows[0] as { id: string; snapshot: JsonRecord } | undefined;
      if (closing) {
        const sequence = await client.query(
          `SELECT COALESCE(max(adjustment_number), 0) + 1 AS next_number
           FROM station_day_closing_adjustments WHERE closing_id = $1`,
          [closing.id],
        );
        const adjustmentNumber = Number(sequence.rows[0].next_number);
        closingAdjustmentNumber = adjustmentNumber;
        await client.query(
          `INSERT INTO station_day_closing_adjustments
             (client_id, station_id, closing_id, adjustment_number, reason, before_snapshot, after_snapshot, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
          [current.client_id, stationId, closing.id, adjustmentNumber, reason,
            JSON.stringify({ type: "METER_READING", readingId, initialIndex: current.initial_index,
              finalIndex: current.final_index, volume: current.volume }),
            JSON.stringify({ type: "METER_READING", readingId, initialIndex: row.initial_index,
              finalIndex: row.final_index, volume: row.volume }), principal.userId],
        );
        await client.query(
          `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, reason, details)
           VALUES ($1, $2, $3, 'STATION_DAY_CLOSING_METER_ADJUSTED', 'station_day_closing', $4, $5, $6::jsonb)`,
          [current.client_id, stationId, principal.userId, closing.id, reason, JSON.stringify({
            adjustmentNumber, readingId,
            before: { initialIndex: current.initial_index, finalIndex: current.final_index, volume: current.volume },
            after: { initialIndex: row.initial_index, finalIndex: row.final_index, volume: row.volume },
          })],
        );
      }
      return {
        reading: row,
        reason,
        approvedBy: principal.userId,
        closingAdjustmentNumber,
      };
    });
    send(response, 200, correction);
    return;
  }

  const meterResetsRoute = url.pathname.match(/^\/stations\/([^/]+)\/equipment\/([^/]+)\/meter-resets$/);
  if (meterResetsRoute && (request.method === "GET" || request.method === "POST")) {
    const [, stationId, equipmentId] = meterResetsRoute;
    if (!uuidPattern.test(stationId) || !uuidPattern.test(equipmentId)) throw new IdentityError(404, "Meter not found");
    requireRole(principal, request.method === "GET"
      ? new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"])
      : new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]));
    const result = await withPrincipal(principal, async (client) => {
      const equipmentResult = await client.query(
        `SELECT e.client_id, e.kind, e.serial_number
         FROM station_equipment e WHERE e.client_id = $1 AND e.station_id = $2 AND e.id = $3
           AND e.kind IN ('NOZZLE', 'PUMP', 'METER')`,
        [principal.clientId, stationId, equipmentId],
      );
      const equipment = equipmentResult.rows[0] as {
        client_id: string; kind: string; serial_number: string | null;
      } | undefined;
      if (!equipment) throw new IdentityError(404, "Meter equipment not found");
      requireAccess(principal, { clientId: equipment.client_id, stationId });
      if (principal.clientId !== equipment.client_id) {
        throw new IdentityError(403, "Select this client before managing meter resets");
      }

      if (request.method === "GET") {
        const resets = await client.query(
          `SELECT id, business_date, previous_index, new_initial_index,
                  previous_serial_number, new_serial_number, reason, recorded_by, recorded_at
           FROM meter_resets WHERE client_id = $1 AND station_id = $2 AND equipment_id = $3
           ORDER BY business_date DESC`,
          [equipment.client_id, stationId, equipmentId],
        );
        return { stationId, equipmentId, resets: resets.rows };
      }

      const body = await readJson(request);
      const businessDate = requiredBusinessDate(body.businessDate);
      const previousIndex = requiredIndex(body.previousIndex, "previous meter index");
      const newInitialIndex = requiredIndex(body.newInitialIndex, "new initial meter index");
      const reason = requiredText(body.reason, "meter reset reason", 1000);
      const previousSerialNumber = body.previousSerialNumber == null ? equipment.serial_number
        : requiredText(body.previousSerialNumber, "previous serial number", 120);
      const newSerialNumber = body.newSerialNumber == null ? null
        : requiredText(body.newSerialNumber, "new serial number", 120);
      const previous = await client.query(
        `SELECT r.final_index FROM meter_reading_batches b
         JOIN meter_readings r ON r.client_id = b.client_id AND r.station_id = b.station_id AND r.batch_id = b.id
         WHERE b.client_id = $1 AND b.station_id = $2 AND r.equipment_id = $3
           AND b.status = 'VALIDATED' AND b.business_date < $4::date
         ORDER BY b.business_date DESC LIMIT 1`,
        [equipment.client_id, stationId, equipmentId, businessDate],
      );
      if (!previous.rows[0]) throw new IdentityError(409, "A meter reset requires a previous validated meter index");
      if (indexThousandths(previousIndex) !== indexThousandths(previous.rows[0].final_index)) {
        throw new IdentityError(409, "previousIndex must match the latest validated meter index");
      }
      const inserted = await client.query(
        `INSERT INTO meter_resets
           (client_id, station_id, equipment_id, business_date, previous_index, new_initial_index,
            previous_serial_number, new_serial_number, reason, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, business_date, previous_index, new_initial_index,
           previous_serial_number, new_serial_number, reason, recorded_by, recorded_at`,
        [equipment.client_id, stationId, equipmentId, businessDate, previousIndex, newInitialIndex,
          previousSerialNumber, newSerialNumber, reason, principal.userId],
      );
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'METER_RESET_RECORDED', 'meter_resets', $4, $5::jsonb)`,
        [equipment.client_id, stationId, principal.userId, inserted.rows[0].id,
          JSON.stringify(inserted.rows[0])],
      );
      return { meterReset: inserted.rows[0] };
    });
    send(response, request.method === "POST" ? 201 : 200, result);
    return;
  }

  const validateReadingsRoute = url.pathname.match(/^\/stations\/([^/]+)\/readings\/([^/]+)\/validate$/);
  if (request.method === "POST" && validateReadingsRoute) {
    const [, stationId, batchId] = validateReadingsRoute;
    if (!uuidPattern.test(stationId) || !uuidPattern.test(batchId)) throw new IdentityError(404, "Reading batch not found");
    requireRole(principal, new Set(["OWNER", "MANAGER", "CASHIER", "SUPER_ADMIN"]));
    const result = await withPrincipal(principal, async (client) => {
      const batchResult = await client.query(
        `SELECT b.id, b.client_id, b.station_id, b.business_date, b.status, s.meter_mode
         FROM meter_reading_batches b JOIN stations s
           ON s.client_id = b.client_id AND s.id = b.station_id
         WHERE b.id = $1 AND b.station_id = $2 FOR UPDATE OF b`,
        [batchId, stationId],
      );
      const batch = batchResult.rows[0] as {
        id: string; client_id: string; station_id: string; business_date: string; status: string; meter_mode: string;
      } | undefined;
      if (!batch) throw new IdentityError(404, "Reading batch not found");
      requireAccess(principal, { clientId: batch.client_id, stationId });
      if (principal.clientId !== batch.client_id) {
        throw new IdentityError(403, "Select this client before validating meter readings");
      }
      if (batch.status !== "DRAFT") throw new IdentityError(409, "This reading batch is already validated and locked");

      const readingsResult = await client.query(
        `SELECT r.id, r.equipment_id, r.initial_index, r.final_index, e.kind, e.product_id,
                COALESCE((SELECT sum(a.volume) FROM meter_reading_product_allocations a
                          WHERE a.reading_id = r.id), 0)::numeric(14,3)::text AS allocated_volume,
                (SELECT count(*)::int FROM meter_reading_product_allocations a
                 WHERE a.reading_id = r.id) AS allocation_count
         FROM meter_readings r JOIN station_equipment e
           ON e.client_id = r.client_id AND e.station_id = r.station_id AND e.id = r.equipment_id
         WHERE r.batch_id = $1 AND r.client_id = $2 AND r.station_id = $3
         ORDER BY r.id FOR UPDATE OF r`,
        [batch.id, batch.client_id, stationId],
      );
      if (readingsResult.rows.length === 0) throw new IdentityError(409, "An empty reading batch cannot be validated");

      for (const reading of readingsResult.rows as Array<{
        id: string; equipment_id: string; initial_index: string; final_index: string; kind: string;
        product_id: string | null; allocated_volume: string; allocation_count: number;
      }>) {
        const validKind = batch.meter_mode === "NOZZLE"
          ? reading.kind === "NOZZLE"
          : reading.kind === "PUMP" || reading.kind === "METER";
        if (!validKind) throw new IdentityError(409, "The batch no longer matches the station meter mode");
        if (indexThousandths(reading.final_index) < indexThousandths(reading.initial_index)) {
          throw new IdentityError(409, "Final meter index cannot be lower than the initial index");
        }
        const meterVolume = indexThousandths(reading.final_index) - indexThousandths(reading.initial_index);
        if (batch.meter_mode === "NOZZLE") {
          if (!reading.product_id || reading.allocation_count > 0) {
            throw new IdentityError(409, "Nozzle readings must identify one fuel product and cannot have manual allocations");
          }
        } else {
          if (reading.allocation_count === 0) {
            throw new IdentityError(409, "Pump-totalizer readings require product allocations before validation");
          }
          const allocationTotal = indexThousandths(reading.allocated_volume);
          if (allocationTotal !== meterVolume) {
            throw new IdentityError(409, "Product allocations must add up exactly to the pump-totalizer volume");
          }
        }
        const previous = await client.query(
          `SELECT r.final_index FROM meter_reading_batches b
           JOIN meter_readings r ON r.batch_id = b.id AND r.equipment_id = $1
           WHERE b.client_id = $2 AND b.station_id = $3 AND b.status = 'VALIDATED'
             AND b.business_date < $4::date
           ORDER BY b.business_date DESC LIMIT 1`,
          [reading.equipment_id, batch.client_id, stationId, batch.business_date],
        );
        const resetResult = await client.query(
          `SELECT previous_index, new_initial_index FROM meter_resets
           WHERE client_id = $1 AND station_id = $2 AND equipment_id = $3 AND business_date = $4`,
          [batch.client_id, stationId, reading.equipment_id, batch.business_date],
        );
        const reset = resetResult.rows[0] as { previous_index: string; new_initial_index: string } | undefined;
        if (reset) {
          if (!previous.rows[0]
            || indexThousandths(reset.previous_index) !== indexThousandths(previous.rows[0].final_index)
            || indexThousandths(reset.new_initial_index) !== indexThousandths(reading.initial_index)) {
            throw new IdentityError(409, "Meter reset does not match the latest validated index and this reading's initial index");
          }
        } else if (previous.rows[0]
          && indexThousandths(reading.initial_index) < indexThousandths(previous.rows[0].final_index)) {
          throw new IdentityError(409, "Initial meter index is lower than the previous validated index; record an authorized meter reset first");
        }
        await client.query(
          `UPDATE meter_readings SET volume = final_index - initial_index WHERE id = $1`,
          [reading.id],
        );
      }

      await client.query(
        `UPDATE meter_reading_batches
         SET status = 'VALIDATED', validated_by = $2, validated_at = now()
         WHERE id = $1`,
        [batch.id, principal.userId],
      );
      const updated = await client.query(
        `SELECT b.id AS batch_id, b.business_date, b.status, b.validated_by, b.validated_at,
                r.id AS reading_id, r.equipment_id, r.initial_index, r.final_index, r.volume
         FROM meter_reading_batches b JOIN meter_readings r
           ON r.client_id = b.client_id AND r.station_id = b.station_id AND r.batch_id = b.id
         WHERE b.id = $1 ORDER BY r.equipment_id`,
        [batch.id],
      );
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'METER_READINGS_VALIDATED', 'meter_reading_batch', $4, $5::jsonb)`,
        [batch.client_id, stationId, principal.userId, batch.id, JSON.stringify({ businessDate: batch.business_date, count: readingsResult.rows.length })],
      );
      return { readings: updated.rows };
    });
    send(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/clients") {
    const rows = await withPrincipal(principal, async (client) => {
      const result = await client.query("SELECT id, name, code, created_at FROM clients ORDER BY name");
      return result.rows;
    });
    send(response, 200, { clients: rows });
    return;
  }

  if (request.method === "POST" && url.pathname === "/clients") {
    requireRole(principal, new Set(["SUPER_ADMIN"]));
    const body = await readJson(request);
    const name = requiredText(body.name, "client name");
    const code = requiredText(body.code, "client code", 32).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code)) throw new IdentityError(400, "Invalid client code");
    const created = await withPrincipal(principal, async (client) => {
      const result = await client.query(
        "INSERT INTO clients (name, code) VALUES ($1, $2) RETURNING id, name, code, created_at",
        [name, code],
      );
      const row = result.rows[0];
      await client.query(
        "INSERT INTO audit_events (actor_id, action, entity_type, entity_id) VALUES ($1, $2, $3, $4)",
        [principal.userId, "CLIENT_CREATED", "client", row.id],
      );
      return row;
    });
    send(response, 201, { client: created });
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/users") {
    requireRole(principal, new Set(["SUPER_ADMIN"]));
    const body = await readJson(request);
    const authSubject = requiredText(body.authSubject, "authentication subject", 255);
    const email = requiredText(body.email, "email", 320).toLowerCase();
    const displayName = requiredText(body.displayName, "display name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new IdentityError(400, "Invalid email");

    const created = await withPrincipal(principal, async (client) => {
      const result = await client.query(
        `INSERT INTO app_users (auth_subject, email, display_name)
         VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at`,
        [authSubject, email, displayName],
      );
      const row = result.rows[0];
      await client.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id)
         VALUES ($1, $2, $3, $4)`,
        [principal.userId, "USER_CREATED", "user", row.id],
      );
      return row;
    });
    send(response, 201, { user: created });
    return;
  }

  if (request.method === "GET" && url.pathname === "/stations") {
    const rows = await withPrincipal(principal, async (client) => {
      const result = await client.query(
        "SELECT id, client_id, code, name, meter_mode, closing_cutoff::text, time_zone, closing_day_rule FROM stations ORDER BY name",
      );
      return result.rows;
    });
    send(response, 200, { stations: rows });
    return;
  }

  const clientProductsRoute = url.pathname.match(/^\/clients\/([^/]+)\/products$/);
  if ((request.method === "GET" || request.method === "POST") && clientProductsRoute) {
    const clientId = clientProductsRoute[1];
    if (!uuidPattern.test(clientId)) throw new IdentityError(404, "Client not found");
    requireAccess(principal, { clientId });
    if (principal.clientId !== clientId) throw new IdentityError(403, "Select this client before managing its products");

    if (request.method === "GET") {
      const rows = await withPrincipal(principal, async (client) => {
        const result = await client.query(
          `SELECT id, client_id, code, name, product_type, unit_code, is_active, created_at, updated_at
           FROM products WHERE client_id = $1 ORDER BY name, code`,
          [clientId],
        );
        return result.rows;
      });
      send(response, 200, { products: rows });
      return;
    }

    requireRole(principal, membershipManagers);
    const body = await readJson(request);
    const code = requiredText(body.code, "product code", 32).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code)) throw new IdentityError(400, "Invalid product code");
    const name = requiredText(body.name, "product name");
    const productType = requiredText(body.productType, "product type", 12).toUpperCase();
    if (!["FUEL", "ARTICLE", "SERVICE"].includes(productType)) {
      throw new IdentityError(400, "productType must be FUEL, ARTICLE, or SERVICE");
    }
    const unitCode = requiredText(body.unitCode, "unit code", 16).toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(unitCode)) throw new IdentityError(400, "Invalid unit code");

    const product = await withPrincipal(principal, async (client) => {
      const result = await client.query(
        `INSERT INTO products (client_id, code, name, product_type, unit_code)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, client_id, code, name, product_type, unit_code, is_active, created_at, updated_at`,
        [clientId, code, name, productType, unitCode],
      );
      const row = result.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'PRODUCT_CREATED', 'product', $3, $4::jsonb)`,
        [clientId, principal.userId, row.id, JSON.stringify({ code, name, productType, unitCode })],
      );
      return row;
    });
    send(response, 201, { product });
    return;
  }

  const stationProductsRoute = url.pathname.match(/^\/stations\/([^/]+)\/products(?:\/([^/]+))?$/);
  if (stationProductsRoute && (
    request.method === "GET" && stationProductsRoute[2] === undefined
    || request.method === "PUT" && stationProductsRoute[2] !== undefined
  )) {
    const [, stationId, productId] = stationProductsRoute;
    if (!uuidPattern.test(stationId) || (productId && !uuidPattern.test(productId))) {
      throw new IdentityError(404, "Station or product not found");
    }
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query("SELECT client_id FROM stations WHERE id = $1", [stationId]);
      const clientId = stationResult.rows[0]?.client_id as string | undefined;
      if (!clientId) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId, stationId });
      if (principal.clientId !== clientId) throw new IdentityError(403, "Select this client before managing station products");

      if (request.method === "GET") {
        const rows = await client.query(
          `SELECT p.id, p.code, p.name, p.product_type, p.unit_code, p.is_active, sp.assigned_at
           FROM station_products sp JOIN products p
             ON p.client_id = sp.client_id AND p.id = sp.product_id
           WHERE sp.client_id = $1 AND sp.station_id = $2 ORDER BY p.name, p.code`,
          [clientId, stationId],
        );
        return { clientId, products: rows.rows };
      }

      requireRole(principal, membershipManagers);
      const assignment = await client.query(
        `INSERT INTO station_products (client_id, station_id, product_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING product_id, assigned_at`,
        [clientId, stationId, productId],
      );
      if (assignment.rowCount) {
        await client.query(
          `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
           VALUES ($1, $2, $3, 'STATION_PRODUCT_ASSIGNED', 'product', $4, '{}'::jsonb)`,
          [clientId, stationId, principal.userId, productId],
        );
      }
      return { clientId, assigned: true, productId };
    });
    send(response, 200, result);
    return;
  }

  const stationTariffsRoute = url.pathname.match(/^\/stations\/([^/]+)\/tariffs$/);
  if (stationTariffsRoute && (request.method === "GET" || request.method === "POST")) {
    const stationId = stationTariffsRoute[1];
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query("SELECT client_id FROM stations WHERE id = $1", [stationId]);
      const clientId = stationResult.rows[0]?.client_id as string | undefined;
      if (!clientId) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId, stationId });
      if (principal.clientId !== clientId) throw new IdentityError(403, "Select this client before managing tariffs");

      if (request.method === "GET") {
        const tariffs = await client.query(
          `SELECT id, product_id, unit_price::text, valid_from, valid_until, created_at
           FROM fuel_tariffs WHERE client_id = $1 AND station_id = $2
           ORDER BY product_id, valid_from DESC`,
          [clientId, stationId],
        );
        return { tariffs: tariffs.rows };
      }

      requireRole(principal, membershipManagers);
      const body = await readJson(request);
      const productId = requiredText(body.productId, "product identifier", 36);
      if (!uuidPattern.test(productId)) throw new IdentityError(400, "Invalid product identifier");
      const unitPrice = requiredDecimal(body.unitPrice, "unit price");
      const validFrom = requiredTimestamp(body.validFrom, "validFrom");
      const validUntil = body.validUntil === undefined || body.validUntil === null
        ? null
        : requiredTimestamp(body.validUntil, "validUntil");
      if (validUntil !== null && Date.parse(validUntil) <= Date.parse(validFrom)) {
        throw new IdentityError(400, "validUntil must be later than validFrom");
      }
      const created = await client.query(
        `INSERT INTO fuel_tariffs
           (client_id, station_id, product_id, unit_price, valid_from, valid_until, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, product_id, unit_price::text, valid_from, valid_until, created_at`,
        [clientId, stationId, productId, unitPrice, validFrom, validUntil, principal.userId],
      );
      const tariff = created.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'FUEL_TARIFF_CREATED', 'fuel_tariff', $4, $5::jsonb)`,
        [clientId, stationId, principal.userId, tariff.id, JSON.stringify({ productId, unitPrice, validFrom, validUntil })],
      );
      return { tariff };
    });
    send(response, request.method === "POST" ? 201 : 200, result);
    return;
  }

  const stationEquipmentRoute = url.pathname.match(/^\/stations\/([^/]+)\/equipment$/);
  if (stationEquipmentRoute && (request.method === "GET" || request.method === "POST")) {
    const stationId = stationEquipmentRoute[1];
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query("SELECT client_id FROM stations WHERE id = $1", [stationId]);
      const clientId = stationResult.rows[0]?.client_id as string | undefined;
      if (!clientId) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId, stationId });
      if (principal.clientId !== clientId) throw new IdentityError(403, "Select this client before managing equipment");

      if (request.method === "GET") {
        const equipment = await client.query(
          `SELECT id, code, kind, serial_number, parent_equipment_id, product_id, installed_at, retired_at, created_at
           FROM station_equipment WHERE client_id = $1 AND station_id = $2 ORDER BY kind, code`,
          [clientId, stationId],
        );
        return { equipment: equipment.rows };
      }

      requireRole(principal, membershipManagers);
      const body = await readJson(request);
      const code = requiredText(body.code, "equipment code", 40);
      const kind = requiredText(body.kind, "equipment kind", 12).toUpperCase();
      if (!["PUMP", "METER", "NOZZLE", "TANK"].includes(kind)) {
        throw new IdentityError(400, "kind must be PUMP, METER, NOZZLE, or TANK");
      }
      const serialNumber = body.serialNumber === undefined || body.serialNumber === null
        ? null
        : requiredText(body.serialNumber, "serial number", 120);
      const parentEquipmentId = body.parentEquipmentId === undefined || body.parentEquipmentId === null
        ? null
        : requiredText(body.parentEquipmentId, "parent equipment identifier", 36);
      const productId = body.productId === undefined || body.productId === null
        ? null
        : requiredText(body.productId, "product identifier", 36);
      if (parentEquipmentId && !uuidPattern.test(parentEquipmentId)) throw new IdentityError(400, "Invalid parent equipment identifier");
      if (productId && !uuidPattern.test(productId)) throw new IdentityError(400, "Invalid product identifier");
      if ((kind === "NOZZLE" || kind === "TANK") && !productId) {
        throw new IdentityError(400, "Nozzles and tanks require a fuel product");
      }
      if (kind === "TANK" && parentEquipmentId) throw new IdentityError(400, "Tanks cannot have a parent equipment");
      if (kind === "PUMP" && parentEquipmentId) throw new IdentityError(400, "Pumps cannot have a parent equipment");
      if (kind === "NOZZLE" && !parentEquipmentId) throw new IdentityError(400, "Nozzles require their parent pump");
      if ((kind === "PUMP" || kind === "METER") && productId) {
        throw new IdentityError(400, "Only nozzles and tanks can be assigned a fuel product");
      }
      const installedAt = body.installedAt === undefined ? null : requiredTimestamp(body.installedAt, "installedAt");
      const inserted = await client.query(
        `INSERT INTO station_equipment
           (client_id, station_id, code, kind, serial_number, parent_equipment_id, product_id, installed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
         RETURNING id, code, kind, serial_number, parent_equipment_id, product_id, installed_at, retired_at, created_at`,
        [clientId, stationId, code, kind, serialNumber, parentEquipmentId, productId, installedAt],
      );
      const equipment = inserted.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'EQUIPMENT_CREATED', 'station_equipment', $4, $5::jsonb)`,
        [clientId, stationId, principal.userId, equipment.id, JSON.stringify(equipment)],
      );
      return { equipment };
    });
    send(response, request.method === "POST" ? 201 : 200, result);
    return;
  }

  const nozzleTankRoute = url.pathname.match(/^\/stations\/([^/]+)\/equipment\/([^/]+)\/tank-assignments$/);
  if (nozzleTankRoute && (request.method === "GET" || request.method === "POST")) {
    const [, stationId, nozzleId] = nozzleTankRoute;
    if (!uuidPattern.test(stationId) || !uuidPattern.test(nozzleId)) {
      throw new IdentityError(404, "Station or nozzle not found");
    }
    const result = await withPrincipal(principal, async (client) => {
      const stationResult = await client.query("SELECT client_id FROM stations WHERE id = $1", [stationId]);
      const clientId = stationResult.rows[0]?.client_id as string | undefined;
      if (!clientId) throw new IdentityError(404, "Station not found");
      requireAccess(principal, { clientId, stationId });
      if (principal.clientId !== clientId) throw new IdentityError(403, "Select this client before managing tank assignments");

      if (request.method === "GET") {
        const assignments = await client.query(
          `SELECT a.id, a.nozzle_id, a.tank_id, a.valid_from, a.valid_until,
                  a.recorded_by, a.recorded_at
           FROM nozzle_tank_assignments a
           WHERE a.client_id = $1 AND a.station_id = $2 AND a.nozzle_id = $3
           ORDER BY a.valid_from DESC`,
          [clientId, stationId, nozzleId],
        );
        return { assignments: assignments.rows };
      }

      requireRole(principal, membershipManagers);
      const body = await readJson(request);
      const tankId = requiredText(body.tankId, "tank identifier", 36);
      if (!uuidPattern.test(tankId)) throw new IdentityError(400, "Invalid tank identifier");
      const validFrom = body.validFrom === undefined ? new Date().toISOString() : requiredTimestamp(body.validFrom, "validFrom");
      const inserted = await client.query(
        `WITH current_assignment AS (
           UPDATE nozzle_tank_assignments
           SET valid_until = $4
           WHERE client_id = $1 AND station_id = $2 AND nozzle_id = $3
             AND valid_until IS NULL AND valid_from < $4
           RETURNING id
         )
         INSERT INTO nozzle_tank_assignments
           (client_id, station_id, nozzle_id, tank_id, valid_from, recorded_by)
         VALUES ($1, $2, $3, $5, $4, $6)
         RETURNING id, nozzle_id, tank_id, valid_from, valid_until, recorded_by, recorded_at`,
        [clientId, stationId, nozzleId, validFrom, tankId, principal.userId],
      );
      const assignment = inserted.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'NOZZLE_TANK_ASSIGNED', 'nozzle_tank_assignment', $4, $5::jsonb)`,
        [clientId, stationId, principal.userId, assignment.id, JSON.stringify({ nozzleId, tankId, validFrom })],
      );
      return { assignment };
    });
    send(response, request.method === "POST" ? 201 : 200, result);
    return;
  }

  const stationCollection = url.pathname.match(/^\/clients\/([^/]+)\/stations$/);
  if (request.method === "POST" && stationCollection) {
    const clientId = stationCollection[1];
    if (!uuidPattern.test(clientId)) throw new IdentityError(404, "Client not found");
    requireRole(principal, stationRoles);
    requireAccess(principal, { clientId });
    if (principal.clientId !== clientId) throw new IdentityError(403, "Select this client before changing its stations");

    const body = await readJson(request);
    const code = requiredText(body.code, "station code");
    const name = requiredText(body.name, "station name");
    const { meterMode, closingCutoff, timeZone, closingDayRule } = stationSettings(body);

    const created = await withPrincipal(principal, async (client) => {
      const result = await client.query(
        `INSERT INTO stations (client_id, code, name, meter_mode, closing_cutoff, time_zone, closing_day_rule)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, client_id, code, name, meter_mode, closing_cutoff::text, time_zone, closing_day_rule`,
        [clientId, code, name, meterMode, closingCutoff, timeZone, closingDayRule ?? null],
      );
      const row = result.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [clientId, row.id, principal.userId, "STATION_CREATED", "station", row.id],
      );
      return row;
    });
    send(response, 201, { station: created });
    return;
  }

  const stationSettingsRoute = url.pathname.match(/^\/stations\/([^/]+)\/settings$/);
  if (request.method === "PATCH" && stationSettingsRoute) {
    const stationId = stationSettingsRoute[1];
    if (!uuidPattern.test(stationId)) throw new IdentityError(404, "Station not found");
    requireRole(principal, stationRoles);
    const clientId = requiredText(request.headers["x-client-id"], "client selection", 36);
    if (!uuidPattern.test(clientId)) throw new IdentityError(400, "Invalid client identifier");
    requireAccess(principal, { clientId, stationId });
    if (principal.clientId !== clientId) {
      throw new IdentityError(403, "Select this client before changing its station settings");
    }

    const body = await readJson(request);
    const settings = stationSettings(body);
    const updated = await withPrincipal(principal, async (client) => {
      const current = await client.query(
        `SELECT id, client_id, code, name, meter_mode, closing_cutoff::text, time_zone, closing_day_rule
         FROM stations WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [stationId, clientId],
      );
      const old = current.rows[0];
      if (!old) throw new IdentityError(404, "Station not found");

      const result = await client.query(
        `UPDATE stations
         SET meter_mode = $3, closing_cutoff = $4, time_zone = $5,
             closing_day_rule = CASE WHEN $6::boolean THEN $7::text ELSE closing_day_rule END,
             updated_at = now()
         WHERE id = $1 AND client_id = $2
         RETURNING id, client_id, code, name, meter_mode, closing_cutoff::text, time_zone, closing_day_rule`,
        [stationId, clientId, settings.meterMode, settings.closingCutoff, settings.timeZone,
          settings.closingDayRule !== undefined, settings.closingDayRule ?? null],
      );
      const station = result.rows[0];
      await client.query(
        `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, 'STATION_SETTINGS_UPDATED', 'station', $2, $4::jsonb)`,
        [clientId, stationId, principal.userId, JSON.stringify({ before: old, after: station })],
      );
      return station;
    });
    send(response, 200, { station: updated });
    return;
  }

  const membershipCollection = url.pathname.match(/^\/clients\/([^/]+)\/memberships$/);
  if ((request.method === "GET" || request.method === "POST") && membershipCollection) {
    const clientId = membershipCollection[1];
    if (!uuidPattern.test(clientId)) throw new IdentityError(404, "Client not found");
    requireRole(principal, membershipManagers);
    requireAccess(principal, { clientId });
    if (principal.clientId !== clientId) throw new IdentityError(403, "Select this client before managing memberships");

    if (request.method === "GET") {
      const rows = await withPrincipal(principal, async (client) => {
        const result = await client.query(
          `SELECT u.id AS user_id, u.email, u.display_name, m.role,
                  COALESCE(array_agg(sm.station_id ORDER BY sm.station_id)
                    FILTER (WHERE sm.station_id IS NOT NULL), ARRAY[]::uuid[]) AS station_ids
           FROM client_memberships m
           JOIN app_users u ON u.id = m.user_id
           LEFT JOIN station_memberships sm
             ON sm.client_id = m.client_id AND sm.user_id = m.user_id
           WHERE m.client_id = $1
           GROUP BY u.id, u.email, u.display_name, m.role
           ORDER BY u.display_name, u.email`,
          [clientId],
        );
        return result.rows;
      });
      send(response, 200, { memberships: rows });
      return;
    }

    const body = await readJson(request);
    const userId = requiredText(body.userId, "user identifier", 36);
    if (!uuidPattern.test(userId)) throw new IdentityError(400, "Invalid user identifier");
    const role = clientRole(body.role);
    if (role === "OWNER" && principal.role === "MANAGER") {
      throw new IdentityError(403, "Only an owner or super-admin can assign the owner role");
    }
    const stationIds = stationIdList(body.stationIds) ?? [];

    const created = await withPrincipal(principal, async (client) => {
      await validateStations(client, clientId, stationIds);
      await client.query(
        "INSERT INTO client_memberships (client_id, user_id, role) VALUES ($1, $2, $3)",
        [clientId, userId, role],
      );
      for (const stationId of new Set(stationIds as string[])) {
        await client.query(
          "INSERT INTO station_memberships (client_id, station_id, user_id) VALUES ($1, $2, $3)",
          [clientId, stationId, userId],
        );
      }
      await client.query(
        `INSERT INTO audit_events (client_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [clientId, principal.userId, "MEMBERSHIP_CREATED", "client_membership", userId, JSON.stringify({ role, stationIds })],
      );
      return { clientId, userId, role, stationIds };
    });
    send(response, 201, { membership: created });
    return;
  }

  const membershipItem = url.pathname.match(/^\/clients\/([^/]+)\/memberships\/([^/]+)$/);
  if (request.method === "PATCH" && membershipItem) {
    const [, clientId, userId] = membershipItem;
    if (!uuidPattern.test(clientId) || !uuidPattern.test(userId)) {
      throw new IdentityError(404, "Membership not found");
    }
    requireRole(principal, membershipManagers);
    requireAccess(principal, { clientId });
    if (principal.clientId !== clientId) {
      throw new IdentityError(403, "Select this client before managing memberships");
    }

    const body = await readJson(request);
    const requestedRole = body.role === undefined ? undefined : clientRole(body.role);
    const requestedStationIds = stationIdList(body.stationIds, true);
    if (requestedRole === undefined && requestedStationIds === undefined) {
      throw new IdentityError(400, "Provide role or stationIds to update");
    }
    if (requestedRole === "OWNER" && principal.role === "MANAGER") {
      throw new IdentityError(403, "Only an owner or super-admin can assign the owner role");
    }

    const updated = await withPrincipal(principal, async (client) => {
      const currentResult = await client.query(
        "SELECT role FROM client_memberships WHERE client_id = $1 AND user_id = $2 FOR UPDATE",
        [clientId, userId],
      );
      const current = currentResult.rows[0] as { role: string } | undefined;
      if (!current) throw new IdentityError(404, "Membership not found");

      const stationResult = await client.query(
        `SELECT station_id FROM station_memberships
         WHERE client_id = $1 AND user_id = $2 ORDER BY station_id`,
        [clientId, userId],
      );
      const beforeStationIds = stationResult.rows.map((row: { station_id: string }) => row.station_id);
      const nextRole = requestedRole ?? current.role;
      const nextStationIds = requestedStationIds ?? beforeStationIds;
      if (requestedStationIds !== undefined) await validateStations(client, clientId, nextStationIds);

      if (current.role === "OWNER" && nextRole !== "OWNER") {
        const owners = await client.query(
          "SELECT user_id FROM client_memberships WHERE client_id = $1 AND role = 'OWNER' FOR UPDATE",
          [clientId],
        );
        if (owners.rowCount !== null && owners.rowCount <= 1) {
          throw new IdentityError(409, "A client must keep at least one owner");
        }
      }

      if (nextRole !== current.role) {
        await client.query(
          "UPDATE client_memberships SET role = $3 WHERE client_id = $1 AND user_id = $2",
          [clientId, userId, nextRole],
        );
      }
      if (requestedStationIds !== undefined) {
        await client.query(
          `DELETE FROM station_memberships
           WHERE client_id = $1 AND user_id = $2
             AND NOT (station_id = ANY($3::uuid[]))`,
          [clientId, userId, nextStationIds],
        );
        await client.query(
          `INSERT INTO station_memberships (client_id, station_id, user_id)
           SELECT $1, requested.station_id, $2
           FROM unnest($3::uuid[]) AS requested(station_id)
           ON CONFLICT (station_id, user_id) DO NOTHING`,
          [clientId, userId, nextStationIds],
        );
      }

      await client.query(
        `INSERT INTO audit_events (client_id, actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'MEMBERSHIP_UPDATED', 'client_membership', $3, $4::jsonb)`,
        [clientId, principal.userId, userId, JSON.stringify({
          before: { role: current.role, stationIds: beforeStationIds },
          after: { role: nextRole, stationIds: nextStationIds },
        })],
      );
      return { clientId, userId, role: nextRole, stationIds: nextStationIds };
    });
    send(response, 200, { membership: updated });
    return;
  }

  send(response, 404, { error: "not_found" });
}

export const server = createServer((request, response) => {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  response.setHeader("x-request-id", requestId);
  response.once("finish", () => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const route = path === "/health" ? "health"
      : path === "/admin/platform" || path.startsWith("/app/") || path === "/app" ? "ui"
        : ["/login", "/logout", "/auth/callback", "/me"].includes(path) ? "identity"
          : path.startsWith("/reports/") ? "reports"
            : path.startsWith("/admin/platform/") ? "platform"
            : path.startsWith("/import-jobs") || path.startsWith("/import-history") ? "imports"
                : path.startsWith("/stations/") ? "station_operations"
                  : path.startsWith("/invoices/") || path.startsWith("/credit-notes/")
                    || path.startsWith("/customers") || path.startsWith("/customer-payments") || path.startsWith("/vouchers")
                    ? "finance"
                    : path.startsWith("/client/") || path.startsWith("/clients/") ? "client_operations"
                      : path === "/workspaces" ? "identity" : "other";
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    recordHttpRequest(request.method ?? "OTHER", route, response.statusCode, durationMs / 1000);
    console.log(JSON.stringify({ event: "http_request", requestId, method: request.method ?? "UNKNOWN", route,
      status: response.statusCode, durationMs: Number(durationMs.toFixed(2)) }));
  });
  void handle(request, response).catch((error: unknown) => {
    if (error instanceof IdentityError) {
      send(response, error.statusCode, { error: error.message });
      return;
    }
    if (error instanceof Error && error.message === "FORBIDDEN_RESOURCE_SCOPE") {
      send(response, 403, { error: "Insufficient resource scope" });
      return;
    }
    const databaseCode = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (databaseCode === "23P01" || databaseCode === "23505" || databaseCode === "P0001") {
      send(response, 409, { error: "The requested record conflicts with existing data" });
      return;
    }
    if (databaseCode === "23503" || databaseCode === "23514" || databaseCode === "23502") {
      send(response, 400, { error: "The requested data violates a required relationship or rule" });
      return;
    }
    send(response, 500, { error: "internal_server_error" });
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Station platform service listening on port ${port}`);
});

const metricsServer = createServer((request, response) => {
  if (request.method !== "GET" || request.url?.split("?", 1)[0] !== "/metrics") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("not found\n");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(renderMetrics(pool));
});

metricsServer.listen(metricsPort, "0.0.0.0", () => {
  console.log(`Station platform private metrics listener on port ${metricsPort}`);
});
