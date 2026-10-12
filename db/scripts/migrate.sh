#!/bin/sh
set -eu

migration_dir=${MIGRATION_DIR:-/migrations}

# Migration history is controlled by the database administrator role, not the
# application role. Each migration itself runs atomically in a single session.
psql --no-psqlrc --set=ON_ERROR_STOP=1 --command \
  'CREATE TABLE IF NOT EXISTS public.schema_migrations (
     version text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )'

applied_count=$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --command 'SELECT count(*) FROM public.schema_migrations')
if [ "$applied_count" = "0" ]; then
  existing_schema=$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    --command "SELECT to_regclass('public.clients') IS NOT NULL")
  if [ "$existing_schema" = "t" ]; then
    complete_schema=$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
      --command "SELECT
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_users' AND column_name='auth_subject')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stations' AND column_name='meter_mode')
        AND has_table_privilege('station_app', 'public.clients', 'SELECT')
        AND has_function_privilege('station_app', 'public.app_resolve_principal(text,uuid)', 'EXECUTE')")
    if [ "$complete_schema" != "t" ]; then
      echo "Existing schema is incomplete; refusing to guess which migrations ran." >&2
      exit 1
    fi
    # Adopt a database created by the original first-boot initialization path.
    psql --no-psqlrc --set=ON_ERROR_STOP=1 --command \
      "INSERT INTO public.schema_migrations (version) VALUES
       ('001_foundations.sql'), ('002_identity_and_roles.sql'), ('003_runtime_grants.sql')"
    echo "Recorded the verified existing database as the current migration baseline."
  fi
fi

found=0
for file in "$migration_dir"/*.sql; do
  [ -f "$file" ] || continue
  found=1
  version=${file##*/}
  case "$version" in
    *[!A-Za-z0-9_.-]*) echo "Invalid migration filename: $version" >&2; exit 1 ;;
  esac
  applied=$(psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    --command "SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '$version')")
  if [ "$applied" = "t" ]; then
    continue
  fi

  bundle=$(mktemp)
  trap 'rm -f "$bundle"' EXIT HUP INT TERM
  cat "$file" > "$bundle"
  printf '\nINSERT INTO public.schema_migrations (version) VALUES (\047%s\047);\n' "$version" >> "$bundle"
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --single-transaction --file "$bundle"
  rm -f "$bundle"
  trap - EXIT HUP INT TERM
  echo "Applied $version"
done

if [ "$found" = "0" ]; then
  echo "No SQL migrations found in $migration_dir" >&2
  exit 1
fi
