-- M4 purchasing, stock ledger, and service component consumption.
SET ROLE station_owner;

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  contact_email text,
  contact_phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id,id),
  UNIQUE (client_id,code)
);

CREATE TABLE purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_reference text,
  business_date date NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES app_users(id),
  posted_at timestamptz,
  FOREIGN KEY (client_id,station_id) REFERENCES stations(client_id,id),
  FOREIGN KEY (client_id,supplier_id) REFERENCES suppliers(client_id,id),
  UNIQUE (client_id,station_id,id),
  CHECK ((status='DRAFT' AND posted_by IS NULL AND posted_at IS NULL)
      OR (status='POSTED' AND posted_by IS NOT NULL AND posted_at IS NOT NULL))
);

CREATE TABLE purchase_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  product_id uuid NOT NULL,
  tank_id uuid,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  FOREIGN KEY (client_id,station_id,receipt_id) REFERENCES purchase_receipts(client_id,station_id,id),
  FOREIGN KEY (client_id,station_id,product_id) REFERENCES station_products(client_id,station_id,product_id),
  FOREIGN KEY (client_id,station_id,tank_id) REFERENCES station_equipment(client_id,station_id,id),
  UNIQUE (client_id,station_id,id)
);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  product_id uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('OPENING_BALANCE','PURCHASE_RECEIPT','ARTICLE_SALE','SERVICE_COMPONENT','ADJUSTMENT')),
  quantity_delta numeric(14,3) NOT NULL CHECK (quantity_delta <> 0),
  business_date date NOT NULL,
  source_id uuid NOT NULL,
  reason text,
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id,station_id,product_id) REFERENCES station_products(client_id,station_id,product_id),
  UNIQUE (client_id,movement_type,source_id,product_id),
  CHECK (movement_type NOT IN ('OPENING_BALANCE','ADJUSTMENT') OR length(trim(COALESCE(reason,''))) > 0)
);

CREATE TABLE service_components (
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  service_product_id uuid NOT NULL,
  component_product_id uuid NOT NULL,
  quantity_per_service numeric(14,3) NOT NULL CHECK (quantity_per_service > 0),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id,station_id,service_product_id,component_product_id),
  FOREIGN KEY (client_id,station_id,service_product_id) REFERENCES station_products(client_id,station_id,product_id),
  FOREIGN KEY (client_id,station_id,component_product_id) REFERENCES station_products(client_id,station_id,product_id),
  CHECK (service_product_id <> component_product_id)
);

CREATE FUNCTION validate_purchase_receipt_line() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE ptype text; ttype text; tank_product uuid;
BEGIN
  SELECT product.product_type INTO ptype FROM products product
  WHERE product.client_id=NEW.client_id AND product.id=NEW.product_id AND product.is_active;
  IF ptype IS NULL OR ptype='SERVICE' THEN RAISE EXCEPTION 'purchase receipt needs an active fuel or article product'; END IF;
  IF NEW.tank_id IS NOT NULL THEN
    SELECT equipment.kind,equipment.product_id INTO ttype,tank_product FROM station_equipment equipment
    WHERE equipment.client_id=NEW.client_id AND equipment.station_id=NEW.station_id AND equipment.id=NEW.tank_id AND equipment.retired_at IS NULL;
    IF ttype IS DISTINCT FROM 'TANK' OR tank_product IS DISTINCT FROM NEW.product_id THEN
      RAISE EXCEPTION 'receipt tank must be active and assigned to the same product';
    END IF;
  ELSIF ptype='FUEL' THEN
    RAISE EXCEPTION 'fuel receipts must be assigned to a tank';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER purchase_receipt_line_guard BEFORE INSERT OR UPDATE ON purchase_receipt_lines
FOR EACH ROW EXECUTE FUNCTION validate_purchase_receipt_line();

CREATE FUNCTION guard_receipt_line_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE receipt_status text; target_receipt uuid;
BEGIN
  target_receipt:=CASE WHEN TG_OP='DELETE' THEN OLD.receipt_id ELSE NEW.receipt_id END;
  SELECT status INTO receipt_status FROM purchase_receipts WHERE id=target_receipt;
  IF receipt_status<>'DRAFT' THEN RAISE EXCEPTION 'posted purchase receipts are immutable'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER purchase_receipt_lines_immutable AFTER INSERT OR UPDATE OR DELETE ON purchase_receipt_lines
FOR EACH ROW EXECUTE FUNCTION guard_receipt_line_mutation();

