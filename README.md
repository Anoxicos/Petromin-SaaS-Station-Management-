# Station Platform

Foundational code for the multi-client station operations platform. M1 foundations are in progress, and M2's catalog, tariffs, and equipment data model has started.

## Current foundation

- PostgreSQL schema for clients, users, client/station memberships, stations, and append-only audit events.
- Row-level security policies for client-scoped tables.
- Per-station meter mode, closing cut-off, and IANA time zone.
- OIDC JWT verification through configurable issuer, audience, and JWKS URL.
- Verified subjects resolved to provisioned users and client memberships.
- Client/station setup endpoints with server-side role checks and audit records.
- Transaction-local tenant context for PostgreSQL row-level security.
- Database-aware health endpoint.
- Tenant-scoped membership listing and audited updates, with owner-role protections.

## M2 data model in progress

- Client-owned product catalog and per-station product assignments.
- Effective-dated station fuel tariffs with database-enforced non-overlapping periods.
- Station equipment identities and historical nozzle-to-tank assignments, constrained to compatible fuel products.
- Row-level security on all new catalog and station tables. `db/tests/m2_catalog_security.sql` runs rollback-only checks for tenant/station visibility and tariff/equipment constraints.

## Provisional technical choices

PostgreSQL 16+ and Docker Desktop are confirmed. TypeScript remains the working language choice. The application and database both enforce tenant boundaries.

## Local setup

1. Install Docker Desktop and start its Linux container engine.
2. Copy `.env.example` to `.env`; set `POSTGRES_PASSWORD` to a strong local-only value. Compose applies it to both local database roles.
3. Set `AUTH_ISSUER`, `AUTH_AUDIENCE`, and `AUTH_JWKS_URL` for the chosen OIDC provider before using authenticated endpoints.
4. Run `docker compose up --build`.
5. Open `http://localhost:3000/health` to see the service health response.

Compose runs PostgreSQL 16, creates a non-login schema owner and a separate `NOBYPASSRLS` application role, applies tracked SQL migrations before the app starts, and writes an atomic rolling database snapshot to a separate Docker volume. The default local backup interval is 24 hours and can be changed with `BACKUP_INTERVAL_SECONDS`. Only the latest completed snapshot is kept in this local prototype; production backup frequency, retention, off-site storage, RPO, and RTO still need agreement. After adding a migration, run `docker compose run --rm migrate` before deploying the updated app. Each migration runs in a database transaction and is recorded only after success. The runner recognizes and records the previously initialized schema after checking required tables, columns, and grants; it stops rather than guessing if that schema is incomplete.

The initial migration creates tables and RLS policies. Production secrets and the OIDC provider still need to be configured. Do not expose the service to client traffic until verified authentication is connected. After configuring the OIDC provider, sign in as the designated first administrator and obtain that account's exact token `sub`. Run `docker compose exec -it db psql -U station_admin -d station_platform -f /scripts/bootstrap_super_admin.sql`; the one-time script prompts for that subject, email, and display name, and refuses to proceed if a super-admin already exists. Thereafter authenticated super-admins can provision users at `POST /admin/users`. Tenant owners/managers can list memberships at `GET /clients/{clientId}/memberships`, add one at `POST /clients/{clientId}/memberships`, and change its role or station assignments at `PATCH /clients/{clientId}/memberships/{userId}`. Managers cannot grant the owner role, and the last client owner cannot be demoted. Owners/managers can create stations at `POST /clients/{clientId}/stations`; owners/managers and super-admins can update station meter mode, closing cut-off, and time zone at `PATCH /stations/{stationId}/settings`. Membership and station-setting changes are recorded in the append-only audit log. Tenant routes require the matching `X-Client-Id`; the server verifies that selection against the authenticated membership.

To restore a snapshot without overwriting the active database, run `docker compose exec backup sh /scripts/restore-latest.sh station_platform_restore`. The target database name must be new. The restore script creates it under the schema-owner role and restores the snapshot into it.

## Next M1 work

- Select and configure the OIDC provider, bootstrap the initial super-admin, and confirm token expiry and session lifecycle. The bootstrap SQL procedure is ready but must wait for the provider account's real token subject.
- Set production recovery targets and off-site backup policy; local backup and restore have been demonstrated.
- CI is connected to the GitHub repository; the first remote run passed. Keep the workflow required for future merges.
- Extend identity and authorization validation to authenticated HTTP flows once an OIDC provider is configured.

## Next M2 work

- Add audited APIs to manage products, station product assignments, fuel tariffs, pumps, meters, nozzles, tanks, and assignment history.
- Add validated meter readings with nozzle and pump-totalizer modes, period uniqueness, and correction trace.
- Add staff-entered cash/card totals and daily dip records as the base for daily closing.
