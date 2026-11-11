-- Rollback-only coverage for M3 immutable sales, tenant-scoped credit and payments.
BEGIN;

INSERT INTO clients (id,name,code) VALUES
 ('13000000-0000-4000-8000-000000000001','M3 Credit Test','M3_CREDIT'),
 ('13000000-0000-4000-8000-000000000002','M3 Other Tenant','M3_OTHER');
INSERT INTO app_users (id,auth_subject,email,display_name,is_super_admin) VALUES
 ('23000000-0000-4000-8000-000000000001','m3-credit-admin','m3-credit-admin@example.invalid','M3 Credit Admin',true),
 ('23000000-0000-4000-8000-000000000002','m3-other-cashier','m3-other-cashier@example.invalid','M3 Other Cashier',false),
 ('23000000-0000-4000-8000-000000000003','m3-credit-accountant','m3-credit-accountant@example.invalid','M3 Credit Accountant',false),
 ('23000000-0000-4000-8000-000000000004','m3-credit-cashier','m3-credit-cashier@example.invalid','M3 Credit Cashier',false),
 ('23000000-0000-4000-8000-000000000005','m3-credit-owner','m3-credit-owner@example.invalid','M3 Credit Owner',false);
INSERT INTO client_memberships (client_id,user_id,role) VALUES
 ('13000000-0000-4000-8000-000000000002','23000000-0000-4000-8000-000000000002','CASHIER'),
 ('13000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000003','ACCOUNTANT'),
 ('13000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000004','CASHIER'),
 ('13000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000005','OWNER');
INSERT INTO stations (id,client_id,code,name,meter_mode,closing_cutoff,time_zone) VALUES
 ('33000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','M3_ST1','M3 Station','NOZZLE','23:00','Africa/Casablanca');
INSERT INTO station_memberships (client_id,station_id,user_id) VALUES
 ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000004'),
 ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000005');

SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','23000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','13000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','SUPER_ADMIN',true);

INSERT INTO products (id,client_id,code,name,product_type,unit_code) VALUES
 ('43000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','M3_FUEL','M3 Fuel','FUEL','L'),
 ('43000000-0000-4000-8000-000000000002','13000000-0000-4000-8000-000000000001','M3_ART','M3 Article','ARTICLE','EA');
INSERT INTO station_products (client_id,station_id,product_id) VALUES
 ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','43000000-0000-4000-8000-000000000001'),
 ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','43000000-0000-4000-8000-000000000002');
INSERT INTO fuel_tariffs (client_id,station_id,product_id,unit_price,valid_from,created_by)
VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',10,'2020-01-01T00:00:00Z','23000000-0000-4000-8000-000000000001');
INSERT INTO customers (id,client_id,code,display_name,contact_email,created_by) VALUES
 ('53000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','M3_CUST','Credit Customer','m3-customer@example.invalid','23000000-0000-4000-8000-000000000001');
INSERT INTO customer_credit_accounts (client_id,customer_id,credit_limit,payment_terms_days,updated_by) VALUES
 ('13000000-0000-4000-8000-000000000001','53000000-0000-4000-8000-000000000001',150,30,'23000000-0000-4000-8000-000000000001');

SELECT set_config('app.actor_id','23000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','13000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.role','CASHIER',true);
DO $$
BEGIN
  IF (SELECT count(*) FROM customers)<>0 OR (SELECT count(*) FROM sales_transactions)<>0 THEN
    RAISE EXCEPTION 'M3 tables exposed another tenant rows';
  END IF;
END
$$;
SELECT set_config('app.actor_id','23000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','13000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','SUPER_ADMIN',true);

