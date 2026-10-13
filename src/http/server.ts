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
    send(response, 500, { error: "internal_server_error" });
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Station platform service listening on port ${port}`);
});
