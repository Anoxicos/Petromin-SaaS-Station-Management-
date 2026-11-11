SET ROLE station_owner;

CREATE TABLE meter_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  business_date date NOT NULL,
  previous_index numeric(14, 3) NOT NULL CHECK (previous_index >= 0),
  new_initial_index numeric(14, 3) NOT NULL CHECK (new_initial_index >= 0),
  previous_serial_number text,
  new_serial_number text,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, equipment_id)
    REFERENCES station_equipment(client_id, station_id, id),
  UNIQUE (client_id, station_id, equipment_id, business_date)
);

CREATE INDEX meter_resets_equipment_history_idx
  ON meter_resets(client_id, station_id, equipment_id, business_date DESC);

CREATE FUNCTION prevent_meter_reset_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'meter reset records are immutable';
END
$$;

CREATE TRIGGER meter_resets_immutable
BEFORE UPDATE OR DELETE ON meter_resets
FOR EACH ROW EXECUTE FUNCTION prevent_meter_reset_mutation();

ALTER TABLE meter_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY meter_resets_station_scope ON meter_resets
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']));

GRANT SELECT, INSERT ON meter_resets TO station_app;

RESET ROLE;
