-- M3 operational ledgers. These tables store configurable commercial data;
-- they do not assert tax rates, legal invoice wording, or payment terms.
SET ROLE station_owner;

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  contact_email text,
  contact_phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (client_id, code)
);

CREATE TABLE customer_credit_accounts (
  client_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  credit_limit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  payment_terms_days integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 3650),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ON_HOLD', 'CLOSED')),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, customer_id),
  FOREIGN KEY (client_id, customer_id) REFERENCES customers(client_id, id)
);

CREATE TABLE sales_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  customer_id uuid,
  meter_reading_batch_id uuid,
  business_date date NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'VOID')),
  subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total numeric(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  credit_override_reason text,
  credit_overridden_by uuid REFERENCES app_users(id),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES app_users(id),
  posted_at timestamptz,
  FOREIGN KEY (client_id, station_id) REFERENCES stations(client_id, id),
  FOREIGN KEY (client_id, customer_id) REFERENCES customers(client_id, id),
  FOREIGN KEY (client_id, station_id, meter_reading_batch_id)
    REFERENCES meter_reading_batches(client_id, station_id, id),
  UNIQUE (client_id, id),
  UNIQUE (client_id, station_id, id),
  UNIQUE (client_id, station_id, meter_reading_batch_id),
  CHECK ((credit_override_reason IS NULL) = (credit_overridden_by IS NULL)),
  CHECK ((status = 'DRAFT' AND posted_by IS NULL AND posted_at IS NULL)
      OR (status <> 'DRAFT' AND posted_by IS NOT NULL AND posted_at IS NOT NULL))
);

CREATE TABLE sales_transaction_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  product_id uuid,
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 300),
  unit_code text NOT NULL CHECK (unit_code ~ '^[A-Z][A-Z0-9_-]{0,15}$'),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  tax_code text,
  tax_rate_percent numeric(7,4) NOT NULL CHECK (tax_rate_percent BETWEEN 0 AND 100),
  subtotal numeric(14,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  tax_amount numeric(14,2) GENERATED ALWAYS AS (round(round(quantity * unit_price, 2) * tax_rate_percent / 100, 2)) STORED,
  total numeric(14,2) GENERATED ALWAYS AS (
    round(quantity * unit_price, 2) + round(round(quantity * unit_price, 2) * tax_rate_percent / 100, 2)
  ) STORED,
  FOREIGN KEY (client_id, station_id, sale_id) REFERENCES sales_transactions(client_id, station_id, id),
  FOREIGN KEY (client_id, product_id) REFERENCES products(client_id, id),
  UNIQUE (sale_id, line_number),
  UNIQUE (client_id, station_id, id)
);

CREATE TABLE sales_transaction_tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  tender_type text NOT NULL CHECK (tender_type IN ('CASH', 'CARD', 'CREDIT', 'VOUCHER')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  voucher_id uuid,
  reference text,
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, station_id, sale_id) REFERENCES sales_transactions(client_id, station_id, id),
  UNIQUE (client_id, id),
  UNIQUE (client_id, station_id, id),
  CHECK ((tender_type = 'VOUCHER') = (voucher_id IS NOT NULL))
);

CREATE TABLE customer_credit_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  sale_id uuid,
  movement_type text NOT NULL CHECK (movement_type IN ('CREDIT_SALE', 'PAYMENT', 'CREDIT_NOTE', 'ADJUSTMENT')),
  amount_delta numeric(14,2) NOT NULL CHECK (amount_delta <> 0),
  reason text,
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, customer_id) REFERENCES customers(client_id, id),
  FOREIGN KEY (client_id, sale_id) REFERENCES sales_transactions(client_id, id),
  UNIQUE (client_id, id),
  CHECK (movement_type <> 'CREDIT_SALE' OR amount_delta > 0),
  CHECK (movement_type NOT IN ('PAYMENT', 'CREDIT_NOTE') OR amount_delta < 0),
  CHECK (movement_type <> 'ADJUSTMENT' OR length(trim(COALESCE(reason, ''))) > 0)
);

CREATE TABLE vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 80),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  face_value numeric(14,2) NOT NULL CHECK (face_value > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REDEEMED')),
  issued_by uuid NOT NULL REFERENCES app_users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (client_id, id),
  UNIQUE (client_id, code),
  CHECK (expires_at IS NULL OR expires_at > issued_at)
);

