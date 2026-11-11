-- Rollback-only M9 support queue, tenant isolation, and client/provider visibility checks.
BEGIN;
INSERT INTO clients(id,name,code) VALUES
 ('1a000000-0000-4000-8000-000000000001','M9 Support Client','M9_SUPPORT'),
 ('1a000000-0000-4000-8000-000000000002','M9 Other Client','M9_OTHER');
INSERT INTO app_users(id,auth_subject,email,display_name,is_super_admin) VALUES
 ('2a000000-0000-4000-8000-000000000001','m9-support-admin','m9-support-admin@example.invalid','M9 Admin',true),
 ('2a000000-0000-4000-8000-000000000002','m9-support-owner','m9-support-owner@example.invalid','M9 Owner',false),
 ('2a000000-0000-4000-8000-000000000003','m9-support-other','m9-support-other@example.invalid','M9 Other',false);
INSERT INTO client_memberships(client_id,user_id,role) VALUES
 ('1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000002','OWNER'),
 ('1a000000-0000-4000-8000-000000000002','2a000000-0000-4000-8000-000000000003','OWNER');
SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id','2a000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','1a000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','OWNER',true);
INSERT INTO support_requests(id,client_id,opened_by,category,subject,description) VALUES
 ('3a000000-0000-4000-8000-000000000001','1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000002','OPERATIONS','Pump screen issue','Test request');
INSERT INTO support_request_messages(client_id,support_request_id,actor_id,message_type,visibility,message) VALUES
 ('1a000000-0000-4000-8000-000000000001','3a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000002','MESSAGE','CLIENT','We saw an error on the station screen.');
INSERT INTO audit_events(client_id,actor_id,action,entity_type,entity_id,details) VALUES
 ('1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000002','SUPPORT_REQUEST_OPENED','support_request','3a000000-0000-4000-8000-000000000001','{}');
DO $$ BEGIN
  IF (SELECT count(*) FROM support_requests)<>1 THEN RAISE EXCEPTION 'client support request scope is incorrect'; END IF;
  IF (SELECT count(*) FROM support_request_messages)<>1 THEN RAISE EXCEPTION 'client message scope is incorrect'; END IF;
  BEGIN
    INSERT INTO support_requests(client_id,opened_by,category,subject,description,status,resolution_note,resolved_at)
    VALUES('1a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000002','OTHER','Forged close','No','RESOLVED','forged',now());
    RAISE EXCEPTION 'client unexpectedly created a resolved request';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='client unexpectedly created a resolved request' THEN RAISE; END IF; END;
  BEGIN
    UPDATE support_requests SET status='IN_PROGRESS' WHERE id='3a000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'client unexpectedly changed provider workflow status';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='client unexpectedly changed provider workflow status' THEN RAISE; END IF; END;
  BEGIN
    INSERT INTO support_request_messages(client_id,support_request_id,actor_id,message_type,visibility,status_to,message)
    VALUES('1a000000-0000-4000-8000-000000000001','3a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000002','STATUS_CHANGE','CLIENT','RESOLVED','Forged status change');
    RAISE EXCEPTION 'client unexpectedly created a status-change event';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='client unexpectedly created a status-change event' THEN RAISE; END IF; END;
END $$;
SELECT set_config('app.actor_id','2a000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.client_id','',true);
SELECT set_config('app.role','SUPER_ADMIN',true);
DO $$ BEGIN
  BEGIN
    UPDATE support_requests SET assigned_to='2a000000-0000-4000-8000-000000000002' WHERE id='3a000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'support request was assigned to a client owner';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='support request was assigned to a client owner' THEN RAISE; END IF;
    IF SQLERRM<>'support assignee must be a configured provider super-admin' THEN RAISE; END IF;
  END;
END $$;
UPDATE support_requests SET assigned_to='2a000000-0000-4000-8000-000000000001' WHERE id='3a000000-0000-4000-8000-000000000001';
UPDATE support_requests SET assigned_to=NULL WHERE id='3a000000-0000-4000-8000-000000000001';
UPDATE support_requests SET status='IN_PROGRESS' WHERE id='3a000000-0000-4000-8000-000000000001';
UPDATE support_requests SET status='RESOLVED',resolution_note='Issue reproduced and mitigated' WHERE id='3a000000-0000-4000-8000-000000000001';
INSERT INTO support_request_messages(client_id,support_request_id,actor_id,message_type,visibility,message)
VALUES('1a000000-0000-4000-8000-000000000001','3a000000-0000-4000-8000-000000000001','2a000000-0000-4000-8000-000000000001','MESSAGE','PROVIDER','Internal reproduction notes.');
DO $$ BEGIN
  IF (SELECT count(*) FROM support_request_messages WHERE visibility='PROVIDER')<>1 THEN RAISE EXCEPTION 'provider cannot see internal note'; END IF;
  IF (SELECT count(*) FROM support_requests WHERE client_id='1a000000-0000-4000-8000-000000000002')<>0 THEN RAISE EXCEPTION 'cross-tenant support request leak'; END IF;
  BEGIN UPDATE support_request_messages SET message='changed' WHERE visibility='CLIENT';
    RAISE EXCEPTION 'support message unexpectedly mutable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN raise_exception THEN IF SQLERRM='support message unexpectedly mutable' THEN RAISE; END IF; END;
END $$;
SELECT set_config('app.actor_id','2a000000-0000-4000-8000-000000000002',true);
SELECT set_config('app.client_id','1a000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','OWNER',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM support_request_messages)<>1 OR EXISTS(SELECT 1 FROM support_request_messages WHERE visibility='PROVIDER') THEN
    RAISE EXCEPTION 'client can see internal provider messages';
  END IF;
END $$;
ROLLBACK;
