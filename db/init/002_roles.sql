-- =============================================================================
-- 002 - Roles
-- =============================================================================
--   app_owner : owns the schema/tables, used for migrations (SET ROLE). Cannot log in.
--   app_user  : the role the application connects as. NOT the owner, NOT BYPASSRLS
--               => every query it runs is subject to RLS.
--
-- Creating a tenant is an admin operation: run it as superuser / the migration
-- role, never as app_user.
\getenv app_password APP_DB_PASSWORD

CREATE ROLE app_owner NOLOGIN;

CREATE ROLE app_user LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Only app_user (and superusers) may connect to this database.
REVOKE CONNECT ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT  CONNECT ON DATABASE :"DBNAME" TO app_user;
