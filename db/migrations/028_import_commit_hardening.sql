-- M6 integrity follow-up: dated receivable openings and strict validation transitions.
SET ROLE station_owner;

ALTER TABLE customer_credit_movements
  ADD COLUMN business_date date,
  ADD COLUMN source_import_job_row_id uuid,
  ADD CONSTRAINT customer_credit_import_row_fk FOREIGN KEY (client_id,source_import_job_row_id)
    REFERENCES import_job_rows(client_id,id),
  ADD CONSTRAINT customer_credit_import_source_check CHECK (
    (source_import_job_row_id IS NULL AND business_date IS NULL)
    OR (source_import_job_row_id IS NOT NULL AND business_date IS NOT NULL AND movement_type='ADJUSTMENT')
  );
CREATE UNIQUE INDEX customer_credit_import_row_unique_idx
  ON customer_credit_movements(client_id,source_import_job_row_id) WHERE source_import_job_row_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_import_job_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE actual_valid integer; actual_invalid integer; actual_rows integer;
BEGIN
  IF OLD.status IN ('COMMITTED','FAILED') THEN RAISE EXCEPTION 'completed import jobs are immutable'; END IF;
  IF NEW.client_id<>OLD.client_id OR NEW.station_id IS DISTINCT FROM OLD.station_id
    OR NEW.import_kind<>OLD.import_kind OR NEW.source_name<>OLD.source_name OR NEW.row_count<>OLD.row_count
    OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'import job source metadata is immutable';
  END IF;
  IF NOT ((OLD.status='UPLOADED' AND NEW.status IN ('VALIDATED','FAILED'))
    OR (OLD.status='VALIDATED' AND NEW.status='COMMITTED')) THEN
    RAISE EXCEPTION 'invalid import job state transition';
  END IF;
  IF OLD.status='UPLOADED' AND NEW.status='VALIDATED' THEN
    SELECT count(*),count(*) FILTER(WHERE status='VALID'),count(*) FILTER(WHERE status='INVALID')
      INTO actual_rows,actual_valid,actual_invalid FROM import_job_rows WHERE client_id=OLD.client_id AND job_id=OLD.id;
    IF actual_rows<>OLD.row_count OR NEW.valid_count<>actual_valid OR NEW.invalid_count<>actual_invalid
      OR NEW.valid_count+NEW.invalid_count<>OLD.row_count OR NEW.validated_at IS NULL THEN
      RAISE EXCEPTION 'import job validation counts do not match staged rows';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

RESET ROLE;
