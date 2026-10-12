-- Compose runs this migration as the non-login schema owner, never as the
-- container's superuser. gen_random_uuid() is built into supported PostgreSQL.
SET ROLE station_owner;

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text UNIQUE,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  is_super_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_memberships (
  client_id uuid NOT NULL REFERENCES clients(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  role text NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, user_id)
);

CREATE TABLE stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  code text NOT NULL CHECK (length(trim(code)) > 0),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  meter_mode text NOT NULL CHECK (meter_mode IN ('NOZZLE', 'PUMP_TOTALIZER')),
  closing_cutoff time NOT NULL,
  time_zone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, code),
  UNIQUE (client_id, id)
);

CREATE TABLE station_memberships (
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, user_id),
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id),
  FOREIGN KEY (client_id, user_id) REFERENCES client_memberships(client_id, user_id)
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id uuid REFERENCES clients(id),
  station_id uuid,
  actor_id uuid REFERENCES app_users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id)
);

CREATE INDEX stations_client_idx ON stations(client_id);
CREATE INDEX audit_events_client_time_idx ON audit_events(client_id, occurred_at DESC);
CREATE INDEX audit_events_station_time_idx ON audit_events(station_id, occurred_at DESC);

CREATE FUNCTION app_actor_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;

CREATE FUNCTION app_client_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.client_id', true), '')::uuid $$;

CREATE FUNCTION app_is_super_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_users u
    WHERE u.id = app_actor_id() AND u.is_super_admin
  )
$$;

CREATE FUNCTION app_has_client_access(target_client uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_super_admin() OR EXISTS (
    SELECT 1 FROM client_memberships m
    WHERE m.user_id = app_actor_id()
      AND m.client_id = target_client
      AND m.client_id = app_client_id()
  )
$$;

CREATE FUNCTION app_has_client_role(target_client uuid, allowed_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_super_admin() OR EXISTS (
    SELECT 1 FROM client_memberships m
    WHERE m.user_id = app_actor_id()
      AND m.client_id = target_client
      AND m.client_id = app_client_id()
      AND m.role = ANY(allowed_roles)
  )
$$;

CREATE FUNCTION app_user_in_current_client(target_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_super_admin() OR (
    app_has_client_access(app_client_id()) AND EXISTS (
      SELECT 1 FROM client_memberships m
      WHERE m.user_id = target_user AND m.client_id = app_client_id()
    )
  )
$$;

CREATE FUNCTION app_resolve_principal(target_subject text, requested_client uuid)
RETURNS TABLE (
  actor_id uuid,
  client_id uuid,
  role text,
  station_ids uuid[],
  is_super_admin boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id,
         CASE WHEN u.is_super_admin THEN requested_client ELSE m.client_id END,
         CASE WHEN u.is_super_admin THEN 'SUPER_ADMIN' ELSE m.role END,
         COALESCE(
           ARRAY(
             SELECT sm.station_id FROM station_memberships sm
             WHERE sm.user_id = u.id AND sm.client_id = m.client_id
           ),
           ARRAY[]::uuid[]
         ),
         u.is_super_admin
  FROM app_users u
  LEFT JOIN client_memberships m
    ON m.user_id = u.id
   AND m.client_id = requested_client
  WHERE u.auth_subject = target_subject
    AND (u.is_super_admin OR (requested_client IS NOT NULL AND m.client_id IS NOT NULL))
$$;

CREATE FUNCTION app_can_access_station(target_client uuid, target_station uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_has_client_role(target_client, ARRAY['OWNER', 'MANAGER', 'ACCOUNTANT'])
    OR EXISTS (
      SELECT 1 FROM station_memberships sm
      WHERE sm.client_id = target_client
        AND sm.station_id = target_station
        AND sm.user_id = app_actor_id()
        AND target_client = app_client_id()
    )
$$;

CREATE FUNCTION prevent_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_scope ON clients
  USING (app_has_client_access(id))
  WITH CHECK (app_is_super_admin());

ALTER TABLE client_memberships ENABLE ROW LEVEL SECURITY;
-- The SECURITY DEFINER authorization helpers must be able to read this table
-- without recursively re-entering its policy. The runtime role remains subject
-- to RLS; table ownership belongs only to the migration role.
CREATE POLICY client_memberships_scope ON client_memberships
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']));

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_users_read_scope ON app_users
  FOR SELECT USING (id = app_actor_id() OR app_user_in_current_client(id));
CREATE POLICY app_users_write_scope ON app_users
  FOR ALL USING (app_is_super_admin())
  WITH CHECK (app_is_super_admin());

ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations FORCE ROW LEVEL SECURITY;
CREATE POLICY stations_scope ON stations
  USING (app_can_access_station(client_id, id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']));

ALTER TABLE station_memberships ENABLE ROW LEVEL SECURITY;
-- As above, authorization helpers need to inspect assignments without
-- recursively re-entering this policy. The runtime role is still RLS-bound.
CREATE POLICY station_memberships_scope ON station_memberships
  USING (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_read_scope ON audit_events
  FOR SELECT USING (
    client_id IS NULL AND app_is_super_admin()
    OR client_id IS NOT NULL AND (
      app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER', 'ACCOUNTANT'])
      OR (station_id IS NOT NULL AND app_can_access_station(client_id, station_id))
    )
  );
CREATE POLICY audit_events_insert_scope ON audit_events
  FOR INSERT WITH CHECK (
    (client_id IS NULL AND app_is_super_admin())
    OR (client_id IS NOT NULL AND actor_id = app_actor_id() AND (
      (station_id IS NULL AND app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']))
      OR (station_id IS NOT NULL AND app_can_access_station(client_id, station_id))
    ))
  );

RESET ROLE;
