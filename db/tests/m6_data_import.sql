-- Rollback-only coverage for staged imports, append-only commits and tenant isolation.
BEGIN;
INSERT INTO clients(id,name,code) VALUES
 ('16000000-0000-4000-8000-000000000001','M6 Import Test','M6_IMPORT'),
 ('16000000-0000-4000-8000-000000000002','M6 Other Client','M6_OTHER');
INSERT INTO app_users(id,auth_subject,email,display_name,is_super_admin) VALUES
 ('26000000-0000-4000-8000-000000000001','m6-import-admin','m6-import@example.invalid','M6 Admin',true),
 ('26000000-0000-4000-8000-000000000002','m6-other-owner','m6-other@example.invalid','M6 Other',false);
INSERT INTO client_memberships(client_id,user_id,role) VALUES
 ('16000000-0000-4000-8000-000000000002','26000000-0000-4000-8000-000000000002','OWNER');
INSERT INTO stations(id,client_id,code,name,meter_mode,closing_cutoff,time_zone) VALUES
 ('36000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','M6_ST1','M6 Station','NOZZLE','23:00','Africa/Casablanca');
INSERT INTO products(id,client_id,code,name,product_type,unit_code) VALUES
 ('46000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','M6_ART','M6 Article','ARTICLE','EA');
INSERT INTO station_products(client_id,station_id,product_id) VALUES
 ('16000000-0000-4000-8000-000000000001','36000000-0000-4000-8000-000000000001','46000000-0000-4000-8000-000000000001');
INSERT INTO customers(id,client_id,code,display_name,created_by) VALUES
 ('56000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','M6_CUST','M6 Customer','26000000-0000-4000-8000-000000000001');
INSERT INTO customer_credit_accounts(client_id,customer_id,credit_limit,updated_by) VALUES
 ('16000000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000001',10000,'26000000-0000-4000-8000-000000000001');
SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','26000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','16000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','SUPER_ADMIN',true);

DO $$ DECLARE history_job uuid; stock_job uuid; recv_job uuid; history_row uuid; stock_row uuid; recv_row uuid;
  history_count integer; stock_total numeric; receivable_total numeric;
