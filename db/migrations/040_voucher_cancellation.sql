ALTER TABLE vouchers
  DROP CONSTRAINT vouchers_status_check,
  ADD CONSTRAINT vouchers_status_check
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REDEEMED', 'CANCELLED')),
  ADD COLUMN cancelled_by uuid REFERENCES app_users(id),
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text,
  ADD CONSTRAINT vouchers_cancellation_fields_check CHECK (
    (status = 'CANCELLED' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND length(trim(COALESCE(cancellation_reason, ''))) > 0)
    OR (status <> 'CANCELLED' AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
  );

ALTER TABLE voucher_movements
  DROP CONSTRAINT voucher_movements_movement_type_check,
  ADD CONSTRAINT voucher_movements_movement_type_check
    CHECK (movement_type IN ('ISSUE', 'REDEEM', 'REFUND', 'ADJUSTMENT', 'CANCEL')),
  DROP CONSTRAINT voucher_movements_check,
  ADD CONSTRAINT voucher_movements_check CHECK (
    (movement_type IN ('ISSUE', 'REFUND') AND amount_delta > 0)
    OR (movement_type IN ('REDEEM', 'ADJUSTMENT', 'CANCEL') AND amount_delta < 0)
  ),
  ADD CONSTRAINT voucher_cancel_reason_check CHECK (
    movement_type <> 'CANCEL' OR length(trim(COALESCE(reason, ''))) > 0
  );

CREATE UNIQUE INDEX voucher_single_cancellation_idx
  ON voucher_movements(client_id, voucher_id) WHERE movement_type = 'CANCEL';

CREATE OR REPLACE FUNCTION guard_voucher_balance() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  voucher_row vouchers%ROWTYPE;
  balance numeric(14,2);
BEGIN
  SELECT * INTO voucher_row FROM vouchers WHERE id = NEW.voucher_id FOR UPDATE;
  IF NOT FOUND OR voucher_row.client_id <> NEW.client_id THEN RAISE EXCEPTION 'voucher not found'; END IF;
  SELECT voucher_row.face_value + COALESCE(sum(amount_delta), 0) INTO balance
  FROM voucher_movements WHERE client_id = NEW.client_id AND voucher_id = NEW.voucher_id;
  IF NEW.movement_type = 'ISSUE' THEN RAISE EXCEPTION 'voucher face value already represents issuance'; END IF;
  IF NEW.movement_type = 'CANCEL' THEN
    IF voucher_row.status <> 'CANCELLED' OR voucher_row.cancelled_by::text <> current_setting('app.actor_id', true)
       OR NEW.recorded_by::text <> current_setting('app.actor_id', true)
       OR current_setting('app.role', true) NOT IN ('OWNER', 'MANAGER', 'SUPER_ADMIN')
       OR NEW.amount_delta <> -balance THEN
      RAISE EXCEPTION 'voucher cancellation must be authorized and reconcile its remaining balance';
    END IF;
  ELSIF voucher_row.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'cancelled vouchers cannot receive further movements';
  END IF;
  IF balance + NEW.amount_delta < 0 OR balance + NEW.amount_delta > voucher_row.face_value THEN
    RAISE EXCEPTION 'voucher movement exceeds the available balance';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION guard_voucher_cancellation_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'CANCELLED' THEN RAISE EXCEPTION 'cancelled vouchers are immutable'; END IF;
  IF NEW.status = 'CANCELLED' AND (
      NEW.cancelled_by IS DISTINCT FROM current_setting('app.actor_id', true)::uuid
      OR NEW.cancelled_at IS NULL OR NEW.cancellation_reason IS NULL
      OR current_setting('app.role', true) NOT IN ('OWNER', 'MANAGER', 'SUPER_ADMIN')
    ) THEN
    RAISE EXCEPTION 'voucher cancellation requires an authorized actor and reason';
  END IF;
  IF NEW.status <> 'CANCELLED' THEN
    NEW.cancelled_by := NULL; NEW.cancelled_at := NULL; NEW.cancellation_reason := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER vouchers_cancellation_guard
BEFORE UPDATE ON vouchers
FOR EACH ROW EXECUTE FUNCTION guard_voucher_cancellation_update();

GRANT UPDATE (status, cancelled_by, cancelled_at, cancellation_reason) ON vouchers TO station_app;
GRANT INSERT ON voucher_movements TO station_app;
