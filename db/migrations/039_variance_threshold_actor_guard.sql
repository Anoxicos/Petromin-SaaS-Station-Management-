SET ROLE station_owner;

DROP POLICY station_fuel_variance_thresholds_scope ON station_fuel_variance_thresholds;
CREATE POLICY station_fuel_variance_thresholds_scope ON station_fuel_variance_thresholds
  USING (app_can_access_station(client_id,station_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER']) AND updated_by=app_actor_id());

RESET ROLE;
