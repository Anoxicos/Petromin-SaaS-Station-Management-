SET ROLE station_owner;

-- Existing rows remain explicitly unassigned; no station currency is inferred.
ALTER TABLE station_day_inputs
  ADD COLUMN currency_code text CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$');

RESET ROLE;
