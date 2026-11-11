-- Interpolate a supplied tank chart at a measured depth; out-of-chart values stay unknown.
SET ROLE station_owner;
CREATE FUNCTION tank_volume_at_depth(target_calibration uuid,target_depth numeric)
RETURNS numeric LANGUAGE sql STABLE
SET search_path=public,pg_temp
AS $$
  WITH bounds AS (
    SELECT
      (SELECT point.depth_mm FROM tank_calibration_points point
       WHERE point.calibration_id=target_calibration AND point.depth_mm<=target_depth
       ORDER BY point.depth_mm DESC LIMIT 1) AS lower_depth,
      (SELECT point.volume_liters FROM tank_calibration_points point
       WHERE point.calibration_id=target_calibration AND point.depth_mm<=target_depth
       ORDER BY point.depth_mm DESC LIMIT 1) AS lower_volume,
      (SELECT point.depth_mm FROM tank_calibration_points point
       WHERE point.calibration_id=target_calibration AND point.depth_mm>=target_depth
       ORDER BY point.depth_mm LIMIT 1) AS upper_depth,
      (SELECT point.volume_liters FROM tank_calibration_points point
       WHERE point.calibration_id=target_calibration AND point.depth_mm>=target_depth
       ORDER BY point.depth_mm LIMIT 1) AS upper_volume
  )
  SELECT CASE WHEN lower_depth IS NULL OR upper_depth IS NULL THEN NULL
    WHEN lower_depth=upper_depth THEN lower_volume
    ELSE lower_volume+(target_depth-lower_depth)*(upper_volume-lower_volume)/(upper_depth-lower_depth)
    END
  FROM bounds
$$;
GRANT EXECUTE ON FUNCTION tank_volume_at_depth(uuid,numeric) TO station_app;
RESET ROLE;
