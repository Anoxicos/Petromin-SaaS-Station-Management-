-- Rollback-only coverage for optional station-scoped, product-unit fuel variance tolerances.
BEGIN;
INSERT INTO clients(id,name,code) VALUES
 ('38000000-0000-4000-8000-000000000001','M10 Variance A','M10_VAR_A'),
 ('38000000-0000-4000-8000-000000000002','M10 Variance B','M10_VAR_B');
INSERT INTO app_users(id,auth_subject,email,display_name,is_super_admin) VALUES
 ('39000000-0000-4000-8000-000000000001','m10-variance-admin','m10-variance-admin@example.invalid','M10 Admin',true),
 ('39000000-0000-4000-8000-000000000002','m10-variance-owner','m10-variance-owner@example.invalid','M10 Owner',false);
INSERT INTO client_memberships(client_id,user_id,role) VALUES
 ('38000000-0000-4000-8000-000000000002','39000000-0000-4000-8000-000000000002','OWNER');
INSERT INTO stations(id,client_id,code,name,meter_mode,closing_cutoff,time_zone) VALUES
 ('3a000000-0000-4000-8000-000000000001','38000000-0000-4000-8000-000000000001','M10_A','M10 A','NOZZLE','23:00','Africa/Casablanca'),
 ('3a000000-0000-4000-8000-000000000002','38000000-0000-4000-8000-000000000002','M10_B','M10 B','NOZZLE','23:00','Africa/Casablanca');
SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','39000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','38000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','SUPER_ADMIN',true);
INSERT INTO products(id,client_id,code,name,product_type,unit_code) VALUES
 ('3b000000-0000-4000-8000-000000000001','38000000-0000-4000-8000-000000000001','M10_FUEL','M10 Fuel','FUEL','L'),
 ('3b000000-0000-4000-8000-000000000002','38000000-0000-4000-8000-000000000001','M10_ART','M10 Article','ARTICLE','EA'),
 ('3b000000-0000-4000-8000-000000000003','38000000-0000-4000-8000-000000000002','M10_FUEL_B','M10 Fuel B','FUEL','L');
INSERT INTO station_products(client_id,station_id,product_id) VALUES
 ('38000000-0000-4000-8000-000000000001','3a000000-0000-4000-8000-000000000001','3b000000-0000-4000-8000-000000000001'),
 ('38000000-0000-4000-8000-000000000001','3a000000-0000-4000-8000-000000000001','3b000000-0000-4000-8000-000000000002'),
 ('38000000-0000-4000-8000-000000000002','3a000000-0000-4000-8000-000000000002','3b000000-0000-4000-8000-000000000003');
INSERT INTO station_fuel_variance_thresholds(client_id,station_id,product_id,max_abs_variance,reason,updated_by)
VALUES('38000000-0000-4000-8000-000000000001','3a000000-0000-4000-8000-000000000001',
 '3b000000-0000-4000-8000-000000000001',25.500,'Client operations approval M10 test','39000000-0000-4000-8000-000000000001');
INSERT INTO station_cash_card_variance_thresholds
  (client_id,station_id,currency_code,max_abs_cash_variance,max_abs_card_variance,reason,updated_by)
VALUES('38000000-0000-4000-8000-000000000001','3a000000-0000-4000-8000-000000000001',
  'MAD',10.00,2.50,'Client operations approval M10 cash/card test','39000000-0000-4000-8000-000000000001');
DO $$ BEGIN
  IF (SELECT max_abs_variance FROM station_fuel_variance_thresholds WHERE product_id='3b000000-0000-4000-8000-000000000001')<>25.500 THEN
    RAISE EXCEPTION 'fuel variance tolerance did not persist at product precision';
  END IF;
  BEGIN
    INSERT INTO station_fuel_variance_thresholds(client_id,station_id,product_id,max_abs_variance,reason,updated_by)
    VALUES('38000000-0000-4000-8000-000000000001','3a000000-0000-4000-8000-000000000001',
      '3b000000-0000-4000-8000-000000000002',1,'Not a fuel product','39000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'article variance tolerance was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'variance thresholds are only supported for assigned fuel products' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM station_cash_card_variance_thresholds WHERE station_id='3a000000-0000-4000-8000-000000000001'
    AND currency_code='MAD' AND max_abs_cash_variance=10 AND max_abs_card_variance=2.50) THEN
    RAISE EXCEPTION 'cash/card currency-scoped tolerances did not persist';
  END IF;
END $$;
SELECT set_config('app.actor_id','39000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','38000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.role','OWNER',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM station_fuel_variance_thresholds)<>0 THEN
    RAISE EXCEPTION 'another client fuel variance policy was visible';
  END IF;
  IF (SELECT count(*) FROM station_cash_card_variance_thresholds)<>0 THEN
    RAISE EXCEPTION 'another client cash/card variance policy was visible';
  END IF;
  INSERT INTO station_cash_card_variance_thresholds
    (client_id,station_id,currency_code,max_abs_cash_variance,max_abs_card_variance,reason,updated_by)
  VALUES('38000000-0000-4000-8000-000000000002','3a000000-0000-4000-8000-000000000002',
    'MAD',5.00,NULL,'Client B cash tolerance','39000000-0000-4000-8000-000000000002');
  INSERT INTO station_fuel_variance_thresholds(client_id,station_id,product_id,max_abs_variance,reason,updated_by)
  VALUES('38000000-0000-4000-8000-000000000002','3a000000-0000-4000-8000-000000000002',
    '3b000000-0000-4000-8000-000000000003',10,'Client B approval','39000000-0000-4000-8000-000000000002');
  IF (SELECT count(*) FROM station_fuel_variance_thresholds)<>1 THEN
    RAISE EXCEPTION 'client owner could not read its own variance policy';
  END IF;
  BEGIN
    INSERT INTO station_fuel_variance_thresholds(client_id,station_id,product_id,max_abs_variance,reason,updated_by)
    VALUES('38000000-0000-4000-8000-000000000002','3a000000-0000-4000-8000-000000000002',
      '3b000000-0000-4000-8000-000000000003',11,'Forged actor','39000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'variance policy accepted a forged updater actor';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO station_cash_card_variance_thresholds
      (client_id,station_id,currency_code,max_abs_cash_variance,reason,updated_by)
    VALUES('38000000-0000-4000-8000-000000000002','3a000000-0000-4000-8000-000000000002',
      'MAD',6.00,'Forged actor','39000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'cash/card policy accepted a forged updater actor';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    IF SQLERRM='cash/card policy accepted a forged updater actor' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
