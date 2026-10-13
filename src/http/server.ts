import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import { requireAccess, type Principal } from "../domain/authorization.js";
import { pool, withPrincipal } from "../infrastructure/db.js";
import { IdentityError, resolvePrincipal } from "../infrastructure/identity.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stationRoles = new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]);
const membershipManagers = new Set(["OWNER", "MANAGER", "SUPER_ADMIN"]);
const membershipRoleValues = new Set(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER"]);
const port = Number(process.env.PORT ?? 3000);

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
  return { meterMode, closingCutoff, timeZone };
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

  if (request.method === "GET" && url.pathname === "/me") {
    send(response, 200, {
      userId: principal.userId,
      clientId: principal.clientId,
      role: principal.role,
    });
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
        "SELECT id, client_id, code, name, meter_mode, closing_cutoff::text, time_zone FROM stations ORDER BY name",
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
    const { meterMode, closingCutoff, timeZone } = stationSettings(body);

    const created = await withPrincipal(principal, async (client) => {
      const result = await client.query(
        `INSERT INTO stations (client_id, code, name, meter_mode, closing_cutoff, time_zone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, client_id, code, name, meter_mode, closing_cutoff::text, time_zone`,
        [clientId, code, name, meterMode, closingCutoff, timeZone],
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
        `SELECT id, client_id, code, name, meter_mode, closing_cutoff::text, time_zone
         FROM stations WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [stationId, clientId],
      );
      const old = current.rows[0];
      if (!old) throw new IdentityError(404, "Station not found");

      const result = await client.query(
        `UPDATE stations
         SET meter_mode = $3, closing_cutoff = $4, time_zone = $5, updated_at = now()
         WHERE id = $1 AND client_id = $2
         RETURNING id, client_id, code, name, meter_mode, closing_cutoff::text, time_zone`,
        [stationId, clientId, settings.meterMode, settings.closingCutoff, settings.timeZone],
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
    if (databaseCode === "23P01" || databaseCode === "23505") {
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