DO $$
DECLARE sale_id uuid;
BEGIN
  INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001','2026-10-14','MAD','23000000-0000-4000-8000-000000000001')
  RETURNING id INTO sale_id;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_code,tax_rate_percent)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,1,
    '43000000-0000-4000-8000-000000000001','10 L Fuel','L',10,10,'TEST_RATE',10);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,'CREDIT',110,'23000000-0000-4000-8000-000000000001');
  UPDATE sales_transactions SET subtotal=100,tax_total=10,total=110,status='POSTED',
    posted_by='23000000-0000-4000-8000-000000000001',posted_at=now() WHERE id=sale_id;
  IF (SELECT credit_terms_days_snapshot FROM sales_transactions WHERE id=sale_id)<>30
     OR (SELECT credit_due_date FROM sales_transactions WHERE id=sale_id)<>'2026-11-13'::date
     OR (SELECT jsonb_array_length(credit_schedule_snapshot) FROM sales_transactions WHERE id=sale_id)<>1
     OR (SELECT (credit_schedule_snapshot->0->>'amount')::numeric FROM sales_transactions WHERE id=sale_id)<>110 THEN
    RAISE EXCEPTION 'credit sale did not snapshot the configured payment terms and due date';
  END IF;
  UPDATE customer_credit_accounts SET payment_terms_days=0,updated_by='23000000-0000-4000-8000-000000000001'
    WHERE client_id='13000000-0000-4000-8000-000000000001' AND customer_id='53000000-0000-4000-8000-000000000001';
  IF (SELECT credit_due_date FROM sales_transactions WHERE id=sale_id)<>'2026-11-13'::date THEN
    RAISE EXCEPTION 'later account terms edit rewrote a posted sale due date';
  END IF;

EXCEPTION WHEN OTHERS THEN
  RAISE;
END
$$;

SAVEPOINT m3_installment_schedule;
UPDATE customer_credit_accounts SET credit_limit=500,updated_by='23000000-0000-4000-8000-000000000001'
WHERE client_id='13000000-0000-4000-8000-000000000001' AND customer_id='53000000-0000-4000-8000-000000000001';
DO $$
DECLARE sale_id uuid; payment_id uuid; invoice_id uuid;
BEGIN
  INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by,credit_schedule_snapshot)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001','2026-10-14','MAD','23000000-0000-4000-8000-000000000001',
    '[{"dueDate":"2026-10-20","amount":"20.00"},{"dueDate":"2026-11-20","amount":"20.00"}]'::jsonb)
  RETURNING id INTO sale_id;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,1,
    '43000000-0000-4000-8000-000000000002','Scheduled article sale','EA',1,40,0);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,'CREDIT',40,
    '23000000-0000-4000-8000-000000000001');
  UPDATE sales_transactions SET subtotal=40,total=40,status='POSTED',posted_by='23000000-0000-4000-8000-000000000001',posted_at=now()
    WHERE id=sale_id;
  IF (SELECT jsonb_array_length(credit_schedule_snapshot) FROM sales_transactions WHERE id=sale_id)<>2
    OR (SELECT credit_due_date FROM sales_transactions WHERE id=sale_id)<>'2026-10-20'::date
    OR (SELECT credit_terms_days_snapshot FROM sales_transactions WHERE id=sale_id) IS NOT NULL THEN
    RAISE EXCEPTION 'custom installment schedule was not snapshotted as the transaction terms';
  END IF;
  INSERT INTO customer_payments (client_id,customer_id,currency_code,amount,payment_method,received_by)
  VALUES ('13000000-0000-4000-8000-000000000001','53000000-0000-4000-8000-000000000001','MAD',25,'CASH',
    '23000000-0000-4000-8000-000000000001') RETURNING id INTO payment_id;
  INSERT INTO customer_payment_allocations (client_id,payment_id,sale_id,amount,allocated_by,installment_number)
  VALUES ('13000000-0000-4000-8000-000000000001',payment_id,sale_id,16,
    '23000000-0000-4000-8000-000000000001',1);
  BEGIN
    INSERT INTO customer_payment_allocations (client_id,payment_id,sale_id,amount,allocated_by)
    VALUES ('13000000-0000-4000-8000-000000000001',payment_id,sale_id,1,
      '23000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'sale-level and installment-specific allocations were mixed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'sale-level and installment-specific payment allocations cannot be mixed' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO customer_payment_allocations (client_id,payment_id,sale_id,amount,allocated_by,installment_number)
    VALUES ('13000000-0000-4000-8000-000000000001',payment_id,sale_id,5,
      '23000000-0000-4000-8000-000000000001',1);
    RAISE EXCEPTION 'installment over-allocation was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'payment allocation exceeds the installment balance' THEN RAISE; END IF;
  END;
  INSERT INTO client_invoice_profiles (client_id,status,legal_configuration,approval_statement,approval_reference,
    approved_by,approved_at,updated_by)
  VALUES ('13000000-0000-4000-8000-000000000001','APPROVED','{}','Temporary rollback test approval','M3_TEMP',
    '23000000-0000-4000-8000-000000000001',now(),'23000000-0000-4000-8000-000000000001');
  INSERT INTO issued_invoices (client_id,station_id,sale_id,customer_id,customer_snapshot,invoice_number,currency_code,business_date,
    subtotal,tax_total,total,legal_snapshot,lines_snapshot,issued_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,
    '53000000-0000-4000-8000-000000000001','{"displayName":"Credit Customer"}','INV-TEMP-SCHEDULE','MAD','2026-10-14',40,0,40,'{}','[]',
    '23000000-0000-4000-8000-000000000001') RETURNING id INTO invoice_id;
  BEGIN
    INSERT INTO issued_credit_notes (client_id,invoice_id,sale_id,customer_id,credit_note_number,amount,
      receivable_adjustment,reason,legal_snapshot,issued_by)
    VALUES ('13000000-0000-4000-8000-000000000001',invoice_id,sale_id,
      '53000000-0000-4000-8000-000000000001','CN-TEMP-SCHEDULE',1,1,'Ambiguous installment adjustment','{}',
      '23000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'credit-note receivable adjustment followed installment-specific payments';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'credit-note receivable adjustment is unavailable after installment-specific payments' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE sales_transactions SET credit_schedule_snapshot='[]'::jsonb WHERE id=sale_id;
    RAISE EXCEPTION 'posted installment schedule was mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'posted sales are immutable; use a credit note or a new transaction' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by,credit_schedule_snapshot)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
      '53000000-0000-4000-8000-000000000001','2026-10-14','MAD','23000000-0000-4000-8000-000000000001',
      '[{"dueDate":"2026-10-20","amount":"19.00"},{"dueDate":"2026-11-20","amount":"20.00"}]'::jsonb)
    RETURNING id INTO sale_id;
    INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,1,
      '43000000-0000-4000-8000-000000000002','Mismatched schedule test','EA',1,40,0);
    INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,'CREDIT',40,
      '23000000-0000-4000-8000-000000000001');
    UPDATE sales_transactions SET subtotal=40,total=40,status='POSTED',posted_by='23000000-0000-4000-8000-000000000001',posted_at=now()
      WHERE id=sale_id;
    RAISE EXCEPTION 'installment schedule with a mismatched total was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'installment amounts must equal the credit tender total' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by,credit_schedule_snapshot)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
      '53000000-0000-4000-8000-000000000001','2026-10-14','MAD','23000000-0000-4000-8000-000000000001',
      '[{"dueDate":"2026-11-20","amount":"20.00"},{"dueDate":"2026-10-20","amount":"20.00"}]'::jsonb)
    RETURNING id INTO sale_id;
    INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,1,
      '43000000-0000-4000-8000-000000000002','Out-of-order schedule test','EA',1,40,0);
    INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_id,'CREDIT',40,
      '23000000-0000-4000-8000-000000000001');
    UPDATE sales_transactions SET subtotal=40,total=40,status='POSTED',posted_by='23000000-0000-4000-8000-000000000001',posted_at=now()
      WHERE id=sale_id;
    RAISE EXCEPTION 'out-of-order installment schedule was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'installment dates must be valid, ordered, and not before the sale date' THEN RAISE; END IF;
  END;
