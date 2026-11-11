SET ROLE station_owner;

CREATE FUNCTION validate_station_day_closing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_status text;
  batch_date date;
  inputs_status text;
  inputs_date date;
BEGIN
  SELECT status, business_date INTO batch_status, batch_date
  FROM meter_reading_batches
  WHERE client_id = NEW.client_id AND station_id = NEW.station_id AND id = NEW.meter_reading_batch_id;

  SELECT status, business_date INTO inputs_status, inputs_date
  FROM station_day_inputs
  WHERE client_id = NEW.client_id AND station_id = NEW.station_id AND id = NEW.station_day_input_id;

  IF batch_status IS DISTINCT FROM 'VALIDATED' OR inputs_status IS DISTINCT FROM 'VALIDATED'
    OR batch_date IS DISTINCT FROM NEW.business_date OR inputs_date IS DISTINCT FROM NEW.business_date THEN
    RAISE EXCEPTION 'station-day closing requires validated readings and inputs for the same business date'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER station_day_closings_validate
BEFORE INSERT ON station_day_closings
FOR EACH ROW EXECUTE FUNCTION validate_station_day_closing();

RESET ROLE;
