-- Rollback-only M8 checks: standard tenant setup tasks, assignee controls, evidence, waiver, and tenant isolation.
BEGIN;
INSERT INTO clients(id,name,code) VALUES
 ('1a000000-0000-4000-8000-000000000001','M8 Checklist Client','M8_CHECK'),
 ('1a000000-0000-4000-8000-000000000002','M8 Checklist Other','M8_COTHER');
INSERT INTO app_users(id,auth_subject,email,display_name,is_super_admin) VALUES
 ('2a000000-0000-4000-8000-000000000001','m8-check-admin','m8-check-admin@example.invalid','M8 Checklist Admin',true),
 ('2a000000-0000-4000-8000-000000000002','m8-check-owner','m8-check-owner@example.invalid','M8 Checklist Owner',false),
 ('2a000000-0000-4000-8000-000000000003','m8-check-manager','m8-check-manager@example.invalid','M8 Checklist Manager',false),
 ('2a000000-0000-4000-8000-000000000004','m8-check-accountant','m8-check-accountant@example.invalid','M8 Checklist Accountant',false),
 ('2a000000-0000-4000-8000-000000000005','m8-check-other','m8-check-other@example.invalid','M8 Checklist Other',false);
INSERT INTO client_memberships(client_id,user_id,role) VALUES
 ('1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000002','OWNER'),
 ('1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000003','MANAGER'),
 ('1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000004','ACCOUNTANT'),
 ('1a000000-0000-4000-8000-000000000002','2a000000-0000-4000-8000-000000000005','OWNER');
SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','2a000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','',true);
SELECT set_config('app.role','SUPER_ADMIN',true);
INSERT INTO client_onboarding_tasks(client_id,task_code,title,description,responsible_party,responsible_role) VALUES
 ('1a000000-0000-4000-8000-000000000001','ACCESS','Confirm users','Owner confirms access and assigned roles.','CLIENT','OWNER'),
 ('1a000000-0000-4000-8000-000000000001','FINANCE','Approve finance','Accountant confirms supplied invoice profile.','CLIENT','ACCOUNTANT'),
 ('1a000000-0000-4000-8000-000000000001','PILOT','Record pilot','Provider records pilot evidence.','PROVIDER','PROVIDER'),
 ('1a000000-0000-4000-8000-000000000001','PRIVACY','Confirm retention','Accountant records the agreed retention evidence.','CLIENT','ACCOUNTANT'),
 ('1a000000-0000-4000-8000-000000000002','ACCESS','Other access','Other client task.','CLIENT','OWNER');

SELECT set_config('app.actor_id','2a000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','1a000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','OWNER',true);
DO $$ DECLARE own_tasks integer; other_tasks integer;
BEGIN
  SELECT count(*) INTO own_tasks FROM client_onboarding_tasks;
  SELECT count(*) INTO other_tasks FROM client_onboarding_tasks WHERE client_id='1a000000-0000-4000-8000-000000000002';
  IF own_tasks<>4 OR other_tasks<>0 THEN RAISE EXCEPTION 'onboarding checklist tenant read scope is incorrect'; END IF;
  UPDATE client_onboarding_tasks SET status='COMPLETED',completion_note='Owner checked all accounts',completed_by='2a000000-0000-4000-8000-000000000002',completed_at=now()
   WHERE client_id='1a000000-0000-4000-8000-000000000001' AND task_code='ACCESS';
  BEGIN UPDATE client_onboarding_tasks SET status='COMPLETED',completion_note='unauthorized',completed_by='2a000000-0000-4000-8000-000000000002',completed_at=now()
    WHERE client_id='1a000000-0000-4000-8000-000000000001' AND task_code='PILOT';
    RAISE EXCEPTION 'client owner unexpectedly completed provider task';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='client owner unexpectedly completed provider task' THEN RAISE; END IF; END;
END $$;
INSERT INTO audit_events(client_id,actor_id,action,entity_type,entity_id,details) VALUES
 ('1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000002','CLIENT_ONBOARDING_TASK_CLOSED','client_onboarding_task','ACCESS','{}');
DO $$ BEGIN
  IF (SELECT count(*) FROM audit_events WHERE client_id='1a000000-0000-4000-8000-000000000002')<>0 THEN RAISE EXCEPTION 'client owner can read another tenant audit history'; END IF;
END $$;

SELECT set_config('app.actor_id','2a000000-0000-4000-8000-000000000003',true);
SELECT set_config('app.role','MANAGER',true);
DO $$ BEGIN
  BEGIN UPDATE client_onboarding_tasks SET status='COMPLETED',completion_note='wrong role',completed_by='2a000000-0000-4000-8000-000000000003',completed_at=now()
    WHERE client_id='1a000000-0000-4000-8000-000000000001' AND task_code='FINANCE';
    RAISE EXCEPTION 'manager unexpectedly completed accountant task';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='manager unexpectedly completed accountant task' THEN RAISE; END IF; END;
END $$;

SELECT set_config('app.actor_id','2a000000-0000-4000-8000-000000000004',true);
SELECT set_config('app.role','ACCOUNTANT',true);
UPDATE client_onboarding_tasks SET status='COMPLETED',completion_note='Accountant approval reference recorded',completed_by='2a000000-0000-4000-8000-000000000004',completed_at=now()
 WHERE client_id='1a000000-0000-4000-8000-000000000001' AND task_code='FINANCE';
INSERT INTO audit_events(client_id,actor_id,action,entity_type,entity_id,details) VALUES
 ('1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000004','CLIENT_ONBOARDING_TASK_CLOSED','client_onboarding_task','FINANCE','{}');

SELECT set_config('app.actor_id','2a000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','SUPER_ADMIN',true);
UPDATE client_onboarding_tasks SET status='WAIVED',completion_note='Not applicable to pilot; provider/client approved scope',waived_by='2a000000-0000-4000-8000-000000000001',waived_at=now()
 WHERE client_id='1a000000-0000-4000-8000-000000000001' AND task_code='PRIVACY';
DO $$ BEGIN
  BEGIN UPDATE client_onboarding_tasks SET status='PENDING' WHERE task_code='ACCESS';
    RAISE EXCEPTION 'closed onboarding task unexpectedly reopened';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='closed onboarding task unexpectedly reopened' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
