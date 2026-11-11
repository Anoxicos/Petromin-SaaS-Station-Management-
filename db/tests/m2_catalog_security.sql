-- Repeatable integration checks for the M2 catalog/equipment migration.
-- Everything is rolled back so this script is safe against a disposable DB.
BEGIN;

INSERT INTO clients (id, name, code) VALUES
  ('10000000-0000-4000-8000-000000000001', 'M2 Test Client A', 'M2_TEST_A'),
  ('10000000-0000-4000-8000-000000000002', 'M2 Test Client B', 'M2_TEST_B');

INSERT INTO app_users (id, auth_subject, email, display_name, is_super_admin) VALUES
  ('20000000-0000-4000-8000-000000000001', 'm2-test-super-admin', 'm2-admin@example.invalid', 'M2 Test Admin', true),
  ('20000000-0000-4000-8000-000000000002', 'm2-test-cashier', 'm2-cashier@example.invalid', 'M2 Test Cashier', false);

INSERT INTO client_memberships (client_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'CASHIER');

INSERT INTO stations (id, client_id, code, name, meter_mode, closing_cutoff, time_zone, closing_day_rule) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'M2_A1', 'M2 A1', 'NOZZLE', '23:00', 'Africa/Casablanca', 'CUTOFF_ENDS_DAY'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'M2_A2', 'M2 A2', 'PUMP_TOTALIZER', '02:00', 'Africa/Casablanca', NULL),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'M2_B1', 'M2 B1', 'NOZZLE', '23:00', 'Africa/Casablanca', NULL);

INSERT INTO products (id, client_id, code, name, product_type, unit_code) VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'M2_GAS', 'M2 Gasoline', 'FUEL', 'L'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'M2_DIESEL', 'M2 Diesel', 'FUEL', 'L'),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'M2_OIL', 'M2 Oil', 'ARTICLE', 'EA'),
  ('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', 'M2_B_GAS', 'M2 B Gasoline', 'FUEL', 'L');

SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id', '20000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.client_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.role', 'SUPER_ADMIN', true);

INSERT INTO station_memberships (client_id, station_id, user_id) VALUES
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002');

INSERT INTO station_products (client_id, station_id, product_id) VALUES
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004');

INSERT INTO fuel_tariffs (id, client_id, station_id, product_id, unit_price, valid_from, valid_until, created_by) VALUES
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 14.2500, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '20000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 14.2500, '2026-01-01T00:00:00Z', NULL, '20000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004', 15.0000, '2026-01-01T00:00:00Z', NULL, '20000000-0000-4000-8000-000000000001');

