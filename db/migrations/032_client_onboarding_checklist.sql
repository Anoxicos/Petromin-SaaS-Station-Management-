-- Standard repeatable checklist after tenant/station creation. Completion is an explicit actor attestation with a note.
SET ROLE station_owner;

CREATE TABLE client_onboarding_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  task_code text NOT NULL CHECK (task_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1000),
  responsible_party text NOT NULL CHECK (responsible_party IN ('CLIENT','PROVIDER')),
  responsible_role text NOT NULL CHECK (
    (responsible_party='CLIENT' AND responsible_role IN ('OWNER','MANAGER','ACCOUNTANT')) OR
    (responsible_party='PROVIDER' AND responsible_role='PROVIDER')
  ),
  is_required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','WAIVED')),
  completion_note text,
  completed_by uuid REFERENCES app_users(id),
  completed_at timestamptz,
  waived_by uuid REFERENCES app_users(id),
  waived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id,task_code),
  CHECK ((status='PENDING' AND completed_by IS NULL AND completed_at IS NULL AND waived_by IS NULL AND waived_at IS NULL)
      OR (status='COMPLETED' AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND waived_by IS NULL AND waived_at IS NULL)
      OR (status='WAIVED' AND completed_by IS NULL AND completed_at IS NULL AND waived_by IS NOT NULL AND waived_at IS NOT NULL
        AND length(trim(COALESCE(completion_note,'')))>0))
);

CREATE FUNCTION guard_client_onboarding_task() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'onboarding checklist items cannot be deleted'; END IF;
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('COMPLETED','WAIVED') THEN RAISE EXCEPTION 'onboarding tasks may only move once from pending'; END IF;
  IF NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.task_code<>OLD.task_code OR NEW.title<>OLD.title
    OR NEW.description<>OLD.description OR NEW.responsible_party<>OLD.responsible_party
    OR NEW.responsible_role<>OLD.responsible_role OR NEW.is_required<>OLD.is_required OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'onboarding task definition is immutable';
  END IF;
  IF NEW.status='COMPLETED' THEN
    IF length(trim(COALESCE(NEW.completion_note,'')))=0 OR NEW.completed_by<>app_actor_id() OR NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'a completion note and actor are required';
    END IF;
    IF OLD.responsible_party='PROVIDER' AND NOT app_is_super_admin() THEN RAISE EXCEPTION 'provider task requires super-admin'; END IF;
    IF OLD.responsible_party='CLIENT' AND NOT app_is_super_admin()
      AND NOT app_has_client_role(OLD.client_id,ARRAY[OLD.responsible_role]) THEN RAISE EXCEPTION 'assigned client role must complete this task'; END IF;
  ELSE
    IF NOT app_is_super_admin() OR NEW.waived_by<>app_actor_id() OR NEW.waived_at IS NULL
      OR length(trim(COALESCE(NEW.completion_note,'')))=0 THEN RAISE EXCEPTION 'only a super-admin may waive a task with a reason'; END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER client_onboarding_task_guard BEFORE UPDATE OR DELETE ON client_onboarding_tasks
FOR EACH ROW EXECUTE FUNCTION guard_client_onboarding_task();

ALTER TABLE client_onboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_onboarding_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY client_onboarding_task_scope ON client_onboarding_tasks
  USING (app_is_super_admin() OR app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']))
  WITH CHECK (app_is_super_admin() OR app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));
GRANT SELECT,INSERT,UPDATE ON client_onboarding_tasks TO station_app;

DROP POLICY audit_events_insert_scope ON audit_events;
CREATE POLICY audit_events_insert_scope ON audit_events
  FOR INSERT WITH CHECK (
    app_is_super_admin()
    OR (client_id IS NOT NULL AND actor_id=app_actor_id() AND (
      (station_id IS NULL AND app_has_client_role(client_id,ARRAY['OWNER','MANAGER']))
      OR (station_id IS NULL AND entity_type IN ('client_invoice_profile','customer','customer_payment','issued_credit_note','client_onboarding_task')
        AND app_has_client_role(client_id,ARRAY['ACCOUNTANT']))
      OR (station_id IS NOT NULL AND app_can_access_station(client_id,station_id))
    ))
  );

RESET ROLE;
