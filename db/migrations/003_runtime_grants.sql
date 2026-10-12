GRANT SELECT ON clients TO station_app;
GRANT INSERT, UPDATE ON clients TO station_app;

GRANT SELECT, INSERT ON app_users TO station_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON client_memberships TO station_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stations TO station_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON station_memberships TO station_app;

GRANT SELECT, INSERT ON audit_events TO station_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO station_app;
GRANT EXECUTE ON FUNCTION app_actor_id() TO station_app;
GRANT EXECUTE ON FUNCTION app_client_id() TO station_app;
GRANT EXECUTE ON FUNCTION app_is_super_admin() TO station_app;
GRANT EXECUTE ON FUNCTION app_has_client_access(uuid) TO station_app;
GRANT EXECUTE ON FUNCTION app_has_client_role(uuid, text[]) TO station_app;
GRANT EXECUTE ON FUNCTION app_user_in_current_client(uuid) TO station_app;
GRANT EXECUTE ON FUNCTION app_resolve_principal(text, uuid) TO station_app;
GRANT EXECUTE ON FUNCTION app_can_access_station(uuid, uuid) TO station_app;