INSERT INTO station_equipment (id, client_id, station_id, code, kind, product_id, installed_at, retired_at, parent_equipment_id) VALUES
  ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'M2_PUMP_1', 'PUMP', NULL, DEFAULT, NULL, NULL),
  ('60000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'M2_TANK_G', 'TANK', '40000000-0000-4000-8000-000000000001', DEFAULT, NULL, NULL),
  ('60000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'M2_TANK_D', 'TANK', '40000000-0000-4000-8000-000000000002', DEFAULT, NULL, NULL),
  ('60000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'M2_NOZZLE_G', 'NOZZLE', '40000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z', NULL, '60000000-0000-4000-8000-000000000001');

INSERT INTO station_equipment (id, client_id, station_id, code, kind, installed_at) VALUES
  ('60000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'M2_TOTALIZER_1', 'PUMP', DEFAULT);

INSERT INTO nozzle_tank_assignments (id, client_id, station_id, nozzle_id, tank_id, valid_from, recorded_by) VALUES
  ('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000002', '2026-01-01T00:00:00Z', '20000000-0000-4000-8000-000000000001');

INSERT INTO meter_reading_batches (id, client_id, station_id, business_date, submitted_by) VALUES
  ('80000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '2026-01-14', '20000000-0000-4000-8000-000000000001'),
  ('80000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '2026-01-15', '20000000-0000-4000-8000-000000000001');
INSERT INTO meter_readings (id, client_id, station_id, batch_id, equipment_id, initial_index, final_index) VALUES
  ('90000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000004', 500.000, 510.000),
  ('90000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000004', 5.000, 15.000);

INSERT INTO meter_resets
  (id, client_id, station_id, equipment_id, business_date, previous_index, new_initial_index, reason, recorded_by)
VALUES
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000004', '2026-01-15', 510, 5, 'Meter replaced after failure', '20000000-0000-4000-8000-000000000001');

INSERT INTO meter_reading_batches (id, client_id, station_id, business_date, submitted_by) VALUES
  ('80000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '2026-01-01', '20000000-0000-4000-8000-000000000001');

INSERT INTO meter_readings (id, client_id, station_id, batch_id, equipment_id, initial_index, final_index) VALUES
  ('90000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000005', 100.000, 125.000);

INSERT INTO meter_reading_product_allocations (client_id, station_id, reading_id, product_id, volume) VALUES
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 24.000);

DO $$
BEGIN
  BEGIN
    INSERT INTO fuel_tariffs (client_id, station_id, product_id, unit_price, valid_from, valid_until, created_by)
    VALUES ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 14.5000, '2026-01-15T00:00:00Z', NULL, '20000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'overlapping tariff was unexpectedly accepted';
  EXCEPTION WHEN exclusion_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO fuel_tariffs (client_id, station_id, product_id, unit_price, valid_from, created_by)
    VALUES ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', 20.0000, '2026-03-01T00:00:00Z', '20000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'non-fuel tariff was unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO nozzle_tank_assignments (client_id, station_id, nozzle_id, tank_id, valid_from, recorded_by)
    VALUES ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000003', '2026-02-01T00:00:00Z', '20000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'mismatched nozzle and tank products were unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

-- The database itself rejects incomplete pump-totalizer product splits and locks validated splits.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    UPDATE meter_reading_batches
    SET status = 'VALIDATED', validated_by = '20000000-0000-4000-8000-000000000001', validated_at = now()
    WHERE id = '80000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'mismatched totalizer allocation was unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'database failed to reject mismatched totalizer allocation'; END IF;

  UPDATE meter_readings SET final_index = 124.000
  WHERE id = '90000000-0000-4000-8000-000000000001';
  UPDATE meter_reading_batches
  SET status = 'VALIDATED', validated_by = '20000000-0000-4000-8000-000000000001', validated_at = now()
  WHERE id = '80000000-0000-4000-8000-000000000001';

  rejected := false;
  BEGIN
    UPDATE meter_reading_product_allocations SET volume = 20.000
    WHERE reading_id = '90000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'validated totalizer allocation was unexpectedly mutable';
  EXCEPTION WHEN raise_exception THEN
    rejected := SQLERRM = 'validated meter product allocations are locked';
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'validated totalizer allocation was mutable'; END IF;
END
$$;

SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id', '20000000-0000-4000-8000-000000000002', true);
SELECT set_config('app.client_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.role', 'CASHIER', true);

DO $$
DECLARE
  visible_count integer;
  pricing_value numeric;
BEGIN
  SELECT count(*) INTO visible_count FROM products;
  IF visible_count <> 3 THEN RAISE EXCEPTION 'client product isolation failed: % products visible', visible_count; END IF;

  SELECT count(*) INTO visible_count FROM fuel_tariffs;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'station tariff isolation failed: % tariffs visible', visible_count; END IF;

  SELECT count(*) INTO visible_count FROM station_equipment;
  IF visible_count <> 4 THEN RAISE EXCEPTION 'station equipment isolation failed: % rows visible', visible_count; END IF;

  SELECT count(*) INTO visible_count FROM nozzle_tank_assignments;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'station assignment isolation failed: % rows visible', visible_count; END IF;

  UPDATE meter_readings SET volume = final_index - initial_index
  WHERE id IN ('90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000003');
  UPDATE meter_reading_batches
  SET status = 'VALIDATED', validated_by = '20000000-0000-4000-8000-000000000002', validated_at = now()
  WHERE id = '80000000-0000-4000-8000-000000000003';
  UPDATE meter_reading_batches
  SET status = 'VALIDATED', validated_by = '20000000-0000-4000-8000-000000000002', validated_at = now()
  WHERE id = '80000000-0000-4000-8000-000000000002';

  SELECT count(*) INTO visible_count
  FROM meter_resets reset
  JOIN meter_reading_batches batch ON batch.client_id = reset.client_id
    AND batch.station_id = reset.station_id AND batch.business_date = reset.business_date
  JOIN meter_readings reading ON reading.client_id = batch.client_id
    AND reading.station_id = batch.station_id AND reading.batch_id = batch.id
    AND reading.equipment_id = reset.equipment_id
  JOIN LATERAL (
    SELECT prior.final_index FROM meter_reading_batches prior_batch
    JOIN meter_readings prior ON prior.client_id = prior_batch.client_id
      AND prior.station_id = prior_batch.station_id AND prior.batch_id = prior_batch.id
      AND prior.equipment_id = reading.equipment_id
    WHERE prior_batch.client_id = reset.client_id AND prior_batch.station_id = reset.station_id
      AND prior_batch.status = 'VALIDATED' AND prior_batch.business_date < reset.business_date
    ORDER BY prior_batch.business_date DESC LIMIT 1
  ) previous ON true
  WHERE batch.id = '80000000-0000-4000-8000-000000000002'
    AND reset.new_initial_index = reading.initial_index
    AND reset.previous_index = previous.final_index;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'meter reset does not match validated history and new initial index'; END IF;

  WITH period AS (
    SELECT ((('2026-01-15'::date - 1) + '23:00'::time) AT TIME ZONE 'Africa/Casablanca') AS starts_at,
           (('2026-01-15'::date + '23:00'::time) AT TIME ZONE 'Africa/Casablanca') AS ends_at
  )
  SELECT round(sum(r.volume * t.unit_price), 2) INTO pricing_value
  FROM meter_reading_batches b
  JOIN meter_readings r ON r.batch_id = b.id
  JOIN station_equipment e ON e.client_id = r.client_id AND e.station_id = r.station_id AND e.id = r.equipment_id
  JOIN fuel_tariffs t ON t.client_id = b.client_id AND t.station_id = b.station_id AND t.product_id = e.product_id
  CROSS JOIN period p
  WHERE b.id = '80000000-0000-4000-8000-000000000002'
    AND t.valid_from <= p.starts_at AND (t.valid_until IS NULL OR t.valid_until >= p.ends_at);
  IF pricing_value <> 142.50 THEN RAISE EXCEPTION 'daily tariff coverage calculation failed: %', pricing_value; END IF;

  BEGIN
    INSERT INTO fuel_tariffs (client_id, station_id, product_id, unit_price, valid_from, created_by)
    VALUES ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 14.5000, '2026-03-01T00:00:00Z', '20000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'cashier write was unexpectedly accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;

ROLLBACK;
