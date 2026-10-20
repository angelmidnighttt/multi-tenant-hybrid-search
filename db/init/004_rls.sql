-- =============================================================================
-- 004 - Row-Level Security + privileges
-- =============================================================================
-- ENABLE: turns RLS on. FORCE: applies RLS to the owner (app_owner) as well.
-- Superusers and BYPASSRLS roles still bypass RLS -> the app never uses them.
-- =============================================================================
SET ROLE app_owner;

ALTER TABLE app.tenants           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants           FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.documents         FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.chunks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chunks            FORCE  ROW LEVEL SECURITY;

-- A tenant can only see its own row. There is no INSERT/UPDATE/DELETE policy
-- => those commands are denied by default.
CREATE POLICY tenant_self ON app.tenants
  FOR SELECT
  USING (id = app.current_tenant_id());

-- USING: which rows can be read/updated/deleted. WITH CHECK: rows being written
-- must belong to the current tenant (blocks inserting into the wrong tenant and
-- updates that move a row to another tenant).
CREATE POLICY tenant_isolation ON app.documents
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON app.chunks
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- -----------------------------------------------------------------------------
-- app_user privileges
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA app TO app_user;
GRANT SELECT ON app.tenants TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.documents, app.chunks TO app_user;

RESET ROLE;
ALTER ROLE app_user SET search_path = app, public;
