SET ROLE station_owner;

-- The daily entry screen needs one prior validated reading per active meter,
-- not every historical batch for the station. This partial index lets each
-- meter lookup walk validated station days from newest to oldest.
CREATE INDEX meter_reading_batches_validated_history_idx
  ON meter_reading_batches(client_id, station_id, business_date DESC, id)
  WHERE status = 'VALIDATED';

RESET ROLE;