END
$$;
ROLLBACK TO SAVEPOINT m3_installment_schedule;

DO $$
DECLARE payment_id uuid; v_sale_id uuid; over_limit_sale uuid;
BEGIN
  SELECT id INTO v_sale_id FROM sales_transactions WHERE client_id='13000000-0000-4000-8000-000000000001';
  INSERT INTO customer_payments (client_id,customer_id,currency_code,amount,payment_method,received_by)
  VALUES ('13000000-0000-4000-8000-000000000001','53000000-0000-4000-8000-000000000001','MAD',40,'CASH','23000000-0000-4000-8000-000000000001')
  RETURNING id INTO payment_id;
  INSERT INTO customer_payment_allocations (client_id,payment_id,sale_id,amount,allocated_by)
  VALUES ('13000000-0000-4000-8000-000000000001',payment_id,v_sale_id,40,'23000000-0000-4000-8000-000000000001');
  IF (SELECT sum(amount_delta) FROM customer_credit_movements AS m WHERE m.sale_id=v_sale_id) <> 70 THEN
    RAISE EXCEPTION 'credit ledger did not retain the expected 70 outstanding balance';
  END IF;
  PERFORM set_config('app.actor_id','23000000-0000-4000-8000-000000000004',true);
  PERFORM set_config('app.role','CASHIER',true);
  BEGIN
    INSERT INTO sales_transactions (client_id,station_id,business_date,currency_code,created_by)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','2026-10-14','MAD',
      '23000000-0000-4000-8000-000000000001') RETURNING id INTO over_limit_sale;
    INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',over_limit_sale,1,
      '43000000-0000-4000-8000-000000000001','Wrong tariff price','L',1,11,0);
    RAISE EXCEPTION 'a fuel sale price differing from the effective tariff was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'fuel sale price must match its effective station tariff' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO customer_payment_allocations (client_id,payment_id,sale_id,amount,allocated_by)
    VALUES ('13000000-0000-4000-8000-000000000001',payment_id,v_sale_id,71,'23000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'over-allocation of credit sale was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'payment allocation exceeds the outstanding credit sale balance' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
      '53000000-0000-4000-8000-000000000001','2026-10-14','MAD','23000000-0000-4000-8000-000000000001')
    RETURNING id INTO over_limit_sale;
    INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',over_limit_sale,1,
      '43000000-0000-4000-8000-000000000001','Over-limit sale','L',9,10,0);
    INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',over_limit_sale,'CREDIT',90,
      '23000000-0000-4000-8000-000000000001');
    UPDATE sales_transactions SET subtotal=90,total=90,status='POSTED',posted_by='23000000-0000-4000-8000-000000000001',posted_at=now()
      WHERE id=over_limit_sale;
    RAISE EXCEPTION 'credit sale above the customer limit was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'customer credit limit would be exceeded' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by,credit_override_reason,credit_overridden_by)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
      '53000000-0000-4000-8000-000000000001','2026-10-14','MAD','23000000-0000-4000-8000-000000000004',
      'cashier must not bypass limit','23000000-0000-4000-8000-000000000004') RETURNING id INTO over_limit_sale;
    INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',over_limit_sale,1,
      '43000000-0000-4000-8000-000000000001','Unauthorized override','L',10,10,0);
    INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
    VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',over_limit_sale,'CREDIT',100,'23000000-0000-4000-8000-000000000004');
    UPDATE sales_transactions SET subtotal=100,total=100,status='POSTED',posted_by='23000000-0000-4000-8000-000000000004',posted_at=now()
      WHERE id=over_limit_sale;
    RAISE EXCEPTION 'cashier credit-limit override was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'credit limit override requires an owner or manager' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.actor_id','23000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('app.role','SUPER_ADMIN',true);
  PERFORM set_config('app.actor_id','23000000-0000-4000-8000-000000000005',true);
  PERFORM set_config('app.role','OWNER',true);
  INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by,credit_override_reason,credit_overridden_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000001','2026-10-14','MAD','23000000-0000-4000-8000-000000000005',
    'approved by station owner for documented exception','23000000-0000-4000-8000-000000000005') RETURNING id INTO over_limit_sale;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',over_limit_sale,1,
    '43000000-0000-4000-8000-000000000001','Authorized override','L',10,10,0);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',over_limit_sale,'CREDIT',100,'23000000-0000-4000-8000-000000000005');
  UPDATE sales_transactions SET subtotal=100,total=100,status='POSTED',posted_by='23000000-0000-4000-8000-000000000005',posted_at=now()
    WHERE id=over_limit_sale;
  IF NOT EXISTS (SELECT 1 FROM customer_credit_movements WHERE sale_id=over_limit_sale
      AND reason='approved by station owner for documented exception' AND recorded_by='23000000-0000-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'authorized override reason and actor were not retained in the credit ledger';
  END IF;
  INSERT INTO audit_events(client_id,station_id,actor_id,action,entity_type,entity_id,details)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000005',
    'SALE_POSTED','sales_transaction',over_limit_sale::text,
    '{"creditOverrideReason":"approved by station owner for documented exception"}'::jsonb);
  BEGIN
    UPDATE audit_events SET action='ALTERED' WHERE entity_id=over_limit_sale::text AND action='SALE_POSTED';
    RAISE EXCEPTION 'audit event mutation was accepted';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    IF SQLSTATE<>'42501' AND SQLERRM<>'audit events are append-only' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.actor_id','23000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('app.role','SUPER_ADMIN',true);
