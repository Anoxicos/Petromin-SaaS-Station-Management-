SET ROLE station_owner;

CREATE TABLE tank_calibrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  tank_id uuid NOT NULL,
  effective_from date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid REFERENCES app_users(id),
  activated_at timestamptz,
  FOREIGN KEY (client_id, station_id, tank_id)
    REFERENCES station_equipment(client_id, station_id, id),
  UNIQUE (client_id, station_id, tank_id, effective_from),
  UNIQUE (client_id, station_id, id),
  CHECK ((status = 'DRAFT' AND activated_by IS NULL AND activated_at IS NULL)
      OR (status = 'ACTIVE' AND activated_by IS NOT NULL AND activated_at IS NOT NULL))
);

CREATE TABLE tank_calibration_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  calibration_id uuid NOT NULL,
  depth_mm numeric(14, 3) NOT NULL CHECK (depth_mm >= 0),
  volume_liters numeric(14, 3) NOT NULL CHECK (volume_liters >= 0),
  FOREIGN KEY (client_id, station_id, calibration_id)
    REFERENCES tank_calibrations(client_id, station_id, id) ON DELETE CASCADE,
  UNIQUE (calibration_id, depth_mm)
);

CREATE INDEX tank_calibrations_tank_history_idx
  ON tank_calibrations(client_id, station_id, tank_id, effective_from DESC);
CREATE INDEX tank_calibration_points_lookup_idx
  ON tank_calibration_points(calibration_id, depth_mm);

CREATE FUNCTION validate_tank_calibration_tank() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  equipment_kind text;
BEGIN
  SELECT kind INTO equipment_kind FROM station_equipment
  WHERE client_id = NEW.client_id AND station_id = NEW.station_id AND id = NEW.tank_id;
  IF equipment_kind IS DISTINCT FROM 'TANK' THEN
    RAISE EXCEPTION 'tank calibration must reference tank equipment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tank_calibrations_tank_validate
BEFORE INSERT OR UPDATE ON tank_calibrations
FOR EACH ROW EXECUTE FUNCTION validate_tank_calibration_tank();

CREATE FUNCTION guard_tank_calibration_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'ACTIVE' THEN
    RAISE EXCEPTION 'active tank calibrations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tank_calibrations_locked
BEFORE UPDATE OR DELETE ON tank_calibrations
FOR EACH ROW EXECUTE FUNCTION guard_tank_calibration_mutation();

CREATE FUNCTION guard_tank_calibration_point_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_calibration uuid;
BEGIN
  target_calibration := CASE WHEN TG_OP = 'DELETE' THEN OLD.calibration_id ELSE NEW.calibration_id END;
  IF EXISTS (SELECT 1 FROM tank_calibrations WHERE id = target_calibration AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'active tank calibration points are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tank_calibration_points_locked
BEFORE INSERT OR UPDATE OR DELETE ON tank_calibration_points
FOR EACH ROW EXECUTE FUNCTION guard_tank_calibration_point_mutation();

CREATE FUNCTION validate_tank_calibration_activation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  point_count bigint;
  non_increasing_count bigint;
  previous_effective_date date;
BEGIN
  IF OLD.status <> 'DRAFT' OR NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'tank calibration can only transition once from draft to active'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*), count(*) FILTER (
    WHERE previous_depth IS NOT NULL
      AND (depth_mm <= previous_depth OR volume_liters <= previous_volume)
  ) INTO point_count, non_increasing_count
  FROM (
    SELECT depth_mm, volume_liters,
      lag(depth_mm) OVER (ORDER BY depth_mm) AS previous_depth,
      lag(volume_liters) OVER (ORDER BY depth_mm) AS previous_volume
    FROM tank_calibration_points WHERE calibration_id = NEW.id
  ) ordered_points;
  IF point_count < 2 OR non_increasing_count > 0 THEN
    RAISE EXCEPTION 'tank calibration requires at least two points with strictly increasing depth and volume'
      USING ERRCODE = '23514';
  END IF;

  SELECT max(effective_from) INTO previous_effective_date
  FROM tank_calibrations
  WHERE client_id = NEW.client_id AND station_id = NEW.station_id AND tank_id = NEW.tank_id
    AND status = 'ACTIVE' AND id <> NEW.id;
  IF previous_effective_date IS NOT NULL AND NEW.effective_from <= previous_effective_date THEN
    RAISE EXCEPTION 'a new tank calibration must take effect after the latest active calibration'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tank_calibrations_activate_validate
BEFORE UPDATE OF status ON tank_calibrations
FOR EACH ROW EXECUTE FUNCTION validate_tank_calibration_activation();

CREATE FUNCTION tank_volume_at_depth(
  p_client_id uuid, p_station_id uuid, p_tank_id uuid, p_business_date date, p_depth_mm numeric
) RETURNS numeric
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN low_point.depth_mm IS NULL OR high_point.depth_mm IS NULL THEN NULL
    WHEN low_point.depth_mm = high_point.depth_mm THEN low_point.volume_liters
    ELSE round(low_point.volume_liters +
      ((p_depth_mm - low_point.depth_mm) * (high_point.volume_liters - low_point.volume_liters)
       / (high_point.depth_mm - low_point.depth_mm)), 3)
  END
  FROM (SELECT 1) one_row
  LEFT JOIN LATERAL (
    SELECT point.depth_mm, point.volume_liters
    FROM tank_calibrations calibration
    JOIN tank_calibration_points point ON point.calibration_id = calibration.id
      AND point.client_id = calibration.client_id AND point.station_id = calibration.station_id
    WHERE calibration.client_id = p_client_id AND calibration.station_id = p_station_id
      AND calibration.tank_id = p_tank_id AND calibration.status = 'ACTIVE'
      AND calibration.effective_from <= p_business_date
      AND point.depth_mm <= p_depth_mm
    ORDER BY calibration.effective_from DESC, point.depth_mm DESC LIMIT 1
  ) low_point ON true
  LEFT JOIN LATERAL (
    SELECT point.depth_mm, point.volume_liters
    FROM tank_calibrations calibration
    JOIN tank_calibration_points point ON point.calibration_id = calibration.id
      AND point.client_id = calibration.client_id AND point.station_id = calibration.station_id
    WHERE calibration.client_id = p_client_id AND calibration.station_id = p_station_id
      AND calibration.tank_id = p_tank_id AND calibration.status = 'ACTIVE'
      AND calibration.effective_from <= p_business_date
      AND point.depth_mm >= p_depth_mm
      AND calibration.effective_from = (
        SELECT max(latest.effective_from) FROM tank_calibrations latest
        WHERE latest.client_id = p_client_id AND latest.station_id = p_station_id
          AND latest.tank_id = p_tank_id AND latest.status = 'ACTIVE'
          AND latest.effective_from <= p_business_date
      )
    ORDER BY point.depth_mm LIMIT 1
  ) high_point ON true
  WHERE low_point.depth_mm IS NULL OR low_point.depth_mm = high_point.depth_mm
     OR high_point.depth_mm IS NOT NULL
$$;

ALTER TABLE tank_calibrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tank_calibrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tank_calibrations_station_scope ON tank_calibrations
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

ALTER TABLE tank_calibration_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE tank_calibration_points FORCE ROW LEVEL SECURITY;
CREATE POLICY tank_calibration_points_station_scope ON tank_calibration_points
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON tank_calibrations TO station_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tank_calibration_points TO station_app;
GRANT EXECUTE ON FUNCTION tank_volume_at_depth(uuid, uuid, uuid, date, numeric) TO station_app;

RESET ROLE;
