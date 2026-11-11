-- Rollback-only M8 checks: rate snapshot calculation, contract-backed subscription, statement review and tenant scope.
BEGIN;
INSERT INTO clients(id,name,code) VALUES
 ('19000000-0000-4000-8000-000000000001','M8 Billing Test','M8_BILL'),
 ('19000000-0000-4000-8000-000000000002','M8 Other Billing','M8_BOT');
INSERT INTO app_users(id,auth_subject,email,display_name,is_super_admin) VALUES
 ('29000000-0000-4000-8000-000000000001','m8-bill-admin','m8-bill-admin@example.invalid','M8 Bill Admin',true),
 ('29000000-0000-4000-8000-000000000002','m8-bill-owner','m8-bill-owner@example.invalid','M8 Bill Owner',false),
 ('29000000-0000-4000-8000-000000000003','m8-bill-other','m8-bill-other@example.invalid','M8 Bill Other',false);
INSERT INTO client_memberships(client_id,user_id,role) VALUES
 ('19000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000002','OWNER'),
 ('19000000-0000-4000-8000-000000000002','29000000-0000-4000-8000-000000000003','OWNER');
SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','29000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','',true);
SELECT set_config('app.role','SUPER_ADMIN',true);
INSERT INTO platform_subscription_plans(id,code,name,created_by) VALUES
 ('79000000-0000-4000-8000-000000000001','M8_BILLPLAN','M8 Billing Plan','29000000-0000-4000-8000-000000000001');
INSERT INTO platform_plan_rates(id,plan_id,effective_from,currency_code,monthly_base_fee,monthly_station_fee,created_by) VALUES
 ('79000000-0000-4000-8000-000000000002','79000000-0000-4000-8000-000000000001','2026-10-01','MAD',100,10,'29000000-0000-4000-8000-000000000001');
INSERT INTO client_subscriptions(id,client_id,plan_id,status,effective_from,contract_reference,billing_day,billing_time_zone,created_by,updated_by) VALUES
 ('89000000-0000-4000-8000-000000000001','19000000-0000-4000-8000-000000000001','79000000-0000-4000-8000-000000000001','ACTIVE','2026-10-01','signed-reference',15,'Africa/Casablanca','29000000-0000-4000-8000-000000000001','29000000-0000-4000-8000-000000000001');
INSERT INTO platform_billing_statements(id,client_id,subscription_id,plan_rate_id,period_start,period_end,currency_code,station_count,monthly_base_fee,monthly_station_fee,amount_before_tax,created_by) VALUES
 ('99000000-0000-4000-8000-000000000001','19000000-0000-4000-8000-000000000001','89000000-0000-4000-8000-000000000001','79000000-0000-4000-8000-000000000002','2026-10-01','2026-10-31','MAD',2,100,10,120,'29000000-0000-4000-8000-000000000001');
DO $$ BEGIN
  IF (SELECT amount_before_tax FROM platform_billing_statements WHERE id='99000000-0000-4000-8000-000000000001')<>120 THEN RAISE EXCEPTION 'billing statement did not preserve the rate and station-count calculation'; END IF;
END $$;

SELECT set_config('app.actor_id','29000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','19000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','OWNER',true);
DO $$ DECLARE own_count integer; other_count integer;
BEGIN
  SELECT count(*) INTO own_count FROM platform_billing_statements;
  SELECT count(*) INTO other_count FROM platform_billing_statements WHERE client_id='19000000-0000-4000-8000-000000000002';
  IF own_count<>1 OR other_count<>0 THEN RAISE EXCEPTION 'billing statement tenant read scope is incorrect'; END IF;
  BEGIN UPDATE platform_billing_statements SET status='APPROVED',reviewed_by='29000000-0000-4000-8000-000000000002',reviewed_at=now(); RAISE EXCEPTION 'client owner unexpectedly approved platform billing';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN raise_exception THEN IF SQLERRM='client owner unexpectedly approved platform billing' THEN RAISE; END IF; END;
END $$;

SELECT set_config('app.actor_id','29000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','',true);
SELECT set_config('app.role','SUPER_ADMIN',true);
UPDATE platform_billing_statements SET status='APPROVED',reviewed_by='29000000-0000-4000-8000-000000000001',reviewed_at=now(),status_reason='Reviewed for manual billing' WHERE id='99000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN UPDATE platform_billing_statements SET amount_before_tax=999 WHERE id='99000000-0000-4000-8000-000000000001'; RAISE EXCEPTION 'approved statement snapshot unexpectedly changed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='approved statement snapshot unexpectedly changed' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
