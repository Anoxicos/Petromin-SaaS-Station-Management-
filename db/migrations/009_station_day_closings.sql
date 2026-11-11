SET ROLE station_owner;

CREATE TABLE station_day_closings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  business_date date NOT NULL,
  meter_reading_batch_id uuid NOT NULL,
  station_day_input_id uuid NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  closed_by uuid NOT NULL REFERENCES app_users(id),
  closed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id),
  FOREIGN KEY (client_id, station_id, meter_reading_batch_id)
    REFERENCES meter_reading_batches(client_id, station_id, id),
  FOREIGN KEY (client_id, station_id, station_day_input_id)
    REFERENCES station_day_inputs(client_id, station_id, id),
  UNIQUE (client_id, station_id, business_date),
  UNIQUE (client_id, station_id, id)
);

CREATE INDEX station_day_closings_history_idx
  ON station_day_closings(client_id, station_id, business_date DESC);

CREATE FUNCTION prevent_station_day_closing_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operational station-day closings are immutable';
END
$$;

CREATE TRIGGER station_day_closings_immutable
BEFORE UPDATE OR DELETE ON station_day_closings
FOR EACH ROW EXECUTE FUNCTION prevent_station_day_closing_mutation();

ALTER TABLE station_day_closings ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_day_closings FORCE ROW LEVEL SECURITY;
CREATE POLICY station_day_closings_station_scope ON station_day_closings
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

GRANT SELECT, INSERT ON station_day_closings TO station_app;

RESET ROLE;
