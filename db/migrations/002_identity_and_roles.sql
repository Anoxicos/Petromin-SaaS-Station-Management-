SET ROLE station_owner;

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS auth_subject text;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_auth_subject_key ON app_users(auth_subject);

CREATE OR REPLACE FUNCTION app_resolve_principal(target_subject text, requested_client uuid)
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

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DROP POLICY IF EXISTS stations_scope ON stations;
CREATE POLICY stations_scope ON stations
  USING (app_can_access_station(client_id, id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']));

DROP POLICY IF EXISTS audit_events_read_scope ON audit_events;
CREATE POLICY audit_events_read_scope ON audit_events
  FOR SELECT USING (
    client_id IS NULL AND app_is_super_admin()
    OR client_id IS NOT NULL AND (
      app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER', 'ACCOUNTANT'])
      OR (station_id IS NOT NULL AND app_can_access_station(client_id, station_id))
    )
  );

DROP POLICY IF EXISTS audit_events_insert_scope ON audit_events;
CREATE POLICY audit_events_insert_scope ON audit_events
  FOR INSERT WITH CHECK (
    (client_id IS NULL AND app_is_super_admin())
    OR (client_id IS NOT NULL AND actor_id = app_actor_id() AND (
      (station_id IS NULL AND app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']))
      OR (station_id IS NOT NULL AND app_can_access_station(client_id, station_id))
    ))
  );

RESET ROLE;
