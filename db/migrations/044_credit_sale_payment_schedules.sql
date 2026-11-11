SET ROLE station_owner;

ALTER TABLE sales_transactions
  ADD COLUMN credit_schedule_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  DROP CONSTRAINT sales_credit_due_date_snapshot_check;

-- A schedule is stored on the immutable sale; the existing receivable ledger
-- remains the source of truth for paid and outstanding balances.
ALTER TABLE sales_transactions ADD CONSTRAINT sales_credit_schedule_snapshot_check CHECK (
  jsonb_typeof(credit_schedule_snapshot) = 'array'
  AND (credit_terms_days_snapshot IS NULL OR credit_terms_days_snapshot BETWEEN 0 AND 3650)
  AND (
    (jsonb_array_length(credit_schedule_snapshot) = 0
      AND ((status = 'DRAFT' AND credit_terms_days_snapshot IS NULL AND credit_due_date IS NULL)
        OR (status <> 'DRAFT' AND ((credit_terms_days_snapshot IS NULL AND credit_due_date IS NULL)
          OR (credit_terms_days_snapshot IS NOT NULL AND credit_due_date = business_date + credit_terms_days_snapshot)))))
    OR
    (jsonb_array_length(credit_schedule_snapshot) > 0
      AND ((status = 'DRAFT' AND credit_terms_days_snapshot IS NULL AND credit_due_date IS NULL)
        OR (status <> 'DRAFT' AND credit_due_date IS NOT NULL
          AND (credit_schedule_snapshot -> 0 ->> 'dueDate') = to_char(credit_due_date,'YYYY-MM-DD')
          AND (credit_terms_days_snapshot IS NULL
            OR credit_due_date = business_date + credit_terms_days_snapshot))))
  )
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
  installment jsonb;
  installment_due date;
  installment_amount numeric(14,2);
  schedule_total numeric(14,2) := 0;
  normalized_schedule jsonb := '[]'::jsonb;
  previous_due date;
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'posted sales are immutable; use a credit note or a new transaction';
  END IF;
  IF jsonb_typeof(NEW.credit_schedule_snapshot) IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.credit_schedule_snapshot) > 60 THEN
    RAISE EXCEPTION 'payment schedule must contain at most 60 installments';
  END IF;
  IF NEW.status = 'POSTED' THEN
    SELECT COALESCE(sum(subtotal),0),COALESCE(sum(tax_amount),0),COALESCE(sum(total),0)
      INTO line_subtotal,line_tax,line_total FROM sales_transaction_lines WHERE sale_id=NEW.id;
    SELECT COALESCE(sum(amount),0),COALESCE(sum(amount) FILTER (WHERE tender_type='CREDIT'),0)
      INTO tender_total,credit_total FROM sales_transaction_tenders WHERE sale_id=NEW.id;
    IF line_total <= 0 OR (line_subtotal,line_tax,line_total) IS DISTINCT FROM (NEW.subtotal,NEW.tax_total,NEW.total) THEN
      RAISE EXCEPTION 'sale totals must match its immutable line calculations';
    END IF;
    IF tender_total <> NEW.total THEN RAISE EXCEPTION 'sale tenders must add up exactly to the sale total'; END IF;
    NEW.credit_terms_days_snapshot := NULL;
    NEW.credit_due_date := NULL;
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

      IF jsonb_array_length(NEW.credit_schedule_snapshot) = 0 THEN
        NEW.credit_terms_days_snapshot := payment_terms;
        IF payment_terms IS NOT NULL THEN
          NEW.credit_due_date := NEW.business_date + payment_terms;
          NEW.credit_schedule_snapshot := jsonb_build_array(jsonb_build_object(
            'dueDate',NEW.credit_due_date,'amount',credit_total));
        END IF;
      ELSE
        FOR installment IN SELECT value FROM jsonb_array_elements(NEW.credit_schedule_snapshot) LOOP
          IF jsonb_typeof(installment) IS DISTINCT FROM 'object'
            OR COALESCE(installment->>'dueDate','') !~ '^\d{4}-\d{2}-\d{2}$'
            OR COALESCE(installment->>'amount','') !~ '^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$' THEN
            RAISE EXCEPTION 'each installment needs an ISO due date and a positive amount';
          END IF;
          installment_due := (installment->>'dueDate')::date;
          installment_amount := (installment->>'amount')::numeric(14,2);
          IF to_char(installment_due,'YYYY-MM-DD') <> installment->>'dueDate'
            OR installment_due < NEW.business_date
            OR installment_amount <= 0
            OR (previous_due IS NOT NULL AND installment_due <= previous_due) THEN
            RAISE EXCEPTION 'installment dates must be valid, ordered, and not before the sale date';
          END IF;
          schedule_total := schedule_total + installment_amount;
          previous_due := installment_due;
          normalized_schedule := normalized_schedule || jsonb_build_array(jsonb_build_object(
            'dueDate',installment_due,'amount',installment_amount));
        END LOOP;
        IF schedule_total <> credit_total THEN
          RAISE EXCEPTION 'installment amounts must equal the credit tender total';
        END IF;
        NEW.credit_schedule_snapshot := normalized_schedule;
        NEW.credit_due_date := (normalized_schedule->0->>'dueDate')::date;
      END IF;
      INSERT INTO customer_credit_movements
        (client_id,customer_id,sale_id,movement_type,amount_delta,reason,recorded_by)
      VALUES (NEW.client_id,NEW.customer_id,NEW.id,'CREDIT_SALE',credit_total,
        NEW.credit_override_reason,COALESCE(NEW.credit_overridden_by,NEW.posted_by));
    ELSIF jsonb_array_length(NEW.credit_schedule_snapshot) > 0 THEN
      RAISE EXCEPTION 'payment schedules are only valid for credit sales';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

RESET ROLE;
