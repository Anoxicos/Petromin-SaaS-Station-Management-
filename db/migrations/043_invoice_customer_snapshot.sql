-- Freeze the customer identity shown on an issued invoice. Existing documents
-- are initialized from the customer record currently linked to each invoice.
SET ROLE station_owner;

ALTER TABLE issued_invoices
  ADD COLUMN customer_snapshot jsonb;

-- The original immutable trigger predates this column. The migration copies
-- the currently displayed identity exactly once, then restores immutability
-- and forced tenant RLS after the schema-owner backfill.
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;
ALTER TABLE issued_invoices DISABLE ROW LEVEL SECURITY;
ALTER TABLE issued_invoices DISABLE TRIGGER issued_invoices_immutable;
UPDATE issued_invoices invoice
SET customer_snapshot = COALESCE(
  (SELECT jsonb_build_object(
    'code',customer.code,
    'displayName',customer.display_name,
    'contactEmail',customer.contact_email,
    'contactPhone',customer.contact_phone)
   FROM customers customer
   WHERE customer.client_id=invoice.client_id AND customer.id=invoice.customer_id),
  '{"displayName":"Walk-in customer"}'::jsonb);
ALTER TABLE issued_invoices ENABLE TRIGGER issued_invoices_immutable;
ALTER TABLE issued_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE issued_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

ALTER TABLE issued_invoices
  ALTER COLUMN customer_snapshot SET NOT NULL,
  ADD CONSTRAINT issued_invoices_customer_snapshot_check CHECK (
    jsonb_typeof(customer_snapshot)='object'
    AND jsonb_typeof(customer_snapshot->'displayName')='string'
    AND length(trim(customer_snapshot->>'displayName')) BETWEEN 1 AND 200
  );

RESET ROLE;
