-- M8 platform business foundation. Commercial rates are explicit inputs; no prices or tax rules are inferred.
SET ROLE station_owner;

CREATE TABLE platform_subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,code)
);

CREATE TABLE platform_plan_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES platform_subscription_plans(id),
  effective_from date NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  monthly_base_fee numeric(14,2) NOT NULL CHECK (monthly_base_fee >= 0),
  monthly_station_fee numeric(14,2) NOT NULL CHECK (monthly_station_fee >= 0),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id,effective_from)
);

CREATE TABLE client_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  plan_id uuid NOT NULL REFERENCES platform_subscription_plans(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','PAUSED','CANCELLED')),
  effective_from date NOT NULL,
  effective_until date,
  contract_reference text,
  billing_day smallint NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 31),
  billing_time_zone text NOT NULL CHECK (length(trim(billing_time_zone)) BETWEEN 1 AND 80),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CHECK (status <> 'ACTIVE' OR length(trim(COALESCE(contract_reference,''))) > 0),
  UNIQUE (client_id,id)
);
CREATE UNIQUE INDEX client_single_live_subscription_idx ON client_subscriptions(client_id)
  WHERE status IN ('PENDING','ACTIVE','PAUSED');

CREATE FUNCTION guard_platform_subscription_state() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status='CANCELLED' OR NOT (
    (OLD.status='PENDING' AND NEW.status IN ('PENDING','ACTIVE','CANCELLED')) OR
    (OLD.status='ACTIVE' AND NEW.status IN ('ACTIVE','PAUSED','CANCELLED')) OR
    (OLD.status='PAUSED' AND NEW.status IN ('PAUSED','ACTIVE','CANCELLED'))
  ) THEN RAISE EXCEPTION 'invalid subscription state transition'; END IF;
  IF NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.plan_id<>OLD.plan_id
    OR NEW.effective_from<>OLD.effective_from OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'subscription identity and plan are immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER client_subscription_state_guard BEFORE UPDATE ON client_subscriptions
FOR EACH ROW EXECUTE FUNCTION guard_platform_subscription_state();

DO $$ DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['platform_subscription_plans','platform_plan_rates','client_subscriptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  END LOOP;
END $$;
CREATE POLICY platform_plans_admin ON platform_subscription_plans
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());
CREATE POLICY platform_rates_admin ON platform_plan_rates
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());
CREATE POLICY client_subscriptions_scope ON client_subscriptions
  USING (app_is_super_admin() OR app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']))
  WITH CHECK (app_is_super_admin());

DROP POLICY audit_events_insert_scope ON audit_events;
CREATE POLICY audit_events_insert_scope ON audit_events
  FOR INSERT WITH CHECK (
    app_is_super_admin()
    OR (client_id IS NOT NULL AND actor_id=app_actor_id() AND (
      (station_id IS NULL AND app_has_client_role(client_id,ARRAY['OWNER','MANAGER']))
      OR (station_id IS NULL AND entity_type IN ('client_invoice_profile','customer','customer_payment','issued_credit_note')
        AND app_has_client_role(client_id,ARRAY['ACCOUNTANT']))
      OR (station_id IS NOT NULL AND app_can_access_station(client_id,station_id))
    ))
  );

GRANT SELECT,INSERT,UPDATE ON platform_subscription_plans TO station_app;
GRANT SELECT,INSERT ON platform_plan_rates TO station_app;
GRANT SELECT,INSERT,UPDATE ON client_subscriptions TO station_app;

RESET ROLE;
