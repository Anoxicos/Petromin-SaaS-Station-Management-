SET ROLE station_owner;

CREATE TABLE station_cash_card_variance_thresholds (
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  max_abs_cash_variance numeric(14,2) CHECK (max_abs_cash_variance IS NULL OR max_abs_cash_variance >= 0),
  max_abs_card_variance numeric(14,2) CHECK (max_abs_card_variance IS NULL OR max_abs_card_variance >= 0),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id,station_id),
  FOREIGN KEY (client_id,station_id) REFERENCES stations(client_id,id),
  CHECK (max_abs_cash_variance IS NOT NULL OR max_abs_card_variance IS NOT NULL)
);

CREATE FUNCTION guard_station_cash_card_variance_actor() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.updated_by IS DISTINCT FROM app_actor_id() THEN
    RAISE EXCEPTION 'variance policy actor must match the authenticated user';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER station_cash_card_variance_actor_guard
BEFORE INSERT OR UPDATE ON station_cash_card_variance_thresholds
FOR EACH ROW EXECUTE FUNCTION guard_station_cash_card_variance_actor();

ALTER TABLE station_cash_card_variance_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_cash_card_variance_thresholds FORCE ROW LEVEL SECURITY;
CREATE POLICY station_cash_card_variance_scope ON station_cash_card_variance_thresholds
  USING (app_can_access_station(client_id,station_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER']) AND updated_by=app_actor_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON station_cash_card_variance_thresholds TO station_app;

ALTER TABLE station_day_reconciliations
  ADD COLUMN currency_code text CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  ADD COLUMN max_abs_cash_variance numeric(14,2) CHECK (max_abs_cash_variance IS NULL OR max_abs_cash_variance >= 0),
  ADD COLUMN max_abs_card_variance numeric(14,2) CHECK (max_abs_card_variance IS NULL OR max_abs_card_variance >= 0),
  ADD CONSTRAINT station_day_reconciliation_threshold_currency_check CHECK (
    (max_abs_cash_variance IS NULL AND max_abs_card_variance IS NULL) OR currency_code IS NOT NULL
  );

CREATE FUNCTION guard_reconciliation_threshold_snapshot() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE policy station_cash_card_variance_thresholds%ROWTYPE;
BEGIN
  SELECT * INTO policy FROM station_cash_card_variance_thresholds
  WHERE client_id=NEW.client_id AND station_id=NEW.station_id;
  IF FOUND THEN
    IF NEW.currency_code IS DISTINCT FROM policy.currency_code
       OR NEW.max_abs_cash_variance IS DISTINCT FROM policy.max_abs_cash_variance
       OR NEW.max_abs_card_variance IS DISTINCT FROM policy.max_abs_card_variance THEN
      RAISE EXCEPTION 'reconciliation currency and tolerance snapshot must match the station policy';
    END IF;
  ELSIF NEW.max_abs_cash_variance IS NOT NULL OR NEW.max_abs_card_variance IS NOT NULL THEN
    RAISE EXCEPTION 'reconciliation cannot include tolerance values without a station policy';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER station_day_reconciliation_threshold_snapshot_guard
BEFORE INSERT ON station_day_reconciliations
FOR EACH ROW EXECUTE FUNCTION guard_reconciliation_threshold_snapshot();

GRANT SELECT,INSERT ON station_day_reconciliations TO station_app;

RESET ROLE;
