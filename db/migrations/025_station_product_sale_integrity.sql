-- A sale line must use a product actually enabled at its station.
ALTER TABLE sales_transaction_lines
  ADD CONSTRAINT sales_line_station_product_fk
  FOREIGN KEY (client_id,station_id,product_id)
  REFERENCES station_products(client_id,station_id,product_id);
