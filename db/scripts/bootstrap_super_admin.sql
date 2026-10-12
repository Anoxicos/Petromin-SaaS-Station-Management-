\set ON_ERROR_STOP on

\prompt 'OIDC token subject (sub): ' auth_subject
\prompt 'Administrator email: ' admin_email
\prompt 'Administrator display name: ' admin_display_name

SELECT (
  length(trim(:'auth_subject')) = 0
  OR length(:'auth_subject') > 255
  OR trim(:'admin_email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  OR length(trim(:'admin_display_name')) = 0
) AS invalid_input \gset

\if :invalid_input
  DO $bootstrap_error$
  BEGIN
    RAISE EXCEPTION 'Invalid input. No administrator was created.';
  END
  $bootstrap_error$;
\endif

BEGIN;
LOCK TABLE public.app_users IN EXCLUSIVE MODE;
SELECT EXISTS (SELECT 1 FROM public.app_users WHERE is_super_admin) AS already_bootstrapped \gset
\if :already_bootstrapped
  \echo 'A super-admin already exists. Bootstrap is disabled.'
  ROLLBACK;
  DO $bootstrap_error$
  BEGIN
    RAISE EXCEPTION 'A super-admin already exists. Bootstrap is disabled.';
  END
  $bootstrap_error$;
\endif

INSERT INTO public.app_users (auth_subject, email, display_name, is_super_admin)
VALUES (trim(:'auth_subject'), lower(trim(:'admin_email')), trim(:'admin_display_name'), true)
RETURNING id, email, display_name;
COMMIT;
