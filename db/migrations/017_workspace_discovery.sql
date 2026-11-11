-- Let an authenticated user discover only the client workspaces and stations
-- they are entitled to select, including a super-admin's cross-client list.
SET ROLE station_owner;

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
  LEFT JOIN LATERAL (
    SELECT membership.client_id, membership.role
    FROM client_memberships membership
    WHERE membership.user_id = u.id
      AND (requested_client IS NULL OR membership.client_id = requested_client)
    ORDER BY membership.client_id
    LIMIT 1
  ) m ON true
  WHERE u.auth_subject = target_subject
    AND (u.is_super_admin OR m.client_id IS NOT NULL)
$$;

CREATE FUNCTION app_list_workspaces()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'clientId', c.id,
    'clientName', c.name,
    'clientCode', c.code,
    'role', CASE WHEN app_is_super_admin() THEN 'SUPER_ADMIN' ELSE membership.role END,
    'stations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'stationId', station.id,
        'code', station.code,
        'name', station.name,
        'meterMode', station.meter_mode,
        'closingCutoff', station.closing_cutoff,
        'timeZone', station.time_zone,
        'closingDayRule', station.closing_day_rule
      ) ORDER BY station.code)
      FROM stations station
      WHERE station.client_id = c.id
        AND (app_is_super_admin()
          OR membership.role IN ('OWNER', 'MANAGER', 'ACCOUNTANT')
          OR EXISTS (
            SELECT 1 FROM station_memberships sm
            WHERE sm.client_id = c.id AND sm.station_id = station.id AND sm.user_id = app_actor_id()
          ))
    ), '[]'::jsonb)
  ) ORDER BY c.name), '[]'::jsonb)
  FROM clients c
  LEFT JOIN client_memberships membership
    ON membership.client_id = c.id AND membership.user_id = app_actor_id()
  WHERE app_is_super_admin() OR membership.user_id IS NOT NULL
$$;

RESET ROLE;
GRANT EXECUTE ON FUNCTION app_resolve_principal(text, uuid) TO station_app;
GRANT EXECUTE ON FUNCTION app_list_workspaces() TO station_app;
