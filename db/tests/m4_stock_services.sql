-- Rollback-only coverage for receipts, immutable stock and service component consumption.
BEGIN;
INSERT INTO clients (id,name,code) VALUES ('14000000-0000-4000-8000-000000000001','M4 Stock Test','M4_STOCK');
INSERT INTO app_users (id,auth_subject,email,display_name,is_super_admin) VALUES
 ('24000000-0000-4000-8000-000000000001','m4-stock-admin','m4-stock-admin@example.invalid','M4 Stock Admin',true);
INSERT INTO stations (id,client_id,code,name,meter_mode,closing_cutoff,time_zone) VALUES
 ('34000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','M4_ST1','M4 Station','NOZZLE','23:00','Africa/Casablanca');
SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','24000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','14000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','SUPER_ADMIN',true);

INSERT INTO products (id,client_id,code,name,product_type,unit_code) VALUES
 ('44000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','M4_FUEL','M4 Fuel','FUEL','L'),
 ('44000000-0000-4000-8000-000000000002','14000000-0000-4000-8000-000000000001','M4_ART','M4 Article','ARTICLE','EA'),
 ('44000000-0000-4000-8000-000000000003','14000000-0000-4000-8000-000000000001','M4_SERVICE','M4 Service','SERVICE','EA'),
 ('44000000-0000-4000-8000-000000000004','14000000-0000-4000-8000-000000000001','M4_COMPONENT','M4 Component','ARTICLE','EA');
INSERT INTO station_products (client_id,station_id,product_id) VALUES
 ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000001'),
 ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000002'),
 ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000003'),
 ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000004');
INSERT INTO station_equipment (id,client_id,station_id,code,kind,product_id) VALUES
 ('64000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','M4_TANK','TANK','44000000-0000-4000-8000-000000000001');
INSERT INTO station_equipment (id,client_id,station_id,code,kind) VALUES
 ('64000000-0000-4000-8000-000000000002','14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','M4_PUMP','PUMP');
INSERT INTO station_equipment (id,client_id,station_id,code,kind,product_id,parent_equipment_id) VALUES
 ('64000000-0000-4000-8000-000000000003','14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','M4_NOZZLE','NOZZLE','44000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002');
INSERT INTO suppliers (id,client_id,code,name,created_by) VALUES
 ('54000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','M4_SUP','M4 Supplier','24000000-0000-4000-8000-000000000001');

