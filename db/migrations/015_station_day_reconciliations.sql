SET ROLE station_owner;

CREATE TABLE station_day_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  day_input_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  reported_cash_total numeric(14, 2) NOT NULL CHECK (reported_cash_total >= 0),
  reported_card_total numeric(14, 2) NOT NULL CHECK (reported_card_total >= 0),
  counted_cash_total numeric(14, 2) NOT NULL CHECK (counted_cash_total >= 0),
  card_settlement_total numeric(14, 2) NOT NULL CHECK (card_settlement_total >= 0),
  cash_variance numeric(14, 2) GENERATED ALWAYS AS (counted_cash_total - reported_cash_total) STORED,
  card_variance numeric(14, 2) GENERATED ALWAYS AS (card_settlement_total - reported_card_total) STORED,
  card_settlement_reference text CHECK (card_settlement_reference IS NULL OR length(trim(card_settlement_reference)) <= 120),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, day_input_id)
    REFERENCES station_day_inputs(client_id, station_id, id),
  UNIQUE (day_input_id, revision_number),
  UNIQUE (client_id, station_id, id)
);

CREATE INDEX station_day_reconciliations_history_idx
  ON station_day_reconciliations(client_id, station_id, day_input_id, revision_number DESC);

CREATE FUNCTION prevent_station_day_reconciliation_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'station-day reconciliations are immutable';
END
$$;

CREATE TRIGGER station_day_reconciliations_immutable
BEFORE UPDATE OR DELETE ON station_day_reconciliations
FOR EACH ROW EXECUTE FUNCTION prevent_station_day_reconciliation_mutation();

ALTER TABLE station_day_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_day_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY station_day_reconciliations_station_scope ON station_day_reconciliations
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

GRANT SELECT, INSERT ON station_day_reconciliations TO station_app;

RESET ROLE;