BEGIN
  INSERT INTO import_jobs(id,client_id,station_id,import_kind,source_name,row_count,created_by) VALUES
   ('76000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001',NULL,'HISTORICAL_RECORDS','history.csv',1,'26000000-0000-4000-8000-000000000001') RETURNING id INTO history_job;
  INSERT INTO import_job_rows(id,client_id,job_id,row_number,raw_data,status,normalized_data) VALUES
   ('86000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001',history_job,1,'{"recordDate":"2025-01-01"}','VALID','{"recordDate":"2025-01-01","recordType":"DAILY_TOTAL","description":"Archive row"}') RETURNING id INTO history_row;
  UPDATE import_jobs SET status='VALIDATED',valid_count=1,validated_at=now() WHERE id=history_job;
  INSERT INTO imported_history_records(client_id,station_id,import_job_row_id,record_date,record_type,description,imported_by)
    VALUES('16000000-0000-4000-8000-000000000001',NULL,history_row,'2025-01-01','DAILY_TOTAL','Archive row','26000000-0000-4000-8000-000000000001');
  UPDATE import_job_rows SET imported_entity_id=(SELECT id FROM imported_history_records WHERE import_job_row_id=history_row) WHERE id=history_row;
  UPDATE import_jobs SET status='COMMITTED',committed_by='26000000-0000-4000-8000-000000000001',committed_at=now() WHERE id=history_job;

  INSERT INTO import_jobs(id,client_id,station_id,import_kind,source_name,row_count,created_by) VALUES
   ('76000000-0000-4000-8000-000000000002','16000000-0000-4000-8000-000000000001','36000000-0000-4000-8000-000000000001','OPENING_STOCK','stock.csv',1,'26000000-0000-4000-8000-000000000001') RETURNING id INTO stock_job;
  INSERT INTO import_job_rows(id,client_id,job_id,row_number,raw_data,status,normalized_data) VALUES
   ('86000000-0000-4000-8000-000000000002','16000000-0000-4000-8000-000000000001',stock_job,1,'{}','VALID','{"productId":"46000000-0000-4000-8000-000000000001","businessDate":"2026-01-01","quantity":"125.000","reason":"verified opening"}') RETURNING id INTO stock_row;
  UPDATE import_jobs SET status='VALIDATED',valid_count=1,validated_at=now() WHERE id=stock_job;
  INSERT INTO stock_movements(client_id,station_id,product_id,movement_type,quantity_delta,business_date,source_id,reason,recorded_by)
    VALUES('16000000-0000-4000-8000-000000000001','36000000-0000-4000-8000-000000000001','46000000-0000-4000-8000-000000000001','OPENING_BALANCE',125,'2026-01-01',stock_row,'verified opening','26000000-0000-4000-8000-000000000001');
  UPDATE import_job_rows SET imported_entity_id='86000000-0000-4000-8000-000000000002' WHERE id=stock_row;
  UPDATE import_jobs SET status='COMMITTED',committed_by='26000000-0000-4000-8000-000000000001',committed_at=now() WHERE id=stock_job;

  INSERT INTO import_jobs(id,client_id,station_id,import_kind,source_name,row_count,created_by) VALUES
   ('76000000-0000-4000-8000-000000000003','16000000-0000-4000-8000-000000000001','36000000-0000-4000-8000-000000000001','OPENING_RECEIVABLE','receivables.csv',1,'26000000-0000-4000-8000-000000000001') RETURNING id INTO recv_job;
  INSERT INTO import_job_rows(id,client_id,job_id,row_number,raw_data,status,normalized_data) VALUES
   ('86000000-0000-4000-8000-000000000003','16000000-0000-4000-8000-000000000001',recv_job,1,'{}','VALID','{"customerId":"56000000-0000-4000-8000-000000000001","businessDate":"2026-01-01","amount":"450.00","reason":"verified opening"}') RETURNING id INTO recv_row;
  UPDATE import_jobs SET status='VALIDATED',valid_count=1,validated_at=now() WHERE id=recv_job;
  INSERT INTO customer_credit_movements(client_id,customer_id,movement_type,amount_delta,reason,recorded_by,business_date,source_import_job_row_id)
    VALUES('16000000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000001','ADJUSTMENT',450,'Opening receivable: verified opening','26000000-0000-4000-8000-000000000001','2026-01-01',recv_row);
  UPDATE import_job_rows SET imported_entity_id='86000000-0000-4000-8000-000000000003' WHERE id=recv_row;
  UPDATE import_jobs SET status='COMMITTED',committed_by='26000000-0000-4000-8000-000000000001',committed_at=now() WHERE id=recv_job;

  SELECT count(*) INTO history_count FROM imported_history_records WHERE client_id='16000000-0000-4000-8000-000000000001';
  SELECT sum(quantity_delta) INTO stock_total FROM stock_movements WHERE client_id='16000000-0000-4000-8000-000000000001' AND movement_type='OPENING_BALANCE';
  SELECT sum(amount_delta) INTO receivable_total FROM customer_credit_movements WHERE client_id='16000000-0000-4000-8000-000000000001' AND movement_type='ADJUSTMENT' AND source_import_job_row_id=recv_row AND business_date='2026-01-01';
  IF history_count<>1 OR stock_total<>125 OR receivable_total<>450 THEN RAISE EXCEPTION 'committed imports did not append expected archive and dated opening ledgers'; END IF;
  BEGIN UPDATE imported_history_records SET description='changed' WHERE import_job_row_id=history_row; RAISE EXCEPTION 'history mutation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN raise_exception THEN IF SQLERRM='history mutation unexpectedly succeeded' THEN RAISE; END IF; END;
  BEGIN UPDATE import_job_rows SET raw_data='{}' WHERE id=history_row; RAISE EXCEPTION 'validated row mutation unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='validated row mutation unexpectedly succeeded' THEN RAISE; END IF; END;
END $$;

SELECT set_config('app.actor_id','26000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','16000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.role','OWNER',true);
DO $$ BEGIN IF (SELECT count(*) FROM import_jobs)<>0 OR (SELECT count(*) FROM imported_history_records)<>0 THEN RAISE EXCEPTION 'another tenant import became visible'; END IF; END $$;
ROLLBACK;
