import { Pool, type PoolClient } from "pg";
import type { Principal } from "../domain/authorization.js";

for (const setting of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const) {
  if (!process.env[setting]) throw new Error(`${setting} is required`);
}

export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

/**
 * Run work with transaction-local identity settings used by PostgreSQL RLS.
 * The principal must come from a verified authentication layer; never build it
 * from client-supplied request fields.
 */
export async function withPrincipal<T>(
  principal: Principal,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [principal.userId]);
    await client.query("SELECT set_config('app.client_id', $1, true)", [principal.clientId ?? ""]);
    await client.query("SELECT set_config('app.role', $1, true)", [principal.role]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