CREATE TABLE voucher_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  voucher_id uuid NOT NULL,
  sale_tender_id uuid,
  movement_type text NOT NULL CHECK (movement_type IN ('ISSUE', 'REDEEM', 'REFUND', 'ADJUSTMENT')),
  amount_delta numeric(14,2) NOT NULL CHECK (amount_delta <> 0),
  reason text,
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, voucher_id) REFERENCES vouchers(client_id, id),
  UNIQUE (client_id, id),
  CHECK ((movement_type IN ('ISSUE', 'REFUND') AND amount_delta > 0)
      OR (movement_type IN ('REDEEM', 'ADJUSTMENT') AND amount_delta < 0)),
  CHECK (movement_type <> 'ADJUSTMENT' OR length(trim(COALESCE(reason, ''))) > 0)
);

ALTER TABLE sales_transaction_tenders
  ADD FOREIGN KEY (client_id, voucher_id) REFERENCES vouchers(client_id, id);
ALTER TABLE voucher_movements
  ADD FOREIGN KEY (client_id, sale_tender_id) REFERENCES sales_transaction_tenders(client_id, id);

CREATE TABLE customer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'OTHER')),
  reference text,
  received_by uuid NOT NULL REFERENCES app_users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, customer_id) REFERENCES customers(client_id, id),
  UNIQUE (client_id, id)
);

CREATE TABLE customer_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  allocated_by uuid NOT NULL REFERENCES app_users(id),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, payment_id) REFERENCES customer_payments(client_id, id),
  FOREIGN KEY (client_id, sale_id) REFERENCES sales_transactions(client_id, id),
  UNIQUE (client_id, payment_id, sale_id)
);

CREATE FUNCTION guard_posted_sale_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_sale uuid;
  sale_status text;
BEGIN
  target_sale := CASE WHEN TG_OP = 'DELETE' THEN OLD.sale_id ELSE NEW.sale_id END;
  SELECT status INTO sale_status FROM sales_transactions WHERE id = target_sale;
  IF sale_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'posted sales are immutable; use a credit note or a new transaction';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE FUNCTION validate_sale_posting() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  line_subtotal numeric(14,2);
  line_tax numeric(14,2);
  line_total numeric(14,2);
  tender_total numeric(14,2);
  credit_total numeric(14,2);
  current_receivable numeric(14,2);
  allowed_limit numeric(14,2);
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'posted sales are immutable; use a credit note or a new transaction';
  END IF;
  IF NEW.status = 'POSTED' THEN
    SELECT COALESCE(sum(subtotal), 0), COALESCE(sum(tax_amount), 0), COALESCE(sum(total), 0)
      INTO line_subtotal, line_tax, line_total
      FROM sales_transaction_lines WHERE sale_id = NEW.id;
    SELECT COALESCE(sum(amount), 0), COALESCE(sum(amount) FILTER (WHERE tender_type = 'CREDIT'), 0)
      INTO tender_total, credit_total
      FROM sales_transaction_tenders WHERE sale_id = NEW.id;
    IF line_total <= 0 OR (line_subtotal, line_tax, line_total) IS DISTINCT FROM (NEW.subtotal, NEW.tax_total, NEW.total) THEN
      RAISE EXCEPTION 'sale totals must match its immutable line calculations';
    END IF;
    IF tender_total <> NEW.total THEN RAISE EXCEPTION 'sale tenders must add up exactly to the sale total'; END IF;
    IF credit_total > 0 THEN
      IF NEW.customer_id IS NULL THEN RAISE EXCEPTION 'credit sales require a customer account'; END IF;
      SELECT credit_limit INTO allowed_limit FROM customer_credit_accounts
        WHERE client_id = NEW.client_id AND customer_id = NEW.customer_id AND status = 'ACTIVE';
      IF allowed_limit IS NULL THEN RAISE EXCEPTION 'customer has no active credit account'; END IF;
      SELECT COALESCE(sum(amount_delta), 0) INTO current_receivable
        FROM customer_credit_movements WHERE client_id = NEW.client_id AND customer_id = NEW.customer_id;
      IF current_receivable + credit_total > allowed_limit AND NEW.credit_override_reason IS NULL THEN
        RAISE EXCEPTION 'customer credit limit would be exceeded';
      END IF;
      IF NEW.credit_override_reason IS NOT NULL
        AND NOT app_has_client_role(NEW.client_id, ARRAY['OWNER', 'MANAGER']) THEN
        RAISE EXCEPTION 'credit limit override requires an owner or manager';
      END IF;
    END IF;
    IF credit_total > 0 THEN
      INSERT INTO customer_credit_movements
        (client_id, customer_id, sale_id, movement_type, amount_delta, reason, recorded_by)
      VALUES (NEW.client_id, NEW.customer_id, NEW.id, 'CREDIT_SALE', credit_total,
        NEW.credit_override_reason, COALESCE(NEW.credit_overridden_by, NEW.posted_by));
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION require_sale_draft_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'DRAFT' THEN RAISE EXCEPTION 'sales must be created as drafts before posting'; END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION allocate_customer_payment() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payment_row customer_payments%ROWTYPE;
  sale_row sales_transactions%ROWTYPE;
  credit_total numeric(14,2);
  outstanding numeric(14,2);
