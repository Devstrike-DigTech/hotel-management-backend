-- =============================================================================
-- Row-Level Security, runtime-role grants and the append-only audit log.
--
-- Access model (see README "Tenant isolation"):
--   * The API connects as `hotel_app` (NOSUPERUSER, NOBYPASSRLS).
--   * Every request runs its queries inside a transaction that first calls
--       SELECT set_config('app.tenant_id', '<uuid>', true)      -- tenant work
--     or
--       SELECT set_config('app.context', 'public' | 'system', true)
--     `true` makes the setting transaction-local, so it can never leak to the
--     next user of a pooled connection.
--   * With no setting at all, every tenant-scoped query returns zero rows and
--     every write fails the WITH CHECK clause: the default is "fail closed".
--   * `public`  : SELECT-only on marketplace data (hotels, room types, rooms,
--                 subscription status). No staff, tokens, invoices or audit.
--   * `system`  : full access. Used only by the platform console, the Paystack
--                 webhook handler and the dunning job.
--   * Login and refresh-token lookups go through two narrow SECURITY DEFINER
--     functions instead of the `system` context.
-- =============================================================================

-- Runtime role. Created without LOGIN if it does not exist so that the grants
-- below always apply; operators give it a password / LOGIN out of band.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_app') THEN
    CREATE ROLE hotel_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Helper functions used by the policies. STABLE SQL functions are inlined by
-- the planner, so they cost nothing per row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_context() RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.context', true), ''), 'none')
$$;

-- -----------------------------------------------------------------------------
-- Tenant-scoped tables: tenant isolation + system access.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'properties', 'room_types', 'rooms', 'users', 'refresh_tokens',
    'tenant_feature_overrides', 'subscriptions', 'invoices', 'audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format(
      'CREATE POLICY system_access ON %I FOR ALL
         USING (app_context() = ''system'')
         WITH CHECK (app_context() = ''system'')', t);
  END LOOP;
END
$$;

-- The tenants table is keyed by its own id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants FOR ALL
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());
CREATE POLICY system_access ON tenants FOR ALL
  USING (app_context() = 'system')
  WITH CHECK (app_context() = 'system');

-- Public marketplace reads: SELECT only, on the tables a hotel page needs.
-- Writes in the public context always fail (no INSERT/UPDATE/DELETE policy).
CREATE POLICY public_read ON tenants       FOR SELECT USING (app_context() = 'public');
CREATE POLICY public_read ON properties    FOR SELECT USING (app_context() = 'public');
CREATE POLICY public_read ON room_types    FOR SELECT USING (app_context() = 'public');
CREATE POLICY public_read ON rooms         FOR SELECT USING (app_context() = 'public');
CREATE POLICY public_read ON subscriptions FOR SELECT USING (app_context() = 'public');

-- -----------------------------------------------------------------------------
-- Global catalogue: readable by everyone, writable only in the system context.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'features', 'plan_features']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT USING (true)', t);
    EXECUTE format(
      'CREATE POLICY system_access ON %I FOR ALL
         USING (app_context() = ''system'')
         WITH CHECK (app_context() = ''system'')', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Platform-only tables.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_users', 'payment_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY system_access ON %I FOR ALL
         USING (app_context() = ''system'')
         WITH CHECK (app_context() = ''system'')', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Append-only audit log. Enforced by trigger (applies to every role that does
-- not explicitly disable triggers) and by withholding UPDATE/DELETE grants.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();

-- -----------------------------------------------------------------------------
-- Narrow cross-tenant lookups for authentication. SECURITY DEFINER functions
-- run as the schema owner and therefore bypass RLS, but they only return the
-- single row matching an exact email / token hash.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_auth_find_user(p_email text)
  RETURNS TABLE (
    id uuid,
    tenant_id uuid,
    email text,
    full_name text,
    role text,
    password_hash text,
    is_active boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.email, u.full_name, u.role::text, u.password_hash, u.is_active
  FROM users u
  WHERE u.email = lower(p_email)
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app_auth_find_refresh_token(p_token_hash text)
  RETURNS TABLE (
    id uuid,
    tenant_id uuid,
    user_id uuid,
    family_id uuid,
    expires_at timestamptz,
    revoked_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.tenant_id, r.user_id, r.family_id, r.expires_at, r.revoked_at
  FROM refresh_tokens r
  WHERE r.token_hash = p_token_hash
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app_auth_find_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_auth_find_refresh_token(text) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Grants for the runtime role. Granted table by table on purpose: a future
-- table is invisible to the API until a migration grants it (and, if it is
-- tenant-scoped, enables RLS on it).
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO hotel_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, properties, room_types, rooms, users, refresh_tokens,
  tenant_feature_overrides, subscriptions, invoices, payment_events,
  platform_users, plans, features, plan_features
TO hotel_app;

GRANT SELECT, INSERT ON audit_logs TO hotel_app;

GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO hotel_app;
GRANT EXECUTE ON FUNCTION app_context() TO hotel_app;
GRANT EXECUTE ON FUNCTION app_auth_find_user(text) TO hotel_app;
GRANT EXECUTE ON FUNCTION app_auth_find_refresh_token(text) TO hotel_app;