END
$$;

INSERT INTO client_invoice_profiles (client_id,status,legal_configuration,approval_statement,approval_reference,approved_by,approved_at,updated_by)
VALUES ('13000000-0000-4000-8000-000000000001','APPROVED',
  '{"issuerName":"Test Issuer","legalMentions":[],"taxRules":[{"code":"TEST_RATE","ratePercent":10}]}'::jsonb,
  'Test accountant approved configuration','M3 TEST','23000000-0000-4000-8000-000000000001',now(),
  '23000000-0000-4000-8000-000000000001');

INSERT INTO issued_invoices (client_id,station_id,sale_id,customer_id,customer_snapshot,invoice_number,currency_code,business_date,
  subtotal,tax_total,total,legal_snapshot,lines_snapshot,issued_by)
SELECT s.client_id,s.station_id,s.id,s.customer_id,
  jsonb_build_object('code',c.code,'displayName',c.display_name,'contactEmail',c.contact_email,'contactPhone',c.contact_phone),
  'INV-00000001',s.currency_code,s.business_date,
  s.subtotal,s.tax_total,s.total,'{"issuerName":"Test Issuer"}'::jsonb,
  '[{"description":"10 L Fuel","taxCode":"TEST_RATE","taxRatePercent":10}]'::jsonb,
  '23000000-0000-4000-8000-000000000001'
