-- Rollback-only coverage for consolidated daily reports and sale/invoice export deduplication.
BEGIN;
INSERT INTO clients (id,name,code) VALUES
 ('15000000-0000-4000-8000-000000000001','M5 Report Test','M5_REPORT'),
 ('15000000-0000-4000-8000-000000000002','M5 Other Client','M5_OTHER');
INSERT INTO app_users (id,auth_subject,email,display_name,is_super_admin) VALUES
 ('25000000-0000-4000-8000-000000000001','m5-report-admin','m5-report-admin@example.invalid','M5 Report Admin',true),
 ('25000000-0000-4000-8000-000000000002','m5-other-owner','m5-other-owner@example.invalid','M5 Other Owner',false);
INSERT INTO client_memberships (client_id,user_id,role) VALUES
 ('15000000-0000-4000-8000-000000000002','25000000-0000-4000-8000-000000000002','OWNER');
INSERT INTO stations (id,client_id,code,name,meter_mode,closing_cutoff,time_zone) VALUES
 ('35000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','M5_ST1','M5 Station','NOZZLE','23:00','Africa/Casablanca'),
 ('35000000-0000-4000-8000-000000000002','15000000-0000-4000-8000-000000000002','M5_ST2','M5 Other Station','NOZZLE','23:00','Africa/Casablanca');
SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','25000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','15000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','SUPER_ADMIN',true);

INSERT INTO products (id,client_id,code,name,product_type,unit_code) VALUES
 ('45000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','M5_ART','M5 Article','ARTICLE','EA'),
 ('45000000-0000-4000-8000-000000000002','15000000-0000-4000-8000-000000000001','M5_FUEL','M5 Fuel','FUEL','L');
INSERT INTO station_products (client_id,station_id,product_id) VALUES
 ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','45000000-0000-4000-8000-000000000001'),
 ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','45000000-0000-4000-8000-000000000002');
INSERT INTO station_equipment (id,client_id,station_id,code,kind) VALUES
 ('65000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','M5_PUMP','PUMP');
INSERT INTO station_equipment (id,client_id,station_id,code,kind,product_id,parent_equipment_id) VALUES
 ('65000000-0000-4000-8000-000000000002','15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','M5_NOZZLE','NOZZLE','45000000-0000-4000-8000-000000000002','65000000-0000-4000-8000-000000000001');
INSERT INTO meter_reading_batches (id,client_id,station_id,business_date,status,submitted_by,validated_by,validated_at) VALUES
 ('85000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','2026-10-14','VALIDATED','25000000-0000-4000-8000-000000000001','25000000-0000-4000-8000-000000000001',now());
INSERT INTO meter_readings (id,client_id,station_id,batch_id,equipment_id,initial_index,final_index,volume) VALUES
 ('95000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','85000000-0000-4000-8000-000000000001','65000000-0000-4000-8000-000000000002',100,200,100);
INSERT INTO station_day_inputs (id,client_id,station_id,business_date,cash_total,card_total,currency_code,status,entered_by,validated_by,validated_at) VALUES
 ('a5000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','2026-10-14',50,40,'MAD','VALIDATED','25000000-0000-4000-8000-000000000001','25000000-0000-4000-8000-000000000001',now());
INSERT INTO station_day_closings (client_id,station_id,business_date,meter_reading_batch_id,station_day_input_id,snapshot,closed_by) VALUES
 ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','2026-10-14','85000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000001','{}'::jsonb,'25000000-0000-4000-8000-000000000001');

DO $$ DECLARE daily jsonb; first_sale uuid; second_sale uuid; credit_sale uuid; customer_id uuid; payment_id uuid; financial jsonb;
  sale_count integer; sale_amount numeric; invoice_count integer; invoice_amount numeric; payment_count integer; payment_amount numeric;
