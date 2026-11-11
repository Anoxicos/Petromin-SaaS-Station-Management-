-- Rollback-only coverage for workspace discovery and default membership selection.
BEGIN;

INSERT INTO clients (id, name, code) VALUES
  ('12000000-0000-4000-8000-000000000001', 'Workspace A', 'WORKSPACE_A'),
  ('12000000-0000-4000-8000-000000000002', 'Workspace B', 'WORKSPACE_B'),
  ('12000000-0000-4000-8000-000000000003', 'Workspace C', 'WORKSPACE_C');

INSERT INTO app_users (id, auth_subject, email, display_name, is_super_admin) VALUES
  ('22000000-0000-4000-8000-000000000001', 'workspace-owner', 'workspace-owner@example.invalid', 'Workspace Owner', false),
  ('22000000-0000-4000-8000-000000000002', 'workspace-cashier', 'workspace-cashier@example.invalid', 'Workspace Cashier', false),
  ('22000000-0000-4000-8000-000000000003', 'workspace-admin', 'workspace-admin@example.invalid', 'Workspace Admin', true);

INSERT INTO client_memberships (client_id, user_id, role) VALUES
  ('12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'OWNER'),
  ('12000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001', 'ACCOUNTANT'),
  ('12000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002', 'CASHIER');

INSERT INTO stations (id, client_id, code, name, meter_mode, closing_cutoff, time_zone, closing_day_rule) VALUES
  ('32000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', 'WORKSPACE_A1', 'Workspace A Station 1', 'NOZZLE', '23:00', 'Africa/Casablanca', 'CUTOFF_ENDS_DAY'),
  ('32000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000001', 'WORKSPACE_A2', 'Workspace A Station 2', 'PUMP_TOTALIZER', '01:00', 'Africa/Casablanca', 'CUTOFF_ENDS_DAY'),
  ('32000000-0000-4000-8000-000000000003', '12000000-0000-4000-8000-000000000002', 'WORKSPACE_B1', 'Workspace B Station 1', 'NOZZLE', '23:00', 'Africa/Casablanca', 'CUTOFF_ENDS_DAY'),
  ('32000000-0000-4000-8000-000000000004', '12000000-0000-4000-8000-000000000003', 'WORKSPACE_C1', 'Workspace C Station 1', 'NOZZLE', '23:00', 'Africa/Casablanca', 'CUTOFF_ENDS_DAY');

INSERT INTO station_memberships (client_id, station_id, user_id) VALUES
  ('12000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000002');

SET LOCAL ROLE station_app;
SELECT set_config('app.actor_id', '22000000-0000-4000-8000-000000000002', true);
SELECT set_config('app.client_id', '12000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.role', 'CASHIER', true);

DO $$
DECLARE
  workspace_data jsonb;
  selected_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_resolve_principal('workspace-owner', NULL)
    WHERE client_id = '12000000-0000-4000-8000-000000000001' AND role = 'OWNER'
  ) THEN RAISE EXCEPTION 'a client member without a selected client did not resolve to a default workspace'; END IF;

  workspace_data := app_list_workspaces();
  IF jsonb_array_length(workspace_data) <> 1
     OR workspace_data #>> '{0,clientId}' <> '12000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'cashier workspace discovery exposed another client';
  END IF;
  selected_count := jsonb_array_length(workspace_data #> '{0,stations}');
  IF selected_count <> 1
     OR workspace_data #>> '{0,stations,0,stationId}' <> '32000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'cashier workspace discovery exposed an unassigned station';
  END IF;
END
$$;

SELECT set_config('app.actor_id', '22000000-0000-4000-8000-000000000003', true);
SELECT set_config('app.client_id', '', true);
SELECT set_config('app.role', 'SUPER_ADMIN', true);

DO $$
DECLARE
  workspace_data jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_resolve_principal('workspace-admin', NULL)
    WHERE client_id IS NULL AND role = 'SUPER_ADMIN'
  ) THEN RAISE EXCEPTION 'super-admin without a selected client did not resolve'; END IF;
  workspace_data := app_list_workspaces();
  IF jsonb_array_length(workspace_data) <> 3 THEN
    RAISE EXCEPTION 'super-admin should discover every tenant workspace';
  END IF;
END
$$;

ROLLBACK;
