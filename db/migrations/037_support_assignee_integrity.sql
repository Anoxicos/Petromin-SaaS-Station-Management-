BEGIN;
SET ROLE station_owner;

CREATE FUNCTION validate_support_assignee() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
     AND NEW.assigned_to IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app_users WHERE id=NEW.assigned_to AND is_super_admin) THEN
    RAISE EXCEPTION 'support assignee must be a configured provider super-admin';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER support_assignee_integrity
BEFORE UPDATE OF assigned_to ON support_requests
FOR EACH ROW EXECUTE FUNCTION validate_support_assignee();

RESET ROLE;
COMMIT;