BEGIN
  SELECT * INTO payment_row FROM customer_payments WHERE client_id = NEW.client_id AND id = NEW.payment_id FOR UPDATE;
  SELECT * INTO sale_row FROM sales_transactions WHERE client_id = NEW.client_id AND id = NEW.sale_id FOR UPDATE;
  IF payment_row.id IS NULL OR sale_row.id IS NULL THEN RAISE EXCEPTION 'payment or sale not found'; END IF;
  IF payment_row.customer_id <> sale_row.customer_id OR payment_row.currency_code <> sale_row.currency_code THEN
    RAISE EXCEPTION 'payment customer and currency must match the credit sale';
  END IF;
  IF sale_row.status <> 'POSTED' THEN RAISE EXCEPTION 'payments can only be allocated to posted sales'; END IF;
  SELECT COALESCE(sum(amount), 0) INTO credit_total FROM sales_transaction_tenders
    WHERE sale_id = sale_row.id AND tender_type = 'CREDIT';
  SELECT COALESCE(sum(amount_delta), 0) INTO outstanding FROM customer_credit_movements
    WHERE client_id = NEW.client_id AND sale_id = NEW.sale_id;
  IF NEW.amount > outstanding OR outstanding > credit_total THEN
    RAISE EXCEPTION 'payment allocation exceeds the outstanding credit sale balance';
  END IF;
  INSERT INTO customer_credit_movements
    (client_id, customer_id, sale_id, movement_type, amount_delta, reason, recorded_by)
  VALUES (NEW.client_id, sale_row.customer_id, sale_row.id, 'PAYMENT', -NEW.amount,
    'Payment allocation ' || payment_row.id::text, NEW.allocated_by);
  RETURN NEW;
END
$$;

CREATE FUNCTION redeem_sale_vouchers() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tender_row sales_transaction_tenders%ROWTYPE;
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status = 'POSTED' THEN
    FOR tender_row IN SELECT * FROM sales_transaction_tenders
      WHERE client_id = NEW.client_id AND station_id = NEW.station_id
        AND sale_id = NEW.id AND tender_type = 'VOUCHER'
    LOOP
      INSERT INTO voucher_movements
        (client_id, voucher_id, sale_tender_id, movement_type, amount_delta, recorded_by)
      VALUES (NEW.client_id, tender_row.voucher_id, tender_row.id, 'REDEEM', -tender_row.amount, NEW.posted_by);
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sales_transaction_lines_guard
BEFORE INSERT OR UPDATE OR DELETE ON sales_transaction_lines
FOR EACH ROW EXECUTE FUNCTION guard_posted_sale_mutation();

CREATE TRIGGER sales_transactions_posting_guard
BEFORE UPDATE ON sales_transactions
FOR EACH ROW EXECUTE FUNCTION validate_sale_posting();
CREATE TRIGGER sales_transactions_draft_insert
BEFORE INSERT ON sales_transactions
FOR EACH ROW EXECUTE FUNCTION require_sale_draft_insert();
CREATE TRIGGER sales_voucher_redemption
AFTER UPDATE ON sales_transactions
FOR EACH ROW EXECUTE FUNCTION redeem_sale_vouchers();

CREATE FUNCTION guard_sale_tender_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_sale uuid;
  target_status text;
BEGIN
  target_sale := CASE WHEN TG_OP = 'DELETE' THEN OLD.sale_id ELSE NEW.sale_id END;
  SELECT status INTO target_status FROM sales_transactions WHERE id = target_sale;
  IF target_status <> 'DRAFT' THEN RAISE EXCEPTION 'posted sale tenders are immutable'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER sales_transaction_tenders_guard
