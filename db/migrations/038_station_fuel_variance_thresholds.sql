SET ROLE station_owner;

CREATE TABLE station_fuel_variance_thresholds (
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  product_id uuid NOT NULL,
  max_abs_variance numeric(14,3) NOT NULL CHECK (max_abs_variance >= 0),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id,station_id,product_id),
  FOREIGN KEY (client_id,station_id,product_id)
    REFERENCES station_products(client_id,station_id,product_id)
);

CREATE FUNCTION require_fuel_variance_product() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE product_kind text;
BEGIN
  SELECT product_type INTO product_kind FROM products
    WHERE client_id=NEW.client_id AND id=NEW.product_id;
  IF product_kind IS DISTINCT FROM 'FUEL' THEN
    RAISE EXCEPTION 'variance thresholds are only supported for assigned fuel products';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER station_fuel_variance_product_guard
BEFORE INSERT OR UPDATE ON station_fuel_variance_thresholds
FOR EACH ROW EXECUTE FUNCTION require_fuel_variance_product();

ALTER TABLE station_fuel_variance_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_fuel_variance_thresholds FORCE ROW LEVEL SECURITY;
CREATE POLICY station_fuel_variance_thresholds_scope ON station_fuel_variance_thresholds
  USING (app_can_access_station(client_id,station_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER']));
GRANT SELECT,INSERT,UPDATE,DELETE ON station_fuel_variance_thresholds TO station_app;

RESET ROLE;