DO $$
DECLARE receipt_id uuid; article_line uuid; sale_id uuid;
BEGIN
  INSERT INTO purchase_receipts (client_id,station_id,supplier_id,business_date,currency_code,created_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001','2026-10-14','MAD','24000000-0000-4000-8000-000000000001')
  RETURNING id INTO receipt_id;
  INSERT INTO purchase_receipt_lines (client_id,station_id,receipt_id,product_id,quantity,unit_cost)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',receipt_id,
    '44000000-0000-4000-8000-000000000002',10,3) RETURNING id INTO article_line;
  INSERT INTO purchase_receipt_lines (client_id,station_id,receipt_id,product_id,tank_id,quantity,unit_cost)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',receipt_id,
    '44000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000001',1000,10);
  UPDATE purchase_receipts SET status='POSTED',posted_by='24000000-0000-4000-8000-000000000001',posted_at=now() WHERE id=receipt_id;

  INSERT INTO sales_transactions (client_id,station_id,business_date,currency_code,created_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','2026-10-14','MAD',
    '24000000-0000-4000-8000-000000000001') RETURNING id INTO sale_id;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',sale_id,1,
    '44000000-0000-4000-8000-000000000002','Article sale','EA',2,3,0);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',sale_id,'CASH',6,
    '24000000-0000-4000-8000-000000000001');
  UPDATE sales_transactions SET subtotal=6,total=6,status='POSTED',posted_by='24000000-0000-4000-8000-000000000001',posted_at=now() WHERE id=sale_id;

  INSERT INTO service_components (client_id,station_id,service_product_id,component_product_id,quantity_per_service,updated_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000003','44000000-0000-4000-8000-000000000004',1,'24000000-0000-4000-8000-000000000001');
  INSERT INTO sales_transactions (client_id,station_id,business_date,currency_code,created_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','2026-10-14','MAD',
    '24000000-0000-4000-8000-000000000001') RETURNING id INTO sale_id;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',sale_id,1,
    '44000000-0000-4000-8000-000000000003','Workshop service','EA',2,20,0);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',sale_id,'CASH',40,
    '24000000-0000-4000-8000-000000000001');
  UPDATE sales_transactions SET subtotal=40,total=40,status='POSTED',posted_by='24000000-0000-4000-8000-000000000001',posted_at=now() WHERE id=sale_id;

  IF (SELECT sum(quantity_delta) FROM stock_movements WHERE product_id='44000000-0000-4000-8000-000000000002')<>8 THEN
    RAISE EXCEPTION 'article on-hand ledger did not include receipt and sale';
  END IF;
  IF (SELECT sum(quantity_delta) FROM stock_movements WHERE product_id='44000000-0000-4000-8000-000000000004')<>-2 THEN
    RAISE EXCEPTION 'service component consumption was not recorded separately';
  END IF;

  INSERT INTO tank_calibrations (id,client_id,station_id,tank_id,effective_from,created_by)
  VALUES ('74000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000001','2026-10-01',
    '24000000-0000-4000-8000-000000000001');
  INSERT INTO tank_calibration_points (client_id,station_id,calibration_id,depth_mm,volume_liters) VALUES
   ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001',0,0),
   ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001',1000,1000);
  UPDATE tank_calibrations SET status='ACTIVE',activated_by='24000000-0000-4000-8000-000000000001',activated_at=now()
    WHERE id='74000000-0000-4000-8000-000000000001';
  INSERT INTO meter_reading_batches (id,client_id,station_id,business_date,status,submitted_by,validated_by,validated_at)
  VALUES ('84000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001','2026-10-14','VALIDATED','24000000-0000-4000-8000-000000000001',
    '24000000-0000-4000-8000-000000000001',now());
  INSERT INTO meter_readings (id,client_id,station_id,batch_id,equipment_id,initial_index,final_index,volume)
  VALUES ('94000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000003',0,200,200);
  INSERT INTO station_day_inputs (id,client_id,station_id,business_date,entered_by)
  VALUES ('a4000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001','2026-10-14','24000000-0000-4000-8000-000000000001');
  INSERT INTO station_day_dips (client_id,station_id,day_input_id,tank_id,product_depth_mm,water_depth_mm,recorded_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000001',900,100,
    '24000000-0000-4000-8000-000000000001');
  UPDATE station_day_inputs SET status='VALIDATED',validated_by='24000000-0000-4000-8000-000000000001',validated_at=now()
    WHERE id='a4000000-0000-4000-8000-000000000001';
  IF (SELECT sum(quantity_delta) FROM stock_movements WHERE product_id='44000000-0000-4000-8000-000000000001')
       -(SELECT sum(volume) FROM meter_readings WHERE id='94000000-0000-4000-8000-000000000001')<>800
     OR tank_volume_at_depth('74000000-0000-4000-8000-000000000001',900)
       -tank_volume_at_depth('74000000-0000-4000-8000-000000000001',100)<>800 THEN
    RAISE EXCEPTION 'fuel stock/dip reconciliation did not calculate 800 litres';
  END IF;
  INSERT INTO station_fuel_variance_thresholds(client_id,station_id,product_id,max_abs_variance,reason,updated_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',9,'Test limit for review flag','24000000-0000-4000-8000-000000000001');
  INSERT INTO station_day_inputs(id,client_id,station_id,business_date,entered_by)
  VALUES ('a4000000-0000-4000-8000-000000000002','14000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001','2026-10-15','24000000-0000-4000-8000-000000000001');
  INSERT INTO station_day_dips(client_id,station_id,day_input_id,tank_id,product_depth_mm,water_depth_mm,recorded_by)
  VALUES ('14000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000002','64000000-0000-4000-8000-000000000001',910,100,
    '24000000-0000-4000-8000-000000000001');
  UPDATE station_day_inputs SET status='VALIDATED',validated_by='24000000-0000-4000-8000-000000000001',validated_at=now()
    WHERE id='a4000000-0000-4000-8000-000000000002';
  IF (SELECT abs(
       (tank_volume_at_depth('74000000-0000-4000-8000-000000000001',910)-tank_volume_at_depth('74000000-0000-4000-8000-000000000001',100))
       -((SELECT sum(quantity_delta) FROM stock_movements WHERE product_id='44000000-0000-4000-8000-000000000001')
         -(SELECT sum(volume) FROM meter_readings WHERE id='94000000-0000-4000-8000-000000000001'))
       ) <= max_abs_variance FROM station_fuel_variance_thresholds
       WHERE product_id='44000000-0000-4000-8000-000000000001') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'fuel variance outside the configured tolerance was not flagged';
  END IF;
  UPDATE station_fuel_variance_thresholds SET max_abs_variance=10,reason='Inclusive tolerance boundary'
    WHERE product_id='44000000-0000-4000-8000-000000000001';
  IF (SELECT abs(
       (tank_volume_at_depth('74000000-0000-4000-8000-000000000001',910)-tank_volume_at_depth('74000000-0000-4000-8000-000000000001',100))
       -((SELECT sum(quantity_delta) FROM stock_movements WHERE product_id='44000000-0000-4000-8000-000000000001')
         -(SELECT sum(volume) FROM meter_readings WHERE id='94000000-0000-4000-8000-000000000001'))
       ) <= max_abs_variance FROM station_fuel_variance_thresholds
       WHERE product_id='44000000-0000-4000-8000-000000000001') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'fuel variance equal to the configured tolerance was incorrectly flagged';
  END IF;
  BEGIN
    UPDATE stock_movements SET quantity_delta=100 WHERE source_id=article_line;
    RAISE EXCEPTION 'stock ledger mutation was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  WHEN raise_exception THEN
    IF SQLERRM<>'stock movements are append-only' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE purchase_receipt_lines SET quantity=12 WHERE id=article_line;
    RAISE EXCEPTION 'posted receipt line mutation was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'posted purchase receipts are immutable' THEN RAISE; END IF;
  END;
END
$$;
ROLLBACK;