BEGIN
  WITH by_product AS (
    SELECT batch.client_id,batch.station_id,COALESCE(allocation.product_id,equipment.product_id) product_id,
      product.code product_code,product.name product_name,product.unit_code,
      CASE WHEN batch.status='VALIDATED' THEN sum(CASE WHEN station.meter_mode='PUMP_TOTALIZER' THEN allocation.volume ELSE reading.volume END) END volume
    FROM meter_reading_batches batch JOIN stations station ON station.client_id=batch.client_id AND station.id=batch.station_id
    JOIN meter_readings reading ON reading.client_id=batch.client_id AND reading.station_id=batch.station_id AND reading.batch_id=batch.id
    JOIN station_equipment equipment ON equipment.client_id=reading.client_id AND equipment.station_id=reading.station_id AND equipment.id=reading.equipment_id
    LEFT JOIN meter_reading_product_allocations allocation ON allocation.client_id=reading.client_id AND allocation.station_id=reading.station_id AND allocation.reading_id=reading.id
    JOIN products product ON product.client_id=batch.client_id AND product.id=COALESCE(allocation.product_id,equipment.product_id)
    WHERE batch.client_id='15000000-0000-4000-8000-000000000001' AND batch.business_date='2026-10-14'
    GROUP BY batch.client_id,batch.station_id,batch.status,station.meter_mode,COALESCE(allocation.product_id,equipment.product_id),product.code,product.name,product.unit_code
  ), by_station AS (
    SELECT client_id,station_id,jsonb_agg(jsonb_build_object('productId',product_id,'code',product_code,'name',product_name,'unitCode',unit_code,'volume',volume)) volumes
    FROM by_product GROUP BY client_id,station_id
  ), tank_totals AS (
    SELECT station.client_id,station.id station_id,count(tank.id) active_tanks,count(dip.id) FILTER (WHERE inputs.status='VALIDATED') validated_dips
    FROM stations station LEFT JOIN station_equipment tank ON tank.client_id=station.client_id AND tank.station_id=station.id AND tank.kind='TANK' AND tank.retired_at IS NULL
    LEFT JOIN station_day_inputs inputs ON inputs.client_id=station.client_id AND inputs.station_id=station.id AND inputs.business_date='2026-10-14'
    LEFT JOIN station_day_dips dip ON dip.client_id=inputs.client_id AND dip.station_id=inputs.station_id AND dip.day_input_id=inputs.id AND dip.tank_id=tank.id
    WHERE station.client_id='15000000-0000-4000-8000-000000000001' GROUP BY station.client_id,station.id
  )
  SELECT to_jsonb(report) INTO daily FROM (
    SELECT station.id AS "stationId",station.code AS "stationCode",station.name AS "stationName",station.meter_mode AS "meterMode",
      COALESCE(batch.status,'NOT_ENTERED') AS "meterStatus",COALESCE(volume.volumes,'[]'::jsonb) AS volumes,
      COALESCE(inputs.status,'NOT_ENTERED') AS "inputsStatus",inputs.cash_total AS "cashTotal",inputs.card_total AS "cardTotal",inputs.currency_code AS "collectionsCurrencyCode",
      CASE WHEN tanks.active_tanks=0 THEN 'NO_TANKS' WHEN inputs.status<>'VALIDATED' OR tanks.validated_dips<tanks.active_tanks THEN 'INCOMPLETE' ELSE 'VALIDATED' END AS "dipStatus",
      close.id IS NOT NULL AS "isClosed",close.closed_at AS "closedAt"
    FROM stations station LEFT JOIN meter_reading_batches batch ON batch.client_id=station.client_id AND batch.station_id=station.id AND batch.business_date='2026-10-14'
    LEFT JOIN by_station volume ON volume.client_id=station.client_id AND volume.station_id=station.id
    LEFT JOIN station_day_inputs inputs ON inputs.client_id=station.client_id AND inputs.station_id=station.id AND inputs.business_date='2026-10-14'
    LEFT JOIN tank_totals tanks ON tanks.client_id=station.client_id AND tanks.station_id=station.id
    LEFT JOIN station_day_closings close ON close.client_id=station.client_id AND close.station_id=station.id AND close.business_date='2026-10-14'
    WHERE station.client_id='15000000-0000-4000-8000-000000000001'
  ) report;
  IF daily->>'meterStatus'<>'VALIDATED' OR daily->>'cashTotal'<>'50.00' OR daily->>'cardTotal'<>'40.00'
     OR daily->>'collectionsCurrencyCode'<>'MAD'
     OR daily->>'isClosed'<>'true' OR daily->'volumes'->0->>'volume'<>'100.000' THEN
    RAISE EXCEPTION 'consolidated station-day report did not match the hand-computed example: %',daily;
  END IF;

  INSERT INTO customers (id,client_id,code,display_name,created_by) VALUES
    ('55000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','M5_CUST','M5 Customer','25000000-0000-4000-8000-000000000001') RETURNING id INTO customer_id;
  INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',customer_id,'2026-10-14','MAD','25000000-0000-4000-8000-000000000001') RETURNING id INTO first_sale;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',first_sale,1,'45000000-0000-4000-8000-000000000001','Invoiced','EA',1,100,0);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',first_sale,'CASH',100,'25000000-0000-4000-8000-000000000001');
  UPDATE sales_transactions SET subtotal=100,total=100,status='POSTED',posted_by='25000000-0000-4000-8000-000000000001',posted_at=now() WHERE id=first_sale;
  INSERT INTO issued_invoices (client_id,station_id,sale_id,customer_id,customer_snapshot,invoice_number,currency_code,business_date,subtotal,tax_total,total,legal_snapshot,lines_snapshot,issued_by)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',first_sale,customer_id,
    '{"code":"M5_CUST","displayName":"M5 Customer"}','M5-0001','MAD','2026-10-14',100,0,100,'{}','[]','25000000-0000-4000-8000-000000000001');
  INSERT INTO sales_transactions (client_id,station_id,business_date,currency_code,created_by)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','2026-10-14','MAD','25000000-0000-4000-8000-000000000001') RETURNING id INTO second_sale;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',second_sale,1,'45000000-0000-4000-8000-000000000001','No invoice','EA',1,50,0);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',second_sale,'CASH',50,'25000000-0000-4000-8000-000000000001');
  UPDATE sales_transactions SET subtotal=50,total=50,status='POSTED',posted_by='25000000-0000-4000-8000-000000000001',posted_at=now() WHERE id=second_sale;
  INSERT INTO customer_payments (client_id,customer_id,currency_code,amount,payment_method,received_by)
  VALUES ('15000000-0000-4000-8000-000000000001',customer_id,'MAD',25,'CASH','25000000-0000-4000-8000-000000000001') RETURNING id INTO payment_id;
  INSERT INTO customer_credit_accounts (client_id,customer_id,credit_limit,updated_by)
  VALUES ('15000000-0000-4000-8000-000000000001',customer_id,150,'25000000-0000-4000-8000-000000000001');
  INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',customer_id,'2026-10-14','MAD',
    '25000000-0000-4000-8000-000000000001') RETURNING id INTO credit_sale;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',credit_sale,1,
    '45000000-0000-4000-8000-000000000001','Credit sale','EA',1,40,0);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('15000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',credit_sale,'CREDIT',40,
    '25000000-0000-4000-8000-000000000001');
  UPDATE sales_transactions SET subtotal=40,total=40,status='POSTED',posted_by='25000000-0000-4000-8000-000000000001',posted_at=now()
  WHERE id=credit_sale;
  INSERT INTO customer_payment_allocations (client_id,payment_id,sale_id,amount,allocated_by)
  VALUES ('15000000-0000-4000-8000-000000000001',payment_id,credit_sale,10,'25000000-0000-4000-8000-000000000001');

  WITH sale_tenders AS (
    SELECT sale_id,COALESCE(sum(amount) FILTER (WHERE tender_type='CREDIT'),0) credit_amount
    FROM sales_transaction_tenders WHERE client_id='15000000-0000-4000-8000-000000000001' GROUP BY sale_id
  ), sale_balances AS (
    SELECT sale_id,COALESCE(sum(amount_delta),0) current_balance FROM customer_credit_movements
    WHERE client_id='15000000-0000-4000-8000-000000000001' AND sale_id IS NOT NULL GROUP BY sale_id
  )
  SELECT jsonb_build_object('postedSalesToday',sum(sale.total),'creditSalesToday',sum(tender.credit_amount),
    'currentOpenCreditThroughDate',sum(balance.current_balance)) INTO financial
  FROM sales_transactions sale LEFT JOIN sale_tenders tender ON tender.sale_id=sale.id
    LEFT JOIN sale_balances balance ON balance.sale_id=sale.id
  WHERE sale.client_id='15000000-0000-4000-8000-000000000001' AND sale.station_id='35000000-0000-4000-8000-000000000001'
    AND sale.currency_code='MAD' AND sale.status='POSTED' AND sale.business_date<='2026-10-14';
  IF financial->>'postedSalesToday'<>'190.00' OR financial->>'creditSalesToday'<>'40.00'
    OR financial->>'currentOpenCreditThroughDate'<>'30.00' THEN
    RAISE EXCEPTION 'sales report totals should separate posted sales, credit sales, and current receivable: %',financial;
  END IF;

  WITH export_rows AS (
    SELECT 'SALE' type,sale.total amount FROM sales_transactions sale
    WHERE sale.client_id='15000000-0000-4000-8000-000000000001' AND sale.status='POSTED'
      AND NOT EXISTS (SELECT 1 FROM issued_invoices invoice WHERE invoice.client_id=sale.client_id AND invoice.sale_id=sale.id)
    UNION ALL
    SELECT 'INVOICE',invoice.total FROM issued_invoices invoice WHERE invoice.client_id='15000000-0000-4000-8000-000000000001'
    UNION ALL
    SELECT 'CREDIT_NOTE',-note.amount FROM issued_credit_notes note WHERE note.client_id='15000000-0000-4000-8000-000000000001'
    UNION ALL
    SELECT 'CUSTOMER_PAYMENT',payment.amount FROM customer_payments payment WHERE payment.client_id='15000000-0000-4000-8000-000000000001'
    UNION ALL
    SELECT 'PURCHASE_RECEIPT_LINE',round(line.quantity*line.unit_cost,2) FROM purchase_receipts receipt
      JOIN purchase_receipt_lines line ON line.client_id=receipt.client_id AND line.station_id=receipt.station_id AND line.receipt_id=receipt.id
      WHERE receipt.client_id='15000000-0000-4000-8000-000000000001' AND receipt.status='POSTED'
  )
  SELECT count(*) FILTER(WHERE type='SALE'),COALESCE(sum(amount) FILTER(WHERE type='SALE'),0),
    count(*) FILTER(WHERE type='INVOICE'),COALESCE(sum(amount) FILTER(WHERE type='INVOICE'),0),
    count(*) FILTER(WHERE type='CUSTOMER_PAYMENT'),COALESCE(sum(amount) FILTER(WHERE type='CUSTOMER_PAYMENT'),0)
  INTO sale_count,sale_amount,invoice_count,invoice_amount,payment_count,payment_amount FROM export_rows;
  IF sale_count<>2 OR sale_amount<>90 OR invoice_count<>1 OR invoice_amount<>100 OR payment_count<>1 OR payment_amount<>25 THEN
    RAISE EXCEPTION 'accounting export double counted a sale or combined payment with sales';
  END IF;
END
$$;

SELECT set_config('app.actor_id','25000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','15000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.role','OWNER',true);
DO $$
BEGIN
  IF (SELECT count(*) FROM stations)<>1 OR (SELECT count(*) FROM sales_transactions)<>0
    OR (SELECT count(*) FROM issued_invoices)<>0 OR (SELECT count(*) FROM customer_payments)<>0
    OR (SELECT count(*) FROM purchase_receipts)<>0 THEN
    RAISE EXCEPTION 'report/export source tables exposed another client data';
  END IF;
END
$$;
ROLLBACK;
