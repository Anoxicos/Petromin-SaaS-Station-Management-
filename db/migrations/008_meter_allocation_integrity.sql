SET ROLE station_owner;

CREATE FUNCTION validate_meter_product_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  station_mode text;
  product_kind text;
BEGIN
  SELECT s.meter_mode, p.product_type
    INTO station_mode, product_kind
  FROM meter_readings r
  JOIN meter_reading_batches b ON b.client_id = r.client_id
    AND b.station_id = r.station_id AND b.id = r.batch_id
  JOIN stations s ON s.client_id = b.client_id AND s.id = b.station_id
  JOIN station_products sp ON sp.client_id = NEW.client_id
    AND sp.station_id = NEW.station_id AND sp.product_id = NEW.product_id
  JOIN products p ON p.client_id = sp.client_id AND p.id = sp.product_id
  WHERE r.id = NEW.reading_id AND r.client_id = NEW.client_id AND r.station_id = NEW.station_id;

  IF station_mode IS DISTINCT FROM 'PUMP_TOTALIZER' OR product_kind IS DISTINCT FROM 'FUEL' THEN
    RAISE EXCEPTION 'product allocations require a pump-totalizer reading and an assigned fuel product'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER meter_reading_product_allocation_validate
BEFORE INSERT OR UPDATE ON meter_reading_product_allocations
FOR EACH ROW EXECUTE FUNCTION validate_meter_product_allocation();

CREATE FUNCTION validate_meter_batch_allocations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  station_mode text;
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status = 'VALIDATED' THEN
    SELECT meter_mode INTO station_mode
    FROM stations
    WHERE client_id = NEW.client_id AND id = NEW.station_id;

    IF station_mode = 'NOZZLE' THEN
      IF EXISTS (
        SELECT 1 FROM meter_reading_product_allocations a
        JOIN meter_readings r ON r.client_id = a.client_id
          AND r.station_id = a.station_id AND r.id = a.reading_id
        WHERE r.batch_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'nozzle readings cannot have manual product allocations'
          USING ERRCODE = '23514';
      END IF;
    ELSIF station_mode = 'PUMP_TOTALIZER' THEN
      IF EXISTS (
        SELECT 1
        FROM meter_readings r
        LEFT JOIN LATERAL (
          SELECT count(*) AS allocation_count, COALESCE(sum(a.volume), 0) AS allocated_volume
          FROM meter_reading_product_allocations a
          WHERE a.client_id = r.client_id AND a.station_id = r.station_id AND a.reading_id = r.id
        ) allocation ON true
        WHERE r.batch_id = NEW.id
          AND (allocation.allocation_count = 0
            OR allocation.allocated_volume <> r.final_index - r.initial_index)
      ) THEN
        RAISE EXCEPTION 'pump-totalizer product allocations must equal each meter volume'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'station meter mode is invalid';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER meter_reading_batch_allocation_validate
BEFORE UPDATE OF status ON meter_reading_batches
FOR EACH ROW EXECUTE FUNCTION validate_meter_batch_allocations();

RESET ROLE;
