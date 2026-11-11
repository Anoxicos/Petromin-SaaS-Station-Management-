SET ROLE station_owner;

ALTER TABLE customer_payment_allocations
  ADD COLUMN installment_number integer CHECK (installment_number BETWEEN 1 AND 60);
ALTER TABLE customer_payment_allocations
  DROP CONSTRAINT customer_payment_allocations_client_id_payment_id_sale_id_key;
CREATE UNIQUE INDEX customer_payment_allocations_sale_generic_uq
  ON customer_payment_allocations(client_id,payment_id,sale_id)
  WHERE installment_number IS NULL;
CREATE UNIQUE INDEX customer_payment_allocations_installment_uq
  ON customer_payment_allocations(client_id,payment_id,sale_id,installment_number)
  WHERE installment_number IS NOT NULL;
CREATE INDEX customer_payment_allocations_installment_history_idx
  ON customer_payment_allocations(client_id,sale_id,installment_number);

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

RESET ROLE;
