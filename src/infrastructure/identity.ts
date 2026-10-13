import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Principal, Role } from "../domain/authorization.js";
import { pool } from "./db.js";

const issuer = process.env.AUTH_ISSUER;
const audience = process.env.AUTH_AUDIENCE;
const jwksUrl = process.env.AUTH_JWKS_URL;

const remoteKeys = issuer && audience && jwksUrl
  ? createRemoteJWKSet(new URL(jwksUrl))
  : null;

const roles = new Set<Role>(["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IdentityError extends Error {
  constructor(public readonly statusCode: 400 | 401 | 403 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

export async function resolvePrincipal(request: IncomingMessage): Promise<Principal> {
  if (!remoteKeys || !issuer || !audience) {
    throw new IdentityError(503, "Authentication is not configured");
  }

  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new IdentityError(401, "Bearer token required");

  let subject: string;
  try {
    const { payload } = await jwtVerify(match[1], remoteKeys, {
      issuer,
      audience,
      algorithms: ["RS256", "ES256", "EdDSA"],
    });
    if (!payload.sub) throw new Error("sub claim missing");
    subject = payload.sub;
  } catch {
    throw new IdentityError(401, "Invalid or expired bearer token");
  }

  const requestedClientHeader = request.headers["x-client-id"];
  const requestedClient = Array.isArray(requestedClientHeader)
    ? requestedClientHeader[0]
    : requestedClientHeader;
  if (requestedClient && !uuidPattern.test(requestedClient)) {
    throw new IdentityError(400, "Invalid client identifier");
  }

  const resolved = await pool.query<{
    actor_id: string;
    client_id: string | null;
    role: string;
    station_ids: string[];
  }>("SELECT actor_id, client_id, role, station_ids FROM app_resolve_principal($1, $2::uuid)", [
    subject,
    requestedClient ?? null,
  ]);

  const row = resolved.rows[0];
  if (!row || !roles.has(row.role as Role)) {
    throw new IdentityError(403, "No active platform membership for this client");
  }

  const role = row.role as Role;
  const clientWide = role === "OWNER" || role === "MANAGER" || role === "ACCOUNTANT";
  return {
    userId: row.actor_id,
    clientId: row.client_id,
    role,
    stationIds: clientWide || role === "SUPER_ADMIN" ? null : new Set(row.station_ids),
  };
}
