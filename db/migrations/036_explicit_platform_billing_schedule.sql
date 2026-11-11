BEGIN;

-- A billing day is client contract data. Do not silently infer day 1 for new subscriptions.
ALTER TABLE client_subscriptions ALTER COLUMN billing_day DROP DEFAULT;

COMMIT;
