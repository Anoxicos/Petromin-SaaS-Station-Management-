-- Fuel transaction prices must match the station tariff effective at sale creation time.
SET ROLE station_owner;
CREATE FUNCTION enforce_fuel_sale_tariff() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE sale_time timestamptz; product_kind text; tariff_price numeric(14,4);
BEGIN
  SELECT sale.created_at,product.product_type INTO sale_time,product_kind
  FROM sales_transactions sale JOIN products product
    ON product.client_id=sale.client_id AND product.id=NEW.product_id
  WHERE sale.client_id=NEW.client_id AND sale.station_id=NEW.station_id AND sale.id=NEW.sale_id;
  IF product_kind='FUEL' THEN
    SELECT tariff.unit_price INTO tariff_price FROM fuel_tariffs tariff
    WHERE tariff.client_id=NEW.client_id AND tariff.station_id=NEW.station_id AND tariff.product_id=NEW.product_id
      AND tariff.valid_from<=sale_time AND (tariff.valid_until IS NULL OR tariff.valid_until>sale_time);
    IF tariff_price IS NULL THEN RAISE EXCEPTION 'no effective station fuel tariff exists for this sale'; END IF;
    IF NEW.unit_price<>tariff_price THEN RAISE EXCEPTION 'fuel sale price must match its effective station tariff'; END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_line_fuel_tariff_guard
BEFORE INSERT OR UPDATE OF product_id,unit_price ON sales_transaction_lines
FOR EACH ROW EXECUTE FUNCTION enforce_fuel_sale_tariff();
RESET ROLE;
