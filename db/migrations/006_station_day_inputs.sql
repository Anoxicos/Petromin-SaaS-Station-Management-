SET ROLE station_owner;

CREATE TABLE station_day_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  business_date date NOT NULL,
  cash_total numeric(14, 2) NOT NULL DEFAULT 0 CHECK (cash_total >= 0),
  card_total numeric(14, 2) NOT NULL DEFAULT 0 CHECK (card_total >= 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALIDATED')),
  entered_by uuid NOT NULL REFERENCES app_users(id),
  entered_at timestamptz NOT NULL DEFAULT now(),
  validated_by uuid REFERENCES app_users(id),
  validated_at timestamptz,
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id),
  UNIQUE (client_id, station_id, id),
  UNIQUE (client_id, station_id, business_date),
  CHECK ((status = 'DRAFT' AND validated_by IS NULL AND validated_at IS NULL)
      OR (status = 'VALIDATED' AND validated_by IS NOT NULL AND validated_at IS NOT NULL))
);

CREATE TABLE station_day_dips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  day_input_id uuid NOT NULL,
  tank_id uuid NOT NULL,
  product_depth_mm numeric(14, 3) NOT NULL CHECK (product_depth_mm >= 0),
  water_depth_mm numeric(14, 3) CHECK (water_depth_mm IS NULL OR water_depth_mm >= 0),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, day_input_id)
    REFERENCES station_day_inputs(client_id, station_id, id),
  FOREIGN KEY (client_id, station_id, tank_id)
    REFERENCES station_equipment(client_id, station_id, id),
  UNIQUE (day_input_id, tank_id),
  CHECK (water_depth_mm IS NULL OR water_depth_mm <= product_depth_mm)
);

CREATE INDEX station_day_inputs_history_idx
  ON station_day_inputs(client_id, station_id, business_date DESC);

CREATE FUNCTION guard_station_day_input_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'VALIDATED' THEN
    RAISE EXCEPTION 'validated station-day inputs are locked';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER station_day_inputs_locked
BEFORE UPDATE OR DELETE ON station_day_inputs
FOR EACH ROW EXECUTE FUNCTION guard_station_day_input_mutation();

CREATE FUNCTION guard_station_day_dip_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_day_input uuid;
BEGIN
  target_day_input := CASE WHEN TG_OP = 'DELETE' THEN OLD.day_input_id ELSE NEW.day_input_id END;
  IF EXISTS (SELECT 1 FROM station_day_inputs WHERE id = target_day_input AND status = 'VALIDATED') THEN
    RAISE EXCEPTION 'validated station-day dips are locked';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER station_day_dips_locked
BEFORE INSERT OR UPDATE OR DELETE ON station_day_dips
FOR EACH ROW EXECUTE FUNCTION guard_station_day_dip_mutation();

ALTER TABLE station_day_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_day_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY station_day_inputs_station_scope ON station_day_inputs
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

ALTER TABLE station_day_dips ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_day_dips FORCE ROW LEVEL SECURITY;
CREATE POLICY station_day_dips_station_scope ON station_day_dips
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

GRANT SELECT, INSERT, UPDATE ON station_day_inputs TO station_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON station_day_dips TO station_app;

RESET ROLE;
