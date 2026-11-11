SET ROLE station_owner;

CREATE TABLE station_day_closing_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  closing_id uuid NOT NULL,
  adjustment_number integer NOT NULL CHECK (adjustment_number > 0),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  before_snapshot jsonb NOT NULL CHECK (jsonb_typeof(before_snapshot) = 'object'),
  after_snapshot jsonb NOT NULL CHECK (jsonb_typeof(after_snapshot) = 'object'),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, closing_id)
    REFERENCES station_day_closings(client_id, station_id, id),
  UNIQUE (closing_id, adjustment_number)
);

CREATE INDEX station_day_closing_adjustments_history_idx
  ON station_day_closing_adjustments(client_id, station_id, closing_id, adjustment_number DESC);

CREATE FUNCTION prevent_station_day_closing_adjustment_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'station-day closing adjustments are immutable';
END
$$;

CREATE TRIGGER station_day_closing_adjustments_immutable
BEFORE UPDATE OR DELETE ON station_day_closing_adjustments
FOR EACH ROW EXECUTE FUNCTION prevent_station_day_closing_adjustment_mutation();

ALTER TABLE station_day_closing_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_day_closing_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY station_day_closing_adjustments_station_scope ON station_day_closing_adjustments
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

GRANT SELECT, INSERT ON station_day_closing_adjustments TO station_app;

RESET ROLE;
