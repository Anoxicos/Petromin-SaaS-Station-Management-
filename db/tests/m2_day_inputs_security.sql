-- Rollback-only integration checks for station-day cash/card and dip inputs.
BEGIN;

INSERT INTO clients (id, name, code) VALUES
  ('11000000-0000-4000-8000-000000000001', 'Day Input Test A', 'DAY_INPUT_A'),
  ('11000000-0000-4000-8000-000000000002', 'Day Input Test B', 'DAY_INPUT_B');

INSERT INTO app_users (id, auth_subject, email, display_name) VALUES
  ('21000000-0000-4000-8000-000000000001', 'day-input-test-cashier', 'day-input-cashier@example.invalid', 'Day Input Cashier'),
  ('21000000-0000-4000-8000-000000000002', 'day-input-test-other', 'day-input-other@example.invalid', 'Day Input Other');

INSERT INTO app_users (id, auth_subject, email, display_name, is_super_admin)
VALUES ('21000000-0000-4000-8000-000000000003', 'day-input-test-admin', 'day-input-admin@example.invalid', 'Day Input Admin', true);

INSERT INTO client_memberships (client_id, user_id, role) VALUES
  ('11000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'CASHIER');

INSERT INTO stations (id, client_id, code, name, meter_mode, closing_cutoff, time_zone) VALUES
  ('31000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'DAY_A1', 'Day Input A1', 'NOZZLE', '23:00', 'Africa/Casablanca'),
  ('31000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002', 'DAY_B1', 'Day Input B1', 'NOZZLE', '23:00', 'Africa/Casablanca');

INSERT INTO products (id, client_id, code, name, product_type, unit_code) VALUES
  ('41000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'DAY_FUEL_A', 'Day Fuel A', 'FUEL', 'L'),
  ('41000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002', 'DAY_FUEL_B', 'Day Fuel B', 'FUEL', 'L');

SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id', '21000000-0000-4000-8000-000000000003', true);
SELECT set_config('app.client_id', '11000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.role', 'SUPER_ADMIN', true);

INSERT INTO station_products (client_id, station_id, product_id) VALUES
  ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001');

INSERT INTO station_equipment (id, client_id, station_id, code, kind, installed_at, product_id) VALUES
  ('61000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'DAY_TANK_A', 'TANK', now(), '41000000-0000-4000-8000-000000000001');

INSERT INTO station_equipment (id, client_id, station_id, code, kind, installed_at) VALUES
  ('61000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'DAY_PUMP_A', 'PUMP', now());
INSERT INTO station_equipment (id, client_id, station_id, code, kind, installed_at, product_id, parent_equipment_id) VALUES
  ('61000000-0000-4000-8000-000000000003', '11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', 'DAY_NOZZLE_A', 'NOZZLE', now(), '41000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002');

INSERT INTO meter_reading_batches (id, client_id, station_id, business_date, submitted_by) VALUES
  ('71000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '2026-10-12', '21000000-0000-4000-8000-000000000003');
INSERT INTO meter_readings (id, client_id, station_id, batch_id, equipment_id, initial_index, final_index) VALUES
  ('72000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000003', 100.000, 120.000);

INSERT INTO tank_calibrations (id, client_id, station_id, tank_id, effective_from, created_by) VALUES
  ('73000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', '2026-10-01', '21000000-0000-4000-8000-000000000003');
INSERT INTO tank_calibration_points (client_id, station_id, calibration_id, depth_mm, volume_liters) VALUES
  ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 0, 0),
  ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 2000, 2000);

INSERT INTO station_memberships (client_id, station_id, user_id) VALUES
  ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001');

RESET ROLE;

INSERT INTO station_day_inputs (id, client_id, station_id, business_date, cash_total, card_total, currency_code, entered_by) VALUES
  ('81000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '2026-10-12', 1200.00, 350.00, 'MAD', '21000000-0000-4000-8000-000000000001'),
  ('81000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000002', '2026-10-12', 25.00, 0.00, 'EUR', '21000000-0000-4000-8000-000000000002');

INSERT INTO station_day_dips (id, client_id, station_id, day_input_id, tank_id, product_depth_mm, water_depth_mm, recorded_by) VALUES
  ('91000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', 1250.000, 12.000, '21000000-0000-4000-8000-000000000001');

INSERT INTO station_cash_card_variance_thresholds
  (client_id,station_id,currency_code,max_abs_cash_variance,max_abs_card_variance,reason,updated_by)
VALUES('11000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',
  'MAD',5.00,1.00,'M2 reconciliation snapshot test','21000000-0000-4000-8000-000000000003');

INSERT INTO station_day_reconciliations
  (client_id, station_id, day_input_id, revision_number, reported_cash_total, reported_card_total,
   counted_cash_total, card_settlement_total, reason, recorded_by)
VALUES
  ('11000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000002',
   '81000000-0000-4000-8000-000000000002', 1, 25.00, 0.00, 25.00, 0.00,
   'Tenant isolation fixture', '21000000-0000-4000-8000-000000000002');

SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id', '21000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.client_id', '11000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.role', 'CASHIER', true);

DO $$
DECLARE
  visible_count integer;
  lock_rejected boolean;
  window_start timestamptz;
  window_end timestamptz;
  day_currency text;
  prior_date date;
  prior_index numeric(14,3);
BEGIN
  SELECT count(*) INTO visible_count FROM station_day_inputs;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'station-day tenant isolation failed: % records visible', visible_count; END IF;
  SELECT currency_code INTO day_currency FROM station_day_inputs WHERE id = '81000000-0000-4000-8000-000000000001';
  IF day_currency <> 'MAD' THEN RAISE EXCEPTION 'daily collection currency was not retained: %', day_currency; END IF;
  BEGIN
    UPDATE station_day_inputs SET currency_code = 'M$D' WHERE id = '81000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'daily collection accepted an invalid currency code';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT count(*) INTO visible_count FROM station_day_dips;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'tank-dip tenant isolation failed: % records visible', visible_count; END IF;

  SELECT count(*) INTO visible_count FROM tank_calibrations;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'tank calibration tenant isolation failed'; END IF;

  SELECT start_at, end_at INTO window_start, window_end
  FROM station_business_window('2026-10-14', '23:00', 'Africa/Casablanca', 'CUTOFF_ENDS_DAY');
  IF window_start AT TIME ZONE 'Africa/Casablanca' <> timestamp '2026-10-13 23:00:00'
    OR window_end AT TIME ZONE 'Africa/Casablanca' <> timestamp '2026-10-14 23:00:00' THEN
    RAISE EXCEPTION 'CUTOFF_ENDS_DAY produced an incorrect local business window';
  END IF;
  SELECT start_at, end_at INTO window_start, window_end
  FROM station_business_window('2026-10-14', '23:00', 'Africa/Casablanca', 'CUTOFF_STARTS_DAY');
  IF window_start AT TIME ZONE 'Africa/Casablanca' <> timestamp '2026-10-14 23:00:00'
    OR window_end AT TIME ZONE 'Africa/Casablanca' <> timestamp '2026-10-15 23:00:00' THEN
    RAISE EXCEPTION 'CUTOFF_STARTS_DAY produced an incorrect local business window';
  END IF;
  SELECT start_at, end_at INTO window_start, window_end
  FROM station_business_window('2026-03-08', '00:30', 'America/New_York', 'CUTOFF_STARTS_DAY');
  IF extract(epoch FROM window_end - window_start) <> 82800 THEN
    RAISE EXCEPTION 'station business window did not account for the spring DST transition';
  END IF;
  SELECT start_at, end_at INTO window_start, window_end
  FROM station_business_window('2026-11-01', '00:30', 'America/New_York', 'CUTOFF_STARTS_DAY');
  IF extract(epoch FROM window_end - window_start) <> 90000 THEN
    RAISE EXCEPTION 'station business window did not account for the autumn DST transition';
  END IF;

  UPDATE tank_calibrations
  SET status = 'ACTIVE', activated_by = '21000000-0000-4000-8000-000000000001', activated_at = now()
  WHERE id = '73000000-0000-4000-8000-000000000001';
  IF tank_volume_at_depth('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
      '61000000-0000-4000-8000-000000000001', '2026-10-12', 1250) <> 1250 THEN
    RAISE EXCEPTION 'tank calibration interpolation returned an unexpected volume';
  END IF;
  IF tank_volume_at_depth('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
      '61000000-0000-4000-8000-000000000001', '2026-10-12', 2500) IS NOT NULL THEN
    RAISE EXCEPTION 'tank calibration extrapolated beyond the source chart';
  END IF;

  UPDATE station_day_inputs
  SET status = 'VALIDATED', validated_by = '21000000-0000-4000-8000-000000000001', validated_at = now()
  WHERE id = '81000000-0000-4000-8000-000000000001';

  INSERT INTO station_day_reconciliations
    (client_id, station_id, day_input_id, revision_number, reported_cash_total, reported_card_total,
     counted_cash_total, card_settlement_total, card_settlement_reference, reason, recorded_by,
     currency_code,max_abs_cash_variance,max_abs_card_variance)
  VALUES
    ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 1, 1200.00, 350.00, 1190.00, 349.50, 'BATCH-101', 'Initial count shows variance', '21000000-0000-4000-8000-000000000001','MAD',5.00,1.00),
    ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 2, 1200.00, 350.00, 1200.00, 350.00, 'BATCH-101', 'Recount verified the reported totals', '21000000-0000-4000-8000-000000000001','MAD',5.00,1.00);

  SELECT count(*) INTO visible_count FROM station_day_reconciliations;
  IF visible_count <> 2 THEN RAISE EXCEPTION 'station-day reconciliation tenant isolation or revision history failed: % visible', visible_count; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM station_day_reconciliations
      WHERE day_input_id = '81000000-0000-4000-8000-000000000001'
      AND revision_number = 1 AND cash_variance = -10.00 AND card_variance = -0.50
  ) THEN RAISE EXCEPTION 'manual reconciliation variances were calculated incorrectly'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM station_day_reconciliations
    WHERE day_input_id='81000000-0000-4000-8000-000000000001' AND revision_number=1
      AND currency_code='MAD' AND max_abs_cash_variance=5 AND max_abs_card_variance=1
      AND abs(cash_variance)>max_abs_cash_variance AND abs(card_variance)<=max_abs_card_variance
  ) THEN RAISE EXCEPTION 'reconciliation did not snapshot and classify cash/card thresholds'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM station_day_reconciliations
    WHERE day_input_id = '81000000-0000-4000-8000-000000000001'
      AND revision_number = 2 AND cash_variance = 0 AND card_variance = 0
  ) THEN RAISE EXCEPTION 'balanced reconciliation revision was not stored'; END IF;
  BEGIN
    INSERT INTO station_day_reconciliations
      (client_id,station_id,day_input_id,revision_number,reported_cash_total,reported_card_total,
       counted_cash_total,card_settlement_total,reason,recorded_by,currency_code,max_abs_cash_variance,max_abs_card_variance)
    VALUES('11000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',
      '81000000-0000-4000-8000-000000000001',3,1200,350,1200,350,'Must fail','21000000-0000-4000-8000-000000000001','MAD',50,1);
    RAISE EXCEPTION 'reconciliation accepted a forged threshold snapshot';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'reconciliation currency and tolerance snapshot must match the station policy' THEN RAISE; END IF;
  END;

  lock_rejected := false;
  BEGIN
    UPDATE station_day_reconciliations SET reason = 'Changed'
    WHERE day_input_id = '81000000-0000-4000-8000-000000000001' AND revision_number = 1;
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    lock_rejected := SQLSTATE = '42501' OR SQLERRM = 'station-day reconciliations are immutable';
  END;
  IF NOT lock_rejected THEN RAISE EXCEPTION 'station-day reconciliation was mutable'; END IF;

  UPDATE meter_readings SET volume = final_index - initial_index
  WHERE id = '72000000-0000-4000-8000-000000000001';

  lock_rejected := false;
  BEGIN
    INSERT INTO station_day_closings
      (client_id, station_id, business_date, meter_reading_batch_id, station_day_input_id, snapshot, closed_by)
    VALUES
      ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '2026-10-12',
       '71000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '{"test":"premature"}', '21000000-0000-4000-8000-000000000001');
  EXCEPTION WHEN check_violation THEN
    lock_rejected := true;
  END;
  IF NOT lock_rejected THEN RAISE EXCEPTION 'unvalidated operational station-day close was accepted'; END IF;

  UPDATE meter_reading_batches
  SET status = 'VALIDATED', validated_by = '21000000-0000-4000-8000-000000000001', validated_at = now()
  WHERE id = '71000000-0000-4000-8000-000000000001';

  INSERT INTO meter_reading_batches (id,client_id,station_id,business_date,submitted_by)
  VALUES
    ('71000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','2026-10-13','21000000-0000-4000-8000-000000000001'),
    ('71000000-0000-4000-8000-000000000003','11000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','2026-10-14','21000000-0000-4000-8000-000000000001');
  INSERT INTO meter_readings (id,client_id,station_id,batch_id,equipment_id,initial_index,final_index,volume)
  VALUES
    ('72000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000003',120.000,135.000,15.000),
    ('72000000-0000-4000-8000-000000000003','11000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000003','61000000-0000-4000-8000-000000000003',135.000,145.000,NULL);
  UPDATE meter_reading_batches
  SET status='VALIDATED',validated_by='21000000-0000-4000-8000-000000000001',validated_at=now()
  WHERE id='71000000-0000-4000-8000-000000000002';
  SELECT prior.business_date,prior.final_index INTO prior_date,prior_index
  FROM station_equipment e
  LEFT JOIN LATERAL (
    SELECT b.business_date,r.final_index FROM meter_reading_batches b
    JOIN meter_readings r ON r.client_id=b.client_id AND r.station_id=b.station_id
      AND r.batch_id=b.id AND r.equipment_id=e.id
    WHERE b.client_id=e.client_id AND b.station_id=e.station_id
      AND b.business_date<'2026-10-14'::date AND b.status='VALIDATED'
    ORDER BY b.business_date DESC LIMIT 1
  ) prior ON true
  WHERE e.id='61000000-0000-4000-8000-000000000003';
  IF prior_date<>'2026-10-13'::date OR prior_index<>135.000 THEN
    RAISE EXCEPTION 'latest prior lookup failed to choose the newest validated reading';
  END IF;
  PERFORM set_config('app.actor_id','21000000-0000-4000-8000-000000000003',true);
  PERFORM set_config('app.role','SUPER_ADMIN',true);
  INSERT INTO meter_resets (id,client_id,station_id,equipment_id,business_date,previous_index,new_initial_index,reason,recorded_by)
  VALUES ('74000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000003','2026-10-14',135.000,5.000,
    'M2 reset-prefill integration check','21000000-0000-4000-8000-000000000003');
  PERFORM set_config('app.actor_id','21000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('app.role','CASHIER',true);
  SELECT reset.new_initial_index INTO prior_index
  FROM station_equipment e
  LEFT JOIN meter_resets reset ON reset.client_id=e.client_id AND reset.station_id=e.station_id
    AND reset.equipment_id=e.id AND reset.business_date='2026-10-14'::date
  WHERE e.id='61000000-0000-4000-8000-000000000003';
  IF prior_index<>5.000 THEN
    RAISE EXCEPTION 'daily entry lookup did not surface the recorded reset starting index';
  END IF;
  SELECT prior.business_date,prior.final_index INTO prior_date,prior_index
  FROM station_equipment e
  LEFT JOIN LATERAL (
    SELECT b.business_date,r.final_index FROM meter_reading_batches b
    JOIN meter_readings r ON r.client_id=b.client_id AND r.station_id=b.station_id
      AND r.batch_id=b.id AND r.equipment_id=e.id
    WHERE b.client_id=e.client_id AND b.station_id=e.station_id
      AND b.business_date<'2026-10-13'::date AND b.status='VALIDATED'
    ORDER BY b.business_date DESC LIMIT 1
  ) prior ON true
  WHERE e.id='61000000-0000-4000-8000-000000000003';
  IF prior_date<>'2026-10-12'::date OR prior_index<>120.000 THEN
    RAISE EXCEPTION 'latest prior lookup failed its strict before-date boundary';
  END IF;

  INSERT INTO station_day_closings
    (client_id, station_id, business_date, meter_reading_batch_id, station_day_input_id, snapshot, closed_by)
  VALUES
    ('11000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '2026-10-12',
     '71000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '{"test":"snapshot"}', '21000000-0000-4000-8000-000000000001');

  SELECT count(*) INTO visible_count FROM station_day_closings;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'station-day closing tenant isolation failed'; END IF;

  INSERT INTO station_day_closing_adjustments
    (client_id, station_id, closing_id, adjustment_number, reason, before_snapshot, after_snapshot, created_by)
  SELECT client_id, station_id, id, 1, 'Corrected counted cash after review', snapshot,
    jsonb_set(snapshot, '{collectionsAndDips,cashTotal}', '1250.00'::jsonb),
    '21000000-0000-4000-8000-000000000001'
  FROM station_day_closings WHERE business_date = '2026-10-12';
  SELECT count(*) INTO visible_count FROM station_day_closing_adjustments;
  IF visible_count <> 1 THEN RAISE EXCEPTION 'station-day adjustment tenant isolation failed'; END IF;

  lock_rejected := false;
  BEGIN
    UPDATE station_day_closing_adjustments SET reason = 'Changed'
    WHERE adjustment_number = 1;
  EXCEPTION WHEN insufficient_privilege THEN
    lock_rejected := true;
  END;
  IF NOT lock_rejected THEN RAISE EXCEPTION 'station-day closing adjustment was mutable'; END IF;

  lock_rejected := false;
  BEGIN
    UPDATE station_day_closings SET snapshot = '{"changed":true}'
    WHERE business_date = '2026-10-12';
  EXCEPTION WHEN insufficient_privilege THEN
    lock_rejected := true;
  END;
  IF NOT lock_rejected THEN RAISE EXCEPTION 'operational station-day closing was mutable'; END IF;

  lock_rejected := false;
  BEGIN
    UPDATE station_day_inputs SET cash_total = 0 WHERE id = '81000000-0000-4000-8000-000000000001';
  EXCEPTION WHEN raise_exception THEN
    lock_rejected := SQLERRM = 'validated station-day inputs are locked';
  END;
  IF NOT lock_rejected THEN RAISE EXCEPTION 'validated station-day input was mutable'; END IF;

  lock_rejected := false;
  BEGIN
    UPDATE station_day_dips SET product_depth_mm = 0 WHERE id = '91000000-0000-4000-8000-000000000001';
  EXCEPTION WHEN raise_exception THEN
    lock_rejected := SQLERRM = 'validated station-day dips are locked';
  END;
  IF NOT lock_rejected THEN RAISE EXCEPTION 'validated tank dip was mutable'; END IF;
END
$$;

ROLLBACK;
