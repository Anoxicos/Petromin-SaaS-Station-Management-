-- Serialize credit-limit checks and payment allocation; validate voucher currency/state on redemption.
SET ROLE station_owner;

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
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'posted sales are immutable; use a credit note or a new transaction';
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
    IF credit_total > 0 THEN
      IF NEW.customer_id IS NULL THEN RAISE EXCEPTION 'credit sales require a customer account'; END IF;
      SELECT credit_limit INTO allowed_limit FROM customer_credit_accounts
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
      INSERT INTO customer_credit_movements
        (client_id,customer_id,sale_id,movement_type,amount_delta,reason,recorded_by)
      VALUES (NEW.client_id,NEW.customer_id,NEW.id,'CREDIT_SALE',credit_total,
        NEW.credit_override_reason,COALESCE(NEW.credit_overridden_by,NEW.posted_by));
    END IF;
  END IF;
  RETURN NEW;
END
$$;

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
  INSERT INTO customer_credit_movements
    (client_id,customer_id,sale_id,movement_type,amount_delta,reason,recorded_by)
  VALUES (NEW.client_id,sale_row.customer_id,sale_row.id,'PAYMENT',-NEW.amount,
    'Payment allocation '||payment_row.id::text,NEW.allocated_by);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_voucher_balance() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  voucher_row vouchers%ROWTYPE;
  sale_currency text;
  balance numeric(14,2);
BEGIN
  SELECT * INTO voucher_row FROM vouchers WHERE id=NEW.voucher_id FOR UPDATE;
  IF NOT FOUND OR voucher_row.client_id<>NEW.client_id THEN RAISE EXCEPTION 'voucher not found'; END IF;
  IF NEW.movement_type='ISSUE' THEN RAISE EXCEPTION 'voucher face value already represents issuance'; END IF;
  IF NEW.movement_type='REDEEM' THEN
    IF voucher_row.status<>'ACTIVE' OR (voucher_row.expires_at IS NOT NULL AND voucher_row.expires_at<=now()) THEN
      RAISE EXCEPTION 'voucher is not active or has expired';
    END IF;
    SELECT sale.currency_code INTO sale_currency
    FROM sales_transaction_tenders tender JOIN sales_transactions sale
      ON sale.client_id=tender.client_id AND sale.station_id=tender.station_id AND sale.id=tender.sale_id
    WHERE tender.client_id=NEW.client_id AND tender.id=NEW.sale_tender_id;
    IF sale_currency IS NULL OR sale_currency<>voucher_row.currency_code THEN
      RAISE EXCEPTION 'voucher and sale currencies must match';
    END IF;
  END IF;
  SELECT voucher_row.face_value+COALESCE(sum(amount_delta),0) INTO balance
    FROM voucher_movements WHERE voucher_id=NEW.voucher_id;
  IF balance+NEW.amount_delta<0 OR balance+NEW.amount_delta>voucher_row.face_value THEN
    RAISE EXCEPTION 'voucher movement exceeds the available balance';
  END IF;
  RETURN NEW;
END
$$;

RESET ROLE;