FROM sales_transactions s JOIN customers c ON c.client_id=s.client_id AND c.id=s.customer_id
WHERE s.client_id='13000000-0000-4000-8000-000000000001' AND s.total=110;

INSERT INTO issued_credit_notes (client_id,invoice_id,sale_id,customer_id,credit_note_number,amount,receivable_adjustment,reason,legal_snapshot,issued_by)
SELECT i.client_id,i.id,i.sale_id,i.customer_id,'CN-00000001',20,20,'Test correction','{"issuerName":"Test Issuer"}'::jsonb,
  '23000000-0000-4000-8000-000000000001'
FROM issued_invoices i WHERE i.client_id='13000000-0000-4000-8000-000000000001';

UPDATE customers SET display_name='Renamed After Invoice',contact_email='new-contact@example.invalid'
WHERE client_id='13000000-0000-4000-8000-000000000001' AND id='53000000-0000-4000-8000-000000000001';

DO $$ BEGIN
  IF (SELECT customer_snapshot->>'displayName' FROM issued_invoices
      WHERE client_id='13000000-0000-4000-8000-000000000001' AND invoice_number='INV-00000001')<>'Credit Customer'
    OR (SELECT customer_snapshot->>'contactEmail' FROM issued_invoices
      WHERE client_id='13000000-0000-4000-8000-000000000001' AND invoice_number='INV-00000001')<>'m3-customer@example.invalid' THEN
    RAISE EXCEPTION 'issued invoice customer identity changed after the live customer record was edited';
  END IF;
  IF (SELECT count(*) FROM (
    SELECT s.id,COALESCE((SELECT sum(m.amount_delta) FROM customer_credit_movements m WHERE m.client_id=s.client_id AND m.sale_id=s.id),0) AS credit_balance,
      i.id AS invoice_id,i.invoice_number
    FROM sales_transactions s LEFT JOIN issued_invoices i ON i.client_id=s.client_id AND i.sale_id=s.id
    WHERE s.client_id='13000000-0000-4000-8000-000000000001' AND s.station_id='33000000-0000-4000-8000-000000000001'
  ) listed WHERE listed.credit_balance=50 AND listed.invoice_id IS NOT NULL AND listed.invoice_number='INV-00000001')<>1 THEN
    RAISE EXCEPTION 'station sales list did not expose outstanding credit and issued invoice';
  END IF;
END $$;

DO $$
DECLARE sale_row uuid; due numeric(14,2);
BEGIN
  SELECT sale_id INTO sale_row FROM issued_invoices
  WHERE client_id='13000000-0000-4000-8000-000000000001' AND invoice_number='INV-00000001';
  SELECT sum(amount_delta) INTO due FROM customer_credit_movements WHERE sale_id=sale_row;
  IF due<>50 THEN RAISE EXCEPTION 'credit note ledger adjustment was not applied'; END IF;
  BEGIN
    UPDATE issued_invoices SET total=1 WHERE client_id='13000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'issued invoice mutation was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'issued invoices and credit notes are immutable' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO issued_credit_notes (client_id,invoice_id,sale_id,customer_id,credit_note_number,amount,receivable_adjustment,reason,legal_snapshot,issued_by)
    SELECT i.client_id,i.id,i.sale_id,i.customer_id,'CN-OVER',100,0,'Must fail','{}'::jsonb,'23000000-0000-4000-8000-000000000001'
    FROM issued_invoices i WHERE i.client_id='13000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'credit note beyond invoice value was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'credit note exceeds the remaining invoice value' THEN RAISE; END IF;
  END;
END
$$;

