-- Draft platform charge statements snapshot supplied contract rates; they are not tax invoices or payment charges.
SET ROLE station_owner;

CREATE TABLE platform_billing_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  plan_rate_id uuid NOT NULL REFERENCES platform_plan_rates(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  station_count integer NOT NULL CHECK (station_count >= 0),
  monthly_base_fee numeric(14,2) NOT NULL CHECK (monthly_base_fee >= 0),
  monthly_station_fee numeric(14,2) NOT NULL CHECK (monthly_station_fee >= 0),
  amount_before_tax numeric(14,2) NOT NULL CHECK (amount_before_tax >= 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','VOID')),
  status_reason text,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES app_users(id),
  reviewed_at timestamptz,
  FOREIGN KEY (client_id,subscription_id) REFERENCES client_subscriptions(client_id,id),
  UNIQUE (client_id,subscription_id,period_start,period_end),
  CHECK (period_end >= period_start),
  CHECK (amount_before_tax = round(monthly_base_fee + monthly_station_fee * station_count,2)),
  CHECK ((status='DRAFT' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (status<>'DRAFT' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE FUNCTION guard_platform_billing_statement() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'billing statement snapshot is immutable'; END IF;
  IF OLD.status<>'DRAFT' OR NEW.status NOT IN ('APPROVED','VOID')
    OR NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.subscription_id<>OLD.subscription_id
    OR NEW.plan_rate_id<>OLD.plan_rate_id OR NEW.period_start<>OLD.period_start OR NEW.period_end<>OLD.period_end
    OR NEW.currency_code<>OLD.currency_code OR NEW.station_count<>OLD.station_count
    OR NEW.monthly_base_fee<>OLD.monthly_base_fee OR NEW.monthly_station_fee<>OLD.monthly_station_fee
    OR NEW.amount_before_tax<>OLD.amount_before_tax OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'billing statement snapshot is immutable';
  END IF;
  IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN RAISE EXCEPTION 'review identity and time are required'; END IF;
  IF NEW.status='VOID' AND length(trim(COALESCE(NEW.status_reason,'')))=0 THEN RAISE EXCEPTION 'void reason is required'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_billing_statement_guard BEFORE UPDATE OR DELETE ON platform_billing_statements
FOR EACH ROW EXECUTE FUNCTION guard_platform_billing_statement();

ALTER TABLE platform_billing_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_billing_statements FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_billing_statements_scope ON platform_billing_statements
  USING (app_is_super_admin() OR app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']))
  WITH CHECK (app_is_super_admin());
GRANT SELECT,INSERT,UPDATE ON platform_billing_statements TO station_app;

RESET ROLE;
