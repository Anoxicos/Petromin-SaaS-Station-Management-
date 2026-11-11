-- Jurisdiction-neutral invoice configuration: clients supply and approve their own legal rules.
SET ROLE station_owner;

CREATE TABLE client_invoice_profiles (
  client_id uuid PRIMARY KEY REFERENCES clients(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','SUSPENDED')),
  legal_configuration jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(legal_configuration)='object'),
  invoice_prefix text NOT NULL DEFAULT 'INV' CHECK (length(trim(invoice_prefix)) BETWEEN 1 AND 24),
  next_invoice_number bigint NOT NULL DEFAULT 1 CHECK (next_invoice_number > 0),
  credit_note_prefix text NOT NULL DEFAULT 'CN' CHECK (length(trim(credit_note_prefix)) BETWEEN 1 AND 24),
  next_credit_note_number bigint NOT NULL DEFAULT 1 CHECK (next_credit_note_number > 0),
  approval_statement text,
  approval_reference text,
  approved_by uuid REFERENCES app_users(id),
  approved_at timestamptz,
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='APPROVED')=(approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_statement IS NOT NULL))
);

CREATE TABLE issued_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  customer_id uuid,
  invoice_number text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  business_date date NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  subtotal numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  tax_total numeric(14,2) NOT NULL CHECK (tax_total >= 0),
  total numeric(14,2) NOT NULL CHECK (total > 0),
  legal_snapshot jsonb NOT NULL CHECK (jsonb_typeof(legal_snapshot)='object'),
  lines_snapshot jsonb NOT NULL CHECK (jsonb_typeof(lines_snapshot)='array'),
  issued_by uuid NOT NULL REFERENCES app_users(id),
  FOREIGN KEY (client_id,station_id,sale_id) REFERENCES sales_transactions(client_id,station_id,id),
  FOREIGN KEY (client_id,customer_id) REFERENCES customers(client_id,id),
  UNIQUE (client_id,id),
  UNIQUE (client_id,sale_id),
  UNIQUE (client_id,invoice_number)
);

CREATE TABLE issued_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  customer_id uuid,
  credit_note_number text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  receivable_adjustment numeric(14,2) NOT NULL DEFAULT 0 CHECK (receivable_adjustment >= 0),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  issued_at timestamptz NOT NULL DEFAULT now(),
  legal_snapshot jsonb NOT NULL CHECK (jsonb_typeof(legal_snapshot)='object'),
  issued_by uuid NOT NULL REFERENCES app_users(id),
  FOREIGN KEY (client_id,invoice_id) REFERENCES issued_invoices(client_id,id),
  FOREIGN KEY (client_id,sale_id) REFERENCES sales_transactions(client_id,id),
  FOREIGN KEY (client_id,customer_id) REFERENCES customers(client_id,id),
  UNIQUE (client_id,credit_note_number)
);

CREATE FUNCTION prevent_issued_document_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'issued invoices and credit notes are immutable'; END $$;
CREATE TRIGGER issued_invoices_immutable BEFORE UPDATE OR DELETE ON issued_invoices
FOR EACH ROW EXECUTE FUNCTION prevent_issued_document_mutation();
CREATE TRIGGER issued_credit_notes_immutable BEFORE UPDATE OR DELETE ON issued_credit_notes
FOR EACH ROW EXECUTE FUNCTION prevent_issued_document_mutation();

CREATE FUNCTION validate_credit_note_amount() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE invoice_total numeric(14,2); already_credited numeric(14,2); current_due numeric(14,2);
  original_sale uuid; original_customer uuid;
BEGIN
  SELECT total,sale_id,customer_id INTO invoice_total,original_sale,original_customer FROM issued_invoices
    WHERE client_id=NEW.client_id AND id=NEW.invoice_id FOR UPDATE;
  IF original_sale IS DISTINCT FROM NEW.sale_id OR original_customer IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'credit note customer and sale must match its invoice';
  END IF;
  SELECT COALESCE(sum(amount),0) INTO already_credited FROM issued_credit_notes
    WHERE client_id=NEW.client_id AND invoice_id=NEW.invoice_id;
  IF invoice_total IS NULL OR already_credited+NEW.amount>invoice_total THEN
    RAISE EXCEPTION 'credit note exceeds the remaining invoice value';
  END IF;
  IF NEW.customer_id IS NOT NULL THEN
    SELECT COALESCE(sum(amount_delta),0) INTO current_due FROM customer_credit_movements
      WHERE client_id=NEW.client_id AND customer_id=NEW.customer_id AND sale_id=NEW.sale_id;
    IF NEW.receivable_adjustment>NEW.amount OR NEW.receivable_adjustment>current_due THEN
      RAISE EXCEPTION 'credit-note receivable adjustment exceeds the outstanding customer balance for this sale';
    END IF;
  ELSIF NEW.receivable_adjustment<>0 THEN
    RAISE EXCEPTION 'a credit note without a customer cannot adjust a receivable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER issued_credit_note_amount_guard BEFORE INSERT ON issued_credit_notes
FOR EACH ROW EXECUTE FUNCTION validate_credit_note_amount();

CREATE FUNCTION record_credit_note_ledger_movement() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL AND NEW.receivable_adjustment>0 THEN
    INSERT INTO customer_credit_movements
      (client_id,customer_id,sale_id,movement_type,amount_delta,reason,recorded_by)
    VALUES (NEW.client_id,NEW.customer_id,NEW.sale_id,'CREDIT_NOTE',-NEW.receivable_adjustment,
      'Credit note '||NEW.credit_note_number||': '||NEW.reason,NEW.issued_by);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER issued_credit_note_credit_ledger AFTER INSERT ON issued_credit_notes
FOR EACH ROW EXECUTE FUNCTION record_credit_note_ledger_movement();

DO $$ DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['client_invoice_profiles','issued_invoices','issued_credit_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  END LOOP;
END $$;

CREATE POLICY client_invoice_profiles_scope ON client_invoice_profiles
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));
CREATE POLICY issued_invoices_scope ON issued_invoices
  USING (app_can_access_station(client_id,station_id))
  WITH CHECK (app_can_access_station(client_id,station_id));
CREATE POLICY issued_credit_notes_scope ON issued_credit_notes
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));

GRANT SELECT,INSERT,UPDATE ON client_invoice_profiles TO station_app;
GRANT SELECT,INSERT ON issued_invoices TO station_app;
GRANT SELECT,INSERT ON issued_credit_notes TO station_app;

RESET ROLE;
