-- Rollback-only M8 checks: flexible plan inputs, pending subscriptions, contract gating and tenant read scope.
BEGIN;
INSERT INTO clients(id,name,code) VALUES
 ('18000000-0000-4000-8000-000000000001','M8 Onboarded Client','M8_ONBOARD'),
 ('18000000-0000-4000-8000-000000000002','M8 Other Client','M8_OTHER');
INSERT INTO app_users(id,auth_subject,email,display_name,is_super_admin) VALUES
 ('28000000-0000-4000-8000-000000000001','m8-admin','m8-admin@example.invalid','M8 Admin',true),
 ('28000000-0000-4000-8000-000000000002','m8-owner','m8-owner@example.invalid','M8 Owner',false),
 ('28000000-0000-4000-8000-000000000003','m8-other','m8-other@example.invalid','M8 Other',false);
INSERT INTO client_memberships(client_id,user_id,role) VALUES
 ('18000000-0000-4000-8000-000000000001','28000000-0000-4000-8000-000000000002','OWNER'),
 ('18000000-0000-4000-8000-000000000002','28000000-0000-4000-8000-000000000003','OWNER');
SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','28000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','',true);
SELECT set_config('app.role','SUPER_ADMIN',true);

DO $$ DECLARE plan_id uuid; subscription_id uuid; visible_count integer;
BEGIN
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='client_subscriptions' AND column_name='billing_day') IS NOT NULL THEN
    RAISE EXCEPTION 'new subscription billing day still has a silent database default';
  END IF;
  INSERT INTO platform_subscription_plans(id,code,name,created_by) VALUES
   ('78000000-0000-4000-8000-000000000001','M8_FLEX','Flexible configurable plan','28000000-0000-4000-8000-000000000001') RETURNING id INTO plan_id;
  BEGIN
    INSERT INTO client_subscriptions(client_id,plan_id,effective_from,billing_time_zone,created_by,updated_by)
    VALUES('18000000-0000-4000-8000-000000000001',plan_id,'2026-11-01','Etc/UTC',
      '28000000-0000-4000-8000-000000000001','28000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'subscription insert silently assumed a billing day';
  EXCEPTION WHEN not_null_violation THEN NULL;
  WHEN raise_exception THEN IF SQLERRM='subscription insert silently assumed a billing day' THEN RAISE; END IF;
  END;
  INSERT INTO platform_plan_rates(plan_id,effective_from,currency_code,monthly_base_fee,monthly_station_fee,created_by) VALUES
   (plan_id,'2026-11-01','MAD',0,0,'28000000-0000-4000-8000-000000000001');
  INSERT INTO client_subscriptions(id,client_id,plan_id,status,effective_from,contract_reference,billing_day,billing_time_zone,created_by,updated_by) VALUES
   ('88000000-0000-4000-8000-000000000001','18000000-0000-4000-8000-000000000001',plan_id,'PENDING','2026-11-01',NULL,15,'Africa/Casablanca','28000000-0000-4000-8000-000000000001','28000000-0000-4000-8000-000000000001') RETURNING id INTO subscription_id;
  INSERT INTO stations(id,client_id,code,name,meter_mode,closing_cutoff,time_zone) VALUES
   ('38000000-0000-4000-8000-000000000001','18000000-0000-4000-8000-000000000001','M8_ST1','M8 Station','NOZZLE','23:00','Africa/Casablanca');
  INSERT INTO audit_events(client_id,actor_id,action,entity_type,entity_id,details) VALUES
   ('18000000-0000-4000-8000-000000000001','28000000-0000-4000-8000-000000000001','CLIENT_ONBOARDED','client','18000000-0000-4000-8000-000000000001','{"stationCount":1}');
  INSERT INTO audit_events(client_id,actor_id,action,entity_type,entity_id,details) VALUES
    ('18000000-0000-4000-8000-000000000001','28000000-0000-4000-8000-000000000001','CLIENT_ONBOARDED','client','18000000-0000-4000-8000-000000000001','{}');
  SELECT count(*) INTO visible_count FROM client_subscriptions WHERE client_id='18000000-0000-4000-8000-000000000001';
  IF visible_count<>1 THEN RAISE EXCEPTION 'super-admin could not read the new subscription'; END IF;
END $$;

SELECT set_config('app.actor_id','28000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','18000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','OWNER',true);
DO $$ DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM client_subscriptions;
  IF visible_count<>1 THEN RAISE EXCEPTION 'client owner cannot view their subscription'; END IF;
  IF (SELECT count(*) FROM client_subscriptions WHERE client_id='18000000-0000-4000-8000-000000000002')<>0 THEN RAISE EXCEPTION 'subscription RLS exposed another client'; END IF;
  BEGIN
    UPDATE client_subscriptions SET status='ACTIVE',contract_reference='forged' WHERE client_id='18000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'client owner unexpectedly changed platform subscription';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN raise_exception THEN IF SQLERRM='client owner unexpectedly changed platform subscription' THEN RAISE; END IF; END;
END $$;

SELECT set_config('app.actor_id','28000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','',true);
SELECT set_config('app.role','SUPER_ADMIN',true);
  UPDATE client_subscriptions SET status='ACTIVE',contract_reference='signed-contract-ref',updated_by='28000000-0000-4000-8000-000000000001' WHERE id='88000000-0000-4000-8000-000000000001';
UPDATE client_subscriptions SET status='PAUSED',updated_by='28000000-0000-4000-8000-000000000001' WHERE id='88000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN UPDATE client_subscriptions SET status='CANCELLED',updated_by='28000000-0000-4000-8000-000000000001' WHERE id='88000000-0000-4000-8000-000000000001';
    UPDATE client_subscriptions SET status='ACTIVE',updated_by='28000000-0000-4000-8000-000000000001' WHERE id='88000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'cancelled subscription unexpectedly reactivated';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='cancelled subscription unexpectedly reactivated' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
