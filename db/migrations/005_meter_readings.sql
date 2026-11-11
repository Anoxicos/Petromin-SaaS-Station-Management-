SET ROLE station_owner;

CREATE TABLE meter_reading_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALIDATED')),
  submitted_by uuid NOT NULL REFERENCES app_users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  validated_by uuid REFERENCES app_users(id),
  validated_at timestamptz,
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id),
  UNIQUE (client_id, station_id, id),
  UNIQUE (client_id, station_id, business_date),
  CHECK ((status = 'DRAFT' AND validated_by IS NULL AND validated_at IS NULL)
      OR (status = 'VALIDATED' AND validated_by IS NOT NULL AND validated_at IS NOT NULL))
);

CREATE TABLE meter_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  initial_index numeric(14, 3) NOT NULL CHECK (initial_index >= 0),
  final_index numeric(14, 3) NOT NULL CHECK (final_index >= 0),
  volume numeric(14, 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, batch_id)
    REFERENCES meter_reading_batches(client_id, station_id, id),
  FOREIGN KEY (client_id, station_id, equipment_id)
    REFERENCES station_equipment(client_id, station_id, id),
  UNIQUE (batch_id, equipment_id),
  UNIQUE (client_id, station_id, id),
  CHECK (volume IS NULL OR volume >= 0)
);

CREATE INDEX meter_readings_equipment_history_idx
  ON meter_readings(client_id, station_id, equipment_id, created_at DESC);

CREATE TABLE meter_reading_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  reading_id uuid NOT NULL,
  previous_initial_index numeric(14, 3) NOT NULL,
  previous_final_index numeric(14, 3) NOT NULL,
  previous_volume numeric(14, 3) NOT NULL,
  corrected_initial_index numeric(14, 3) NOT NULL,
  corrected_final_index numeric(14, 3) NOT NULL,
  corrected_volume numeric(14, 3) NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  approved_by uuid NOT NULL REFERENCES app_users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id),
  FOREIGN KEY (client_id, station_id, reading_id)
    REFERENCES meter_readings(client_id, station_id, id),
  CHECK (previous_final_index >= previous_initial_index),
  CHECK (corrected_final_index >= corrected_initial_index),
  CHECK (previous_volume = previous_final_index - previous_initial_index),
  CHECK (corrected_volume = corrected_final_index - corrected_initial_index)
);

CREATE INDEX meter_reading_corrections_history_idx
  ON meter_reading_corrections(reading_id, occurred_at DESC);
CREATE TRIGGER meter_reading_corrections_append_only
BEFORE UPDATE OR DELETE ON meter_reading_corrections
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

ALTER TABLE meter_reading_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_reading_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY meter_reading_batches_station_scope ON meter_reading_batches
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

ALTER TABLE meter_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_readings FORCE ROW LEVEL SECURITY;
CREATE POLICY meter_readings_station_scope ON meter_readings
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

ALTER TABLE meter_reading_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_reading_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY meter_reading_corrections_station_scope ON meter_reading_corrections
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']));

GRANT SELECT, INSERT, UPDATE ON meter_reading_batches TO station_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meter_readings TO station_app;
GRANT SELECT, INSERT ON meter_reading_corrections TO station_app;

RESET ROLE;
