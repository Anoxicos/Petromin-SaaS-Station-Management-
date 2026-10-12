#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=app_password="$STATION_APP_PASSWORD" <<'SQL'
CREATE ROLE station_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

CREATE ROLE station_app
  LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

GRANT CONNECT ON DATABASE station_platform TO station_app;
GRANT CONNECT ON DATABASE station_platform TO station_owner;
GRANT USAGE ON SCHEMA public TO station_app;
GRANT USAGE, CREATE ON SCHEMA public TO station_owner;
SQL
