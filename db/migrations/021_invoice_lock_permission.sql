-- SELECT FOR UPDATE needs UPDATE privilege; the immutable-document trigger rejects actual edits.
GRANT UPDATE ON issued_invoices TO station_app;
