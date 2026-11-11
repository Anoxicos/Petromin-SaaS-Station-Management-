-- Make the support conversation actor and event type trustworthy at the database boundary.
SET ROLE station_owner;
CREATE FUNCTION guard_support_message_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE request_status text;
BEGIN
  IF NEW.actor_id IS DISTINCT FROM app_actor_id() THEN
    RAISE EXCEPTION 'support message actor must be the current authenticated actor';
  END IF;
  SELECT status INTO request_status FROM support_requests
    WHERE client_id=NEW.client_id AND id=NEW.support_request_id;
  IF request_status IS NULL THEN RAISE EXCEPTION 'support request not found'; END IF;
  IF request_status='CLOSED' THEN RAISE EXCEPTION 'closed support requests cannot receive messages'; END IF;
  IF NOT app_is_super_admin() AND (
    NEW.message_type<>'MESSAGE' OR NEW.visibility<>'CLIENT' OR NOT app_has_client_access(NEW.client_id)
  ) THEN
    RAISE EXCEPTION 'client members may add only their own client-visible messages';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER support_message_insert_guard BEFORE INSERT ON support_request_messages
FOR EACH ROW EXECUTE FUNCTION guard_support_message_insert();
RESET ROLE;
