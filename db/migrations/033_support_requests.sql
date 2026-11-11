-- M9 internal support workflow without contractual response-time promises.
SET ROLE station_owner;

CREATE TABLE support_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  opened_by uuid NOT NULL REFERENCES app_users(id),
  category text NOT NULL CHECK (category IN ('OPERATIONS','ACCESS','DATA_ISSUE','OTHER')),
  subject text NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ACKNOWLEDGED','IN_PROGRESS','WAITING_FOR_CLIENT','RESOLVED','CLOSED')),
  assigned_to uuid REFERENCES app_users(id),
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  closed_at timestamptz,
  UNIQUE (client_id,id),
  CHECK ((status IN ('RESOLVED','CLOSED'))=(resolved_at IS NOT NULL)),
  CHECK ((status='CLOSED')=(closed_at IS NOT NULL))
);
CREATE INDEX support_requests_client_recent_idx ON support_requests(client_id,created_at DESC);
CREATE INDEX support_requests_provider_queue_idx ON support_requests(status,updated_at DESC);

CREATE TABLE support_request_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  support_request_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  message_type text NOT NULL CHECK (message_type IN ('MESSAGE','STATUS_CHANGE','ASSIGNMENT')),
  visibility text NOT NULL CHECK (visibility IN ('CLIENT','PROVIDER')),
  status_from text,
  status_to text,
  message text NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id,support_request_id) REFERENCES support_requests(client_id,id),
  CHECK ((message_type='STATUS_CHANGE' AND status_to IS NOT NULL)
      OR (message_type<>'STATUS_CHANGE' AND status_from IS NULL AND status_to IS NULL))
);
CREATE INDEX support_messages_request_idx ON support_request_messages(client_id,support_request_id,created_at);

CREATE FUNCTION guard_support_request_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status<>'NEW' OR NEW.opened_by<>app_actor_id() OR NEW.assigned_to IS NOT NULL
    OR NEW.resolution_note IS NOT NULL OR NEW.resolved_at IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'support requests must be opened by the current actor in NEW state';
  END IF;
  IF NOT app_is_super_admin() AND NOT app_has_client_access(NEW.client_id) THEN
    RAISE EXCEPTION 'support request client access required';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER support_request_insert_guard BEFORE INSERT ON support_requests
FOR EACH ROW EXECUTE FUNCTION guard_support_request_insert();

CREATE FUNCTION guard_support_request_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.client_id<>NEW.client_id OR OLD.id<>NEW.id OR OLD.opened_by<>NEW.opened_by
    OR OLD.category<>NEW.category OR OLD.subject<>NEW.subject OR OLD.description<>NEW.description OR OLD.created_at<>NEW.created_at THEN
    RAISE EXCEPTION 'support request source is immutable';
  END IF;
  IF OLD.status='CLOSED' THEN RAISE EXCEPTION 'closed support requests are immutable'; END IF;
  IF NOT app_is_super_admin() THEN
    IF OLD.status<>'RESOLVED' OR NEW.status<>'CLOSED' OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
      OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN RAISE EXCEPTION 'only the provider may update support request status'; END IF;
  ELSE
    IF NOT (
      NEW.status=OLD.status OR
      (OLD.status='NEW' AND NEW.status IN ('ACKNOWLEDGED','IN_PROGRESS')) OR
      (OLD.status='ACKNOWLEDGED' AND NEW.status IN ('IN_PROGRESS','WAITING_FOR_CLIENT','RESOLVED')) OR
      (OLD.status='IN_PROGRESS' AND NEW.status IN ('WAITING_FOR_CLIENT','RESOLVED')) OR
      (OLD.status='WAITING_FOR_CLIENT' AND NEW.status IN ('IN_PROGRESS','RESOLVED')) OR
      (OLD.status='RESOLVED' AND NEW.status IN ('IN_PROGRESS','CLOSED'))
    ) THEN RAISE EXCEPTION 'invalid support request status transition'; END IF;
  END IF;
  IF NEW.status IN ('RESOLVED','CLOSED') AND length(trim(COALESCE(NEW.resolution_note,'')))=0 THEN
    RAISE EXCEPTION 'a resolution note is required';
  END IF;
  IF NEW.status IN ('RESOLVED','CLOSED') THEN NEW.resolved_at:=COALESCE(OLD.resolved_at,now()); END IF;
  IF NEW.status NOT IN ('RESOLVED','CLOSED') THEN NEW.resolved_at:=NULL;NEW.closed_at:=NULL; END IF;
  IF NEW.status='CLOSED' THEN NEW.closed_at:=COALESCE(OLD.closed_at,now()); END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END
$$;
CREATE TRIGGER support_request_update_guard BEFORE UPDATE ON support_requests
FOR EACH ROW EXECUTE FUNCTION guard_support_request_update();
CREATE FUNCTION prevent_support_message_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'support request messages are append-only'; END $$;
CREATE TRIGGER support_request_messages_immutable BEFORE UPDATE OR DELETE ON support_request_messages
FOR EACH ROW EXECUTE FUNCTION prevent_support_message_mutation();

ALTER TABLE support_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY support_requests_scope ON support_requests
  USING (app_is_super_admin() OR app_has_client_access(client_id))
  WITH CHECK (app_is_super_admin() OR (opened_by=app_actor_id() AND app_has_client_access(client_id)));
ALTER TABLE support_request_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_request_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY support_messages_read_scope ON support_request_messages
  FOR SELECT USING (app_is_super_admin() OR (visibility='CLIENT' AND app_has_client_access(client_id)));
CREATE POLICY support_messages_insert_scope ON support_request_messages
  FOR INSERT WITH CHECK (
    app_is_super_admin() OR
    (visibility='CLIENT' AND actor_id=app_actor_id() AND app_has_client_access(client_id))
  );

GRANT SELECT,INSERT,UPDATE ON support_requests TO station_app;
GRANT SELECT,INSERT ON support_request_messages TO station_app;

RESET ROLE;
