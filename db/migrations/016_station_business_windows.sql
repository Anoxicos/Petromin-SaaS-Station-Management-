SET ROLE station_owner;

CREATE FUNCTION station_business_window(
  business_date date,
  closing_cutoff time without time zone,
  time_zone text,
  closing_day_rule text
) RETURNS TABLE(start_at timestamptz, end_at timestamptz)
LANGUAGE plpgsql STABLE STRICT
AS $$
BEGIN
  IF closing_day_rule NOT IN ('CUTOFF_STARTS_DAY', 'CUTOFF_ENDS_DAY') THEN
    RAISE EXCEPTION 'unsupported station closing-day rule';
  END IF;

  RETURN QUERY
  SELECT (((business_date + CASE WHEN closing_day_rule = 'CUTOFF_ENDS_DAY' THEN -1 ELSE 0 END)
              + closing_cutoff) AT TIME ZONE time_zone),
         (((business_date + CASE WHEN closing_day_rule = 'CUTOFF_ENDS_DAY' THEN 0 ELSE 1 END)
              + closing_cutoff) AT TIME ZONE time_zone);
END
$$;

GRANT EXECUTE ON FUNCTION station_business_window(date, time without time zone, text, text) TO station_app;

RESET ROLE;
