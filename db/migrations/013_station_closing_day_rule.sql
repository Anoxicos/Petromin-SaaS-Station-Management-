SET ROLE station_owner;

ALTER TABLE stations ADD COLUMN closing_day_rule text;
ALTER TABLE stations ADD CONSTRAINT stations_closing_day_rule_check
  CHECK (closing_day_rule IS NULL OR closing_day_rule IN ('CUTOFF_STARTS_DAY', 'CUTOFF_ENDS_DAY'));

RESET ROLE;
