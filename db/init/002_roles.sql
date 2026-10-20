-- =============================================================================
-- 002 - Roles
-- =============================================================================
--   app_owner  : owns the schema/tables, used for migrations (SET ROLE). Cannot log in.
--   app_user   : the role the application connects as. NOT the owner, NOT BYPASSRLS
--                => every query it runs is subject to RLS.
--   app_search : owns app.bm25_search() only (see 006_bm25_search.sql). BYPASSRLS
--                so the GIN full-text index can be used. Cannot log in, and no
--                role is a member of it.
--
-- Creating a tenant is an admin operation: run it as superuser / the migration
-- role, never as app_user.
\getenv app_password APP_DB_PASSWORD

CREATE ROLE app_owner NOLOGIN;

CREATE ROLE app_user LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE app_search NOLOGIN BYPASSRLS;

-- Only app_user (and superusers) may connect to this database.
REVOKE CONNECT ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT  CONNECT ON DATABASE :"DBNAME" TO app_user;