CREATE FUNCTION post_purchase_receipt() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE line purchase_receipt_lines%ROWTYPE;
BEGIN
  IF OLD.status<>'DRAFT' THEN RAISE EXCEPTION 'posted purchase receipts are immutable'; END IF;
  IF NEW.status='POSTED' THEN
    IF NOT EXISTS (SELECT 1 FROM purchase_receipt_lines WHERE receipt_id=NEW.id) THEN RAISE EXCEPTION 'purchase receipt needs at least one line'; END IF;
    FOR line IN SELECT * FROM purchase_receipt_lines WHERE receipt_id=NEW.id LOOP
      INSERT INTO stock_movements (client_id,station_id,product_id,movement_type,quantity_delta,business_date,source_id,recorded_by)
      VALUES (NEW.client_id,NEW.station_id,line.product_id,'PURCHASE_RECEIPT',line.quantity,NEW.business_date,line.id,NEW.posted_by);
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER purchase_receipt_posting_guard BEFORE UPDATE ON purchase_receipts
FOR EACH ROW EXECUTE FUNCTION post_purchase_receipt();

CREATE FUNCTION record_sale_stock_movements() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE line record;
BEGIN
  IF OLD.status='DRAFT' AND NEW.status='POSTED' THEN
    FOR line IN
      SELECT sale_line.id,sale_line.product_id,sale_line.quantity,product.product_type
      FROM sales_transaction_lines sale_line JOIN products product
        ON product.client_id=sale_line.client_id AND product.id=sale_line.product_id
      WHERE sale_line.client_id=NEW.client_id AND sale_line.station_id=NEW.station_id AND sale_line.sale_id=NEW.id
    LOOP
      IF line.product_type='ARTICLE' THEN
        INSERT INTO stock_movements (client_id,station_id,product_id,movement_type,quantity_delta,business_date,source_id,recorded_by)
        VALUES (NEW.client_id,NEW.station_id,line.product_id,'ARTICLE_SALE',-line.quantity,NEW.business_date,line.id,NEW.posted_by);
      ELSIF line.product_type='SERVICE' THEN
        INSERT INTO stock_movements (client_id,station_id,product_id,movement_type,quantity_delta,business_date,source_id,reason,recorded_by)
        SELECT NEW.client_id,NEW.station_id,component.component_product_id,'SERVICE_COMPONENT',
          -(line.quantity*component.quantity_per_service),NEW.business_date,line.id,'Consumed by service product '||line.product_id::text,NEW.posted_by
        FROM service_components component
        WHERE component.client_id=NEW.client_id AND component.station_id=NEW.station_id
          AND component.service_product_id=line.product_id;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_stock_posting AFTER UPDATE ON sales_transactions
FOR EACH ROW EXECUTE FUNCTION record_sale_stock_movements();

CREATE FUNCTION validate_service_component_products() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE service_kind text; component_kind text;
BEGIN
  SELECT product_type INTO service_kind FROM products WHERE client_id=NEW.client_id AND id=NEW.service_product_id;
  SELECT product_type INTO component_kind FROM products WHERE client_id=NEW.client_id AND id=NEW.component_product_id;
  IF service_kind<>'SERVICE' OR component_kind<>'ARTICLE' THEN
    RAISE EXCEPTION 'service components must map a service product to an article product';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER service_component_type_guard BEFORE INSERT OR UPDATE ON service_components
FOR EACH ROW EXECUTE FUNCTION validate_service_component_products();

CREATE FUNCTION prevent_stock_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'stock movements are append-only'; END $$;
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW EXECUTE FUNCTION prevent_stock_ledger_mutation();
CREATE INDEX stock_movements_balance_idx ON stock_movements(client_id,station_id,product_id,recorded_at DESC);
CREATE INDEX purchase_receipt_station_date_idx ON purchase_receipts(client_id,station_id,business_date DESC);

DO $$ DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['suppliers','purchase_receipts','purchase_receipt_lines','stock_movements','service_components'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  END LOOP;
END $$;

CREATE POLICY suppliers_scope ON suppliers USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));
CREATE POLICY purchase_receipts_scope ON purchase_receipts USING (app_can_access_station(client_id,station_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));
CREATE POLICY purchase_receipt_lines_scope ON purchase_receipt_lines USING (app_can_access_station(client_id,station_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));
CREATE POLICY stock_movements_scope ON stock_movements USING (app_can_access_station(client_id,station_id))
  WITH CHECK (app_can_access_station(client_id,station_id));
CREATE POLICY service_components_scope ON service_components USING (app_can_access_station(client_id,station_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER']));

GRANT SELECT,INSERT,UPDATE ON suppliers TO station_app;
GRANT SELECT,INSERT,UPDATE ON purchase_receipts TO station_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON purchase_receipt_lines TO station_app;
GRANT SELECT,INSERT ON stock_movements TO station_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON service_components TO station_app;

RESET ROLE;
