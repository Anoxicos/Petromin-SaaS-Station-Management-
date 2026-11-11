SET ROLE station_owner;

ALTER TABLE sales_transactions
  ADD COLUMN credit_terms_days_snapshot integer,
  ADD COLUMN credit_due_date date,
  ADD CONSTRAINT sales_credit_due_date_snapshot_check CHECK (
    (credit_terms_days_snapshot IS NULL AND credit_due_date IS NULL)
    OR (credit_terms_days_snapshot BETWEEN 0 AND 3650
      AND credit_due_date = business_date + credit_terms_days_snapshot)
  );

CREATE OR REPLACE FUNCTION validate_sale_posting() RETURNS trigger
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
  payment_terms integer;
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'posted sales are immutable; use a credit note or a new transaction';
  END IF;
  NEW.credit_terms_days_snapshot := NULL;
  NEW.credit_due_date := NULL;
  IF NEW.status = 'POSTED' THEN
    SELECT COALESCE(sum(subtotal),0),COALESCE(sum(tax_amount),0),COALESCE(sum(total),0)
      INTO line_subtotal,line_tax,line_total FROM sales_transaction_lines WHERE sale_id=NEW.id;
    SELECT COALESCE(sum(amount),0),COALESCE(sum(amount) FILTER (WHERE tender_type='CREDIT'),0)
      INTO tender_total,credit_total FROM sales_transaction_tenders WHERE sale_id=NEW.id;
    IF line_total <= 0 OR (line_subtotal,line_tax,line_total) IS DISTINCT FROM (NEW.subtotal,NEW.tax_total,NEW.total) THEN
      RAISE EXCEPTION 'sale totals must match its immutable line calculations';
    END IF;
    IF tender_total <> NEW.total THEN RAISE EXCEPTION 'sale tenders must add up exactly to the sale total'; END IF;
    IF credit_total > 0 THEN
      IF NEW.customer_id IS NULL THEN RAISE EXCEPTION 'credit sales require a customer account'; END IF;
      SELECT credit_limit,payment_terms_days INTO allowed_limit,payment_terms FROM customer_credit_accounts
        WHERE client_id=NEW.client_id AND customer_id=NEW.customer_id AND status='ACTIVE' FOR UPDATE;
      IF allowed_limit IS NULL THEN RAISE EXCEPTION 'customer has no active credit account'; END IF;
      SELECT COALESCE(sum(amount_delta),0) INTO current_receivable FROM customer_credit_movements
        WHERE client_id=NEW.client_id AND customer_id=NEW.customer_id;
      IF current_receivable+credit_total>allowed_limit AND NEW.credit_override_reason IS NULL THEN
        RAISE EXCEPTION 'customer credit limit would be exceeded';
      END IF;
      IF NEW.credit_override_reason IS NOT NULL
        AND NOT app_has_client_role(NEW.client_id,ARRAY['OWNER','MANAGER']) THEN
        RAISE EXCEPTION 'credit limit override requires an owner or manager';
      END IF;
      NEW.credit_terms_days_snapshot := payment_terms;
      IF payment_terms IS NOT NULL THEN NEW.credit_due_date := NEW.business_date + payment_terms; END IF;
      INSERT INTO customer_credit_movements
        (client_id,customer_id,sale_id,movement_type,amount_delta,reason,recorded_by)
      VALUES (NEW.client_id,NEW.customer_id,NEW.id,'CREDIT_SALE',credit_total,
        NEW.credit_override_reason,COALESCE(NEW.credit_overridden_by,NEW.posted_by));
    END IF;
  END IF;
  RETURN NEW;
END
$$;

RESET ROLE;
