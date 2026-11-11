SET ROLE station_owner;

CREATE OR REPLACE FUNCTION allocate_customer_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  payment_row customer_payments%ROWTYPE;
  sale_row sales_transactions%ROWTYPE;
  credit_total numeric(14,2);
  outstanding numeric(14,2);
  already_allocated numeric(14,2);
  installment_due numeric(14,2);
  installment_allocated numeric(14,2);
  has_sale_level_allocations boolean;
  has_installment_allocations boolean;
BEGIN
  SELECT * INTO payment_row FROM customer_payments
    WHERE client_id=NEW.client_id AND id=NEW.payment_id FOR UPDATE;
  SELECT * INTO sale_row FROM sales_transactions
    WHERE client_id=NEW.client_id AND id=NEW.sale_id FOR UPDATE;
  IF payment_row.id IS NULL OR sale_row.id IS NULL THEN RAISE EXCEPTION 'payment or sale not found'; END IF;
  IF payment_row.customer_id<>sale_row.customer_id OR payment_row.currency_code<>sale_row.currency_code THEN
    RAISE EXCEPTION 'payment customer and currency must match the credit sale';
  END IF;
  IF sale_row.status<>'POSTED' THEN RAISE EXCEPTION 'payments can only be allocated to posted sales'; END IF;
  SELECT COALESCE(sum(amount),0) INTO credit_total FROM sales_transaction_tenders
    WHERE sale_id=sale_row.id AND tender_type='CREDIT';
  SELECT COALESCE(sum(amount_delta),0) INTO outstanding FROM customer_credit_movements
    WHERE client_id=NEW.client_id AND sale_id=NEW.sale_id;
  SELECT COALESCE(sum(amount),0) INTO already_allocated FROM customer_payment_allocations
    WHERE client_id=NEW.client_id AND payment_id=NEW.payment_id;
  IF NEW.amount>outstanding OR outstanding>credit_total THEN
    RAISE EXCEPTION 'payment allocation exceeds the outstanding credit sale balance';
  END IF;
  IF already_allocated+NEW.amount>payment_row.amount THEN
    RAISE EXCEPTION 'payment allocations exceed the received payment amount';
  END IF;
  SELECT EXISTS (SELECT 1 FROM customer_payment_allocations
    WHERE client_id=NEW.client_id AND sale_id=NEW.sale_id AND installment_number IS NULL),
    EXISTS (SELECT 1 FROM customer_payment_allocations
    WHERE client_id=NEW.client_id AND sale_id=NEW.sale_id AND installment_number IS NOT NULL)
    INTO has_sale_level_allocations,has_installment_allocations;
  IF NEW.installment_number IS NULL AND has_installment_allocations
    OR NEW.installment_number IS NOT NULL AND has_sale_level_allocations THEN
    RAISE EXCEPTION 'sale-level and installment-specific payment allocations cannot be mixed';
  END IF;
  IF NEW.installment_number IS NOT NULL THEN
    IF jsonb_array_length(sale_row.credit_schedule_snapshot)<NEW.installment_number THEN
      RAISE EXCEPTION 'installment is not present in the credit sale schedule';
    END IF;
    IF EXISTS (SELECT 1 FROM issued_credit_notes WHERE client_id=NEW.client_id AND sale_id=NEW.sale_id
      AND receivable_adjustment>0) THEN
      RAISE EXCEPTION 'installment allocation is unavailable after a credit-note receivable adjustment';
    END IF;
    installment_due := (sale_row.credit_schedule_snapshot->(NEW.installment_number-1)->>'amount')::numeric(14,2);
    SELECT COALESCE(sum(amount),0) INTO installment_allocated FROM customer_payment_allocations
      WHERE client_id=NEW.client_id AND sale_id=NEW.sale_id AND installment_number=NEW.installment_number;
    IF installment_allocated+NEW.amount>installment_due THEN
      RAISE EXCEPTION 'payment allocation exceeds the installment balance';
    END IF;
  END IF;
  INSERT INTO customer_credit_movements
    (client_id,customer_id,sale_id,movement_type,amount_delta,reason,recorded_by)
  VALUES (NEW.client_id,sale_row.customer_id,sale_row.id,'PAYMENT',-NEW.amount,
    'Payment allocation '||payment_row.id::text||CASE WHEN NEW.installment_number IS NULL THEN '' ELSE ' installment '||NEW.installment_number END,
    NEW.allocated_by);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION validate_credit_note_amount() RETURNS trigger
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
  PERFORM 1 FROM sales_transactions WHERE client_id=NEW.client_id AND id=NEW.sale_id FOR UPDATE;
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
    IF NEW.receivable_adjustment>0 AND EXISTS (
      SELECT 1 FROM customer_payment_allocations WHERE client_id=NEW.client_id AND sale_id=NEW.sale_id
        AND installment_number IS NOT NULL) THEN
      RAISE EXCEPTION 'credit-note receivable adjustment is unavailable after installment-specific payments';
    END IF;
  ELSIF NEW.receivable_adjustment<>0 THEN
    RAISE EXCEPTION 'a credit note without a customer cannot adjust a receivable';
  END IF;
  RETURN NEW;
END
$$;

RESET ROLE;
