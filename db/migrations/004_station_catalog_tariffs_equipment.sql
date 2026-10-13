CREATE EXTENSION IF NOT EXISTS btree_gist;

SET ROLE station_owner;

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  product_type text NOT NULL CHECK (product_type IN ('FUEL', 'ARTICLE', 'SERVICE')),
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Z][A-Z0-9_-]{0,15}$'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (client_id, code)
);

CREATE TABLE station_products (
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  product_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, station_id, product_id),
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id),
  FOREIGN KEY (client_id, product_id) REFERENCES products(client_id, id)
);

CREATE TABLE fuel_tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_price numeric(14, 4) NOT NULL CHECK (unit_price >= 0),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, product_id)
    REFERENCES station_products(client_id, station_id, product_id),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  EXCLUDE USING gist (
    client_id WITH =,
    station_id WITH =,
    product_id WITH =,
    tstzrange(valid_from, valid_until, '[)') WITH &&
  )
);

CREATE TABLE station_equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  kind text NOT NULL CHECK (kind IN ('PUMP', 'METER', 'NOZZLE', 'TANK')),
  serial_number text,
  parent_equipment_id uuid,
  product_id uuid,
  installed_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, station_id, id),
  UNIQUE (client_id, station_id, code),
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id),
  FOREIGN KEY (client_id, product_id) REFERENCES products(client_id, id),
  FOREIGN KEY (client_id, station_id, product_id)
    REFERENCES station_products(client_id, station_id, product_id),
  FOREIGN KEY (client_id, station_id, parent_equipment_id)
    REFERENCES station_equipment(client_id, station_id, id),
  CHECK (parent_equipment_id IS NULL OR parent_equipment_id <> id),
  CHECK (kind <> 'NOZZLE' OR parent_equipment_id IS NOT NULL),
  CHECK (kind <> 'TANK' OR parent_equipment_id IS NULL),
  CHECK (
    (kind IN ('NOZZLE', 'TANK') AND product_id IS NOT NULL)
    OR (kind IN ('PUMP', 'METER') AND product_id IS NULL)
  ),
  CHECK (retired_at IS NULL OR retired_at > installed_at)
);

CREATE TABLE nozzle_tank_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  nozzle_id uuid NOT NULL,
  tank_id uuid NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, nozzle_id)
    REFERENCES station_equipment(client_id, station_id, id),
  FOREIGN KEY (client_id, station_id, tank_id)
    REFERENCES station_equipment(client_id, station_id, id),
  CHECK (nozzle_id <> tank_id),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  EXCLUDE USING gist (
    client_id WITH =,
    station_id WITH =,
    nozzle_id WITH =,
    tstzrange(valid_from, valid_until, '[)') WITH &&
  )
);

CREATE FUNCTION validate_fuel_tariff() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tariff_product_type text;
BEGIN
  SELECT product_type INTO tariff_product_type
  FROM products
  WHERE client_id = NEW.client_id AND id = NEW.product_id;
  IF tariff_product_type IS DISTINCT FROM 'FUEL' THEN
    RAISE EXCEPTION 'fuel tariffs can only be assigned to fuel products'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER fuel_tariff_product_validate
BEFORE INSERT OR UPDATE ON fuel_tariffs
FOR EACH ROW EXECUTE FUNCTION validate_fuel_tariff();

CREATE FUNCTION validate_nozzle_tank_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  nozzle_kind text;
  nozzle_product uuid;
  tank_kind text;
  tank_product uuid;
BEGIN
  SELECT kind, product_id INTO nozzle_kind, nozzle_product
  FROM station_equipment
  WHERE client_id = NEW.client_id AND station_id = NEW.station_id AND id = NEW.nozzle_id;
  SELECT kind, product_id INTO tank_kind, tank_product
  FROM station_equipment
  WHERE client_id = NEW.client_id AND station_id = NEW.station_id AND id = NEW.tank_id;

  IF nozzle_kind IS DISTINCT FROM 'NOZZLE' OR tank_kind IS DISTINCT FROM 'TANK' THEN
    RAISE EXCEPTION 'nozzle_tank_assignments must reference a nozzle and a tank'
      USING ERRCODE = '23514';
  END IF;
  IF nozzle_product IS DISTINCT FROM tank_product THEN
    RAISE EXCEPTION 'assigned nozzle and tank must use the same product'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION validate_station_equipment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  equipment_product_type text;
BEGIN
  IF NEW.kind IN ('NOZZLE', 'TANK') THEN
    SELECT p.product_type INTO equipment_product_type
    FROM station_products sp
    JOIN products p ON p.client_id = sp.client_id AND p.id = sp.product_id
    WHERE sp.client_id = NEW.client_id
      AND sp.station_id = NEW.station_id
      AND sp.product_id = NEW.product_id;
    IF equipment_product_type IS DISTINCT FROM 'FUEL' THEN
      RAISE EXCEPTION 'nozzles and tanks must use a fuel product assigned to the station'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER station_equipment_product_validate
BEFORE INSERT OR UPDATE ON station_equipment
FOR EACH ROW EXECUTE FUNCTION validate_station_equipment();

CREATE TRIGGER nozzle_tank_assignment_validate
BEFORE INSERT OR UPDATE ON nozzle_tank_assignments
FOR EACH ROW EXECUTE FUNCTION validate_nozzle_tank_assignment();

CREATE INDEX products_client_active_idx ON products(client_id, is_active, name);
CREATE INDEX station_products_station_idx ON station_products(client_id, station_id);
CREATE INDEX fuel_tariffs_lookup_idx ON fuel_tariffs(client_id, station_id, product_id, valid_from DESC);
CREATE INDEX station_equipment_station_idx ON station_equipment(client_id, station_id, kind);
CREATE INDEX nozzle_tank_assignment_history_idx
  ON nozzle_tank_assignments(client_id, station_id, nozzle_id, valid_from DESC);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY products_client_scope ON products
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']));

ALTER TABLE station_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_products FORCE ROW LEVEL SECURITY;
CREATE POLICY station_products_scope ON station_products
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (
    app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER'])
    AND app_can_access_station(client_id, station_id)
  );

ALTER TABLE fuel_tariffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_tariffs FORCE ROW LEVEL SECURITY;
CREATE POLICY fuel_tariffs_scope ON fuel_tariffs
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (
    app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER'])
    AND app_can_access_station(client_id, station_id)
  );

ALTER TABLE station_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_equipment FORCE ROW LEVEL SECURITY;
CREATE POLICY station_equipment_scope ON station_equipment
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (
    app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER'])
    AND app_can_access_station(client_id, station_id)
  );

ALTER TABLE nozzle_tank_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nozzle_tank_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY nozzle_tank_assignments_scope ON nozzle_tank_assignments
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (
    app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER'])
    AND app_can_access_station(client_id, station_id)
  );

GRANT SELECT, INSERT, UPDATE ON products TO station_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON station_products TO station_app;
GRANT SELECT, INSERT, UPDATE ON fuel_tariffs TO station_app;
GRANT SELECT, INSERT, UPDATE ON station_equipment TO station_app;
GRANT SELECT, INSERT, UPDATE ON nozzle_tank_assignments TO station_app;
REVOKE EXECUTE ON FUNCTION validate_fuel_tariff() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_station_equipment() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_nozzle_tank_assignment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION validate_fuel_tariff() TO station_app;
GRANT EXECUTE ON FUNCTION validate_station_equipment() TO station_app;
GRANT EXECUTE ON FUNCTION validate_nozzle_tank_assignment() TO station_app;

RESET ROLE;