BEFORE INSERT OR UPDATE OR DELETE ON sales_transaction_tenders
FOR EACH ROW EXECUTE FUNCTION guard_sale_tender_mutation();

CREATE FUNCTION guard_voucher_balance() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  voucher_row vouchers%ROWTYPE;
  balance numeric(14,2);
BEGIN
  SELECT * INTO voucher_row FROM vouchers WHERE id = NEW.voucher_id FOR UPDATE;
  IF NOT FOUND OR voucher_row.client_id <> NEW.client_id THEN RAISE EXCEPTION 'voucher not found'; END IF;
  SELECT voucher_row.face_value + COALESCE(sum(amount_delta), 0) INTO balance
  FROM voucher_movements WHERE voucher_id = NEW.voucher_id;
  IF NEW.movement_type = 'ISSUE' THEN RAISE EXCEPTION 'voucher face value already represents issuance'; END IF;
  IF balance + NEW.amount_delta < 0 OR balance + NEW.amount_delta > voucher_row.face_value THEN
    RAISE EXCEPTION 'voucher movement exceeds the available balance';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER voucher_movement_balance_guard
BEFORE INSERT ON voucher_movements
FOR EACH ROW EXECUTE FUNCTION guard_voucher_balance();

CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER customer_credit_movements_immutable
BEFORE UPDATE OR DELETE ON customer_credit_movements
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER voucher_movements_immutable
BEFORE UPDATE OR DELETE ON voucher_movements
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER customer_payments_immutable
BEFORE UPDATE OR DELETE ON customer_payments
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER payment_allocations_immutable
BEFORE UPDATE OR DELETE ON customer_payment_allocations
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER customer_payment_allocation_ledger
BEFORE INSERT ON customer_payment_allocations
FOR EACH ROW EXECUTE FUNCTION allocate_customer_payment();

CREATE INDEX customers_client_active_idx ON customers(client_id, is_active, display_name);
CREATE INDEX credit_movements_customer_idx ON customer_credit_movements(client_id, customer_id, recorded_at DESC);
CREATE INDEX vouchers_client_status_idx ON vouchers(client_id, status, code);
CREATE INDEX voucher_movements_history_idx ON voucher_movements(client_id, voucher_id, recorded_at DESC);
CREATE INDEX sales_station_history_idx ON sales_transactions(client_id, station_id, business_date DESC);
CREATE INDEX customer_payments_history_idx ON customer_payments(client_id, customer_id, received_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customers', 'customer_credit_accounts', 'sales_transactions', 'sales_transaction_lines',
    'sales_transaction_tenders', 'customer_credit_movements', 'vouchers', 'voucher_movements',
    'customer_payments', 'customer_payment_allocations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;

CREATE POLICY customers_scope ON customers
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER']));
CREATE POLICY customer_credit_accounts_scope ON customer_credit_accounts
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER']));
CREATE POLICY sales_transactions_scope ON sales_transactions
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));
CREATE POLICY sales_transaction_lines_scope ON sales_transaction_lines
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));
CREATE POLICY sales_transaction_tenders_scope ON sales_transaction_tenders
  USING (app_can_access_station(client_id, station_id))
  WITH CHECK (app_can_access_station(client_id, station_id));
CREATE POLICY customer_credit_movements_scope ON customer_credit_movements
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER']));
CREATE POLICY vouchers_scope ON vouchers
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER', 'CASHIER']));
CREATE POLICY voucher_movements_scope ON voucher_movements
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER', 'CASHIER']));
CREATE POLICY customer_payments_scope ON customer_payments
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER', 'ACCOUNTANT', 'CASHIER']));
CREATE POLICY customer_payment_allocations_scope ON customer_payment_allocations
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id, ARRAY['OWNER', 'MANAGER', 'ACCOUNTANT']));

GRANT SELECT, INSERT, UPDATE ON customers TO station_app;
GRANT SELECT, INSERT, UPDATE ON customer_credit_accounts TO station_app;
GRANT SELECT, INSERT, UPDATE ON sales_transactions TO station_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_transaction_lines TO station_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_transaction_tenders TO station_app;
GRANT SELECT, INSERT ON customer_credit_movements TO station_app;
GRANT SELECT, INSERT, UPDATE ON vouchers TO station_app;
GRANT SELECT, INSERT ON voucher_movements TO station_app;
GRANT SELECT, INSERT ON customer_payments TO station_app;
GRANT SELECT, INSERT ON customer_payment_allocations TO station_app;

RESET ROLE;
