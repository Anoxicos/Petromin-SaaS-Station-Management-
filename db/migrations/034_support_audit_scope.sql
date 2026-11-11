-- Permit client members to record the creation of support requests in the tenant audit log.
SET ROLE station_owner;
DROP POLICY audit_events_insert_scope ON audit_events;
CREATE POLICY audit_events_insert_scope ON audit_events
  FOR INSERT WITH CHECK (
    app_is_super_admin()
    OR (client_id IS NOT NULL AND actor_id=app_actor_id() AND (
      (station_id IS NULL AND app_has_client_role(client_id,ARRAY['OWNER','MANAGER']))
      OR (station_id IS NULL AND entity_type IN ('client_invoice_profile','customer','customer_payment','issued_credit_note','client_onboarding_task')
        AND app_has_client_role(client_id,ARRAY['ACCOUNTANT']))
      OR (station_id IS NULL AND entity_type='support_request' AND app_has_client_access(client_id))
      OR (station_id IS NOT NULL AND app_can_access_station(client_id,station_id))
    ))
  );
RESET ROLE;
