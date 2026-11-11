SET ROLE station_owner;

CREATE TABLE meter_reading_product_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  reading_id uuid NOT NULL,
  product_id uuid NOT NULL,
  volume numeric(14, 3) NOT NULL CHECK (volume >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, reading_id)
    REFERENCES meter_readings(client_id, station_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, station_id, product_id)
    REFERENCES station_products(client_id, station_id, product_id),
  UNIQUE (reading_id, product_id)
);

CREATE INDEX meter_reading_allocations_product_idx
  ON meter_reading_product_allocations(client_id, station_id, product_id, reading_id);

CREATE FUNCTION guard_meter_reading_allocation_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_reading uuid;
BEGIN
  target_reading := CASE WHEN TG_OP = 'DELETE' THEN OLD.reading_id ELSE NEW.reading_id END;
  IF EXISTS (
    SELECT 1 FROM meter_readings r
    JOIN meter_reading_batches b ON b.client_id = r.client_id
      AND b.station_id = r.station_id AND b.id = r.batch_id
    WHERE r.id = target_reading AND b.status = 'VALIDATED'
  ) THEN
    RAISE EXCEPTION 'validated meter product allocations are locked';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER meter_reading_allocations_locked
BEFORE INSERT OR UPDATE OR DELETE ON meter_reading_product_allocations
FOR EACH ROW EXECUTE FUNCTION guard_meter_reading_allocation_mutation();

ALTER TABLE meter_reading_product_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_reading_product_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY meter_reading_product_allocations_station_scope ON meter_reading_product_allocations
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON meter_reading_product_allocations TO station_app;

RESET ROLE;
