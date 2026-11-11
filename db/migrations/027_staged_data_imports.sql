-- M6 staged imports: preview and validate first; write financial/stock ledgers only on explicit commit.
SET ROLE station_owner;

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  station_id uuid,
  import_kind text NOT NULL CHECK (import_kind IN ('HISTORICAL_RECORDS','OPENING_STOCK','OPENING_RECEIVABLE')),
  source_name text NOT NULL CHECK (length(trim(source_name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED','VALIDATED','FAILED','COMMITTED')),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 5000),
  valid_count integer NOT NULL DEFAULT 0 CHECK (valid_count BETWEEN 0 AND row_count),
  invalid_count integer NOT NULL DEFAULT 0 CHECK (invalid_count BETWEEN 0 AND row_count),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  committed_by uuid REFERENCES app_users(id),
  committed_at timestamptz,
  FOREIGN KEY (client_id,station_id) REFERENCES stations(client_id,id),
  UNIQUE (client_id,id),
  CHECK (import_kind='HISTORICAL_RECORDS' OR station_id IS NOT NULL),
  CHECK ((status='COMMITTED')=(committed_by IS NOT NULL AND committed_at IS NOT NULL))
);

CREATE TABLE import_job_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  job_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number>0),
  raw_data jsonb NOT NULL CHECK (jsonb_typeof(raw_data)='object'),
  normalized_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(normalized_data)='object'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VALID','INVALID')),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors)='array'),
  imported_entity_id uuid,
  FOREIGN KEY (client_id,job_id) REFERENCES import_jobs(client_id,id),
  UNIQUE (job_id,row_number),
  UNIQUE (client_id,id)
);

CREATE TABLE imported_history_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  station_id uuid,
  import_job_row_id uuid NOT NULL,
  record_date date NOT NULL,
  record_type text NOT NULL CHECK (length(trim(record_type)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1000),
  amount numeric(14,2),
  currency_code text CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  additional_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(additional_data)='object'),
  imported_by uuid NOT NULL REFERENCES app_users(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id,station_id) REFERENCES stations(client_id,id),
  FOREIGN KEY (client_id,import_job_row_id) REFERENCES import_job_rows(client_id,id),
  UNIQUE (client_id,import_job_row_id)
);

CREATE FUNCTION guard_import_job_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('COMMITTED','FAILED') THEN RAISE EXCEPTION 'completed import jobs are immutable'; END IF;
  IF NEW.client_id<>OLD.client_id OR NEW.station_id IS DISTINCT FROM OLD.station_id
    OR NEW.import_kind<>OLD.import_kind OR NEW.source_name<>OLD.source_name OR NEW.row_count<>OLD.row_count
    OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'import job source metadata is immutable';
  END IF;
  IF NOT ((OLD.status='UPLOADED' AND NEW.status IN ('UPLOADED','VALIDATED','FAILED'))
    OR (OLD.status='VALIDATED' AND NEW.status IN ('VALIDATED','COMMITTED'))) THEN
    RAISE EXCEPTION 'invalid import job state transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER import_job_state_guard BEFORE UPDATE ON import_jobs
FOR EACH ROW EXECUTE FUNCTION guard_import_job_mutation();

CREATE FUNCTION guard_import_job_row_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE job_status text;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT status INTO job_status FROM import_jobs WHERE client_id=OLD.client_id AND id=OLD.job_id;
    IF job_status<>'UPLOADED' THEN RAISE EXCEPTION 'validated import rows are immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT status INTO job_status FROM import_jobs WHERE client_id=NEW.client_id AND id=NEW.job_id;
    IF job_status<>'UPLOADED' THEN RAISE EXCEPTION 'rows can only be added to an uploaded job'; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO job_status FROM import_jobs WHERE client_id=OLD.client_id AND id=OLD.job_id;
  IF job_status='UPLOADED' THEN RETURN NEW; END IF;
  IF job_status='VALIDATED' AND NEW.id=OLD.id AND NEW.client_id=OLD.client_id AND NEW.job_id=OLD.job_id
    AND NEW.row_number=OLD.row_number AND NEW.raw_data=OLD.raw_data AND NEW.normalized_data=OLD.normalized_data
    AND NEW.status=OLD.status AND NEW.errors=OLD.errors AND OLD.imported_entity_id IS NULL AND NEW.imported_entity_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'validated import row content is immutable';
END
$$;
CREATE TRIGGER import_job_rows_state_guard BEFORE INSERT OR UPDATE OR DELETE ON import_job_rows
FOR EACH ROW EXECUTE FUNCTION guard_import_job_row_mutation();

CREATE FUNCTION prevent_imported_history_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'imported history records are immutable'; END $$;
CREATE TRIGGER imported_history_records_append_only BEFORE UPDATE OR DELETE ON imported_history_records
FOR EACH ROW EXECUTE FUNCTION prevent_imported_history_mutation();

CREATE INDEX import_jobs_client_history_idx ON import_jobs(client_id,created_at DESC);
CREATE INDEX import_job_rows_job_status_idx ON import_job_rows(client_id,job_id,status,row_number);
CREATE INDEX imported_history_lookup_idx ON imported_history_records(client_id,station_id,record_date DESC,record_type);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY import_jobs_scope ON import_jobs
  USING (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));
ALTER TABLE import_job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY import_job_rows_scope ON import_job_rows
  USING (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));
ALTER TABLE imported_history_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_history_records FORCE ROW LEVEL SECURITY;
CREATE POLICY imported_history_records_scope ON imported_history_records
  USING (app_has_client_access(client_id))
  WITH CHECK (app_has_client_role(client_id,ARRAY['OWNER','MANAGER','ACCOUNTANT']));

GRANT SELECT,INSERT,UPDATE ON import_jobs TO station_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON import_job_rows TO station_app;
GRANT SELECT,INSERT ON imported_history_records TO station_app;

RESET ROLE;