INSERT INTO vouchers (id,client_id,code,currency_code,face_value,issued_by)
VALUES ('63000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','M3_VOUCHER','MAD',25,
  '23000000-0000-4000-8000-000000000001');

DO $$
DECLARE sale_row uuid; voucher_tender uuid; remaining numeric(14,2);
BEGIN
  INSERT INTO sales_transactions (client_id,station_id,business_date,currency_code,created_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001','2026-10-14','MAD',
    '23000000-0000-4000-8000-000000000001') RETURNING id INTO sale_row;
  INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_rate_percent)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_row,1,
    '43000000-0000-4000-8000-000000000002','Voucher sale','EA',1,15,0);
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,recorded_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_row,'CASH',10,
    '23000000-0000-4000-8000-000000000001');
  INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,voucher_id,recorded_by)
  VALUES ('13000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',sale_row,'VOUCHER',5,
    '63000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000001') RETURNING id INTO voucher_tender;
  UPDATE sales_transactions SET subtotal=15,tax_total=0,total=15,status='POSTED',
    posted_by='23000000-0000-4000-8000-000000000001',posted_at=now() WHERE id=sale_row;
  IF (SELECT credit_due_date FROM sales_transactions WHERE id=sale_row) IS NOT NULL THEN
    RAISE EXCEPTION 'cash sale unexpectedly received customer credit terms';
  END IF;
  SELECT face_value+COALESCE(sum(amount_delta),0) INTO remaining FROM vouchers v LEFT JOIN voucher_movements m
    ON m.client_id=v.client_id AND m.voucher_id=v.id WHERE v.id='63000000-0000-4000-8000-000000000001' GROUP BY v.id;
  IF remaining<>20 THEN RAISE EXCEPTION 'voucher sale did not decrease the voucher balance'; END IF;
  BEGIN
    INSERT INTO voucher_movements (client_id,voucher_id,sale_tender_id,movement_type,amount_delta,recorded_by)
    VALUES ('13000000-0000-4000-8000-000000000001','63000000-0000-4000-8000-000000000001',voucher_tender,'REDEEM',-21,
      '23000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'voucher over-redemption was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'voucher movement exceeds the available balance' THEN RAISE; END IF;
  END;
END
$$;

-- REC-20: approved voucher cancellation preserves redemption history and appends
-- a compensating movement for the remaining balance with an auditable reason.
SELECT set_config('app.actor_id','23000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','SUPER_ADMIN',true);
UPDATE vouchers SET status='CANCELLED',cancelled_by='23000000-0000-4000-8000-000000000001',
  cancelled_at=now(),cancellation_reason='REC-20 cancellation regression'
WHERE id='63000000-0000-4000-8000-000000000001';
INSERT INTO voucher_movements (client_id,voucher_id,movement_type,amount_delta,reason,recorded_by)
VALUES ('13000000-0000-4000-8000-000000000001','63000000-0000-4000-8000-000000000001','CANCEL',-20,
  'REC-20 cancellation regression','23000000-0000-4000-8000-000000000001');
DO $$
DECLARE remaining numeric(14,2); original_redemptions integer; cancellation_count integer;
BEGIN
  SELECT face_value+COALESCE(sum(amount_delta),0) INTO remaining FROM vouchers v
    LEFT JOIN voucher_movements m ON m.client_id=v.client_id AND m.voucher_id=v.id
    WHERE v.id='63000000-0000-4000-8000-000000000001' GROUP BY v.id;
  SELECT count(*) INTO original_redemptions FROM voucher_movements WHERE voucher_id='63000000-0000-4000-8000-000000000001' AND movement_type='REDEEM';
  SELECT count(*) INTO cancellation_count FROM voucher_movements WHERE voucher_id='63000000-0000-4000-8000-000000000001' AND movement_type='CANCEL';
  IF remaining<>0 OR original_redemptions<>1 OR cancellation_count<>1 THEN
    RAISE EXCEPTION 'REC-20 cancellation failed to reconcile balance and preserve source movement';
  END IF;
END
$$;

SELECT set_config('app.actor_id','23000000-0000-4000-8000-000000000003',true);
SELECT set_config('app.role','ACCOUNTANT',true);
INSERT INTO audit_events (client_id,actor_id,action,entity_type,entity_id,details)
VALUES ('13000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000003',
  'INVOICE_PROFILE_APPROVED','client_invoice_profile','13000000-0000-4000-8000-000000000001','{}'::jsonb);

ROLLBACK;
