-- =============================================================================
-- Security hardening (M2).
--
-- M1 let the runtime role `hotel_app` switch to a cross-tenant "system"
-- context by setting the GUC `app.context`. Any SQL running as hotel_app (for
-- example through an injection) could therefore read every tenant. This
-- migration removes that path:
--
--  1. Cross-tenant work (platform console, Paystack webhooks, dunning,
--     scheduled jobs that enumerate tenants) now connects as a separate role,
--     `hotel_platform` (NOSUPERUSER NOBYPASSRLS), through a second connection
--     pool (DATABASE_PLATFORM_URL). Its access comes from policies granted
--     `TO hotel_platform`, not from a GUC.
--  2. The tenant and public contexts of `hotel_app` are signed. DbService sets
--       app.tenant_id  = <uuid>
--       app.context_sig = hex(HMAC-SHA256(DB_CONTEXT_SECRET, 'tenant:' || <uuid>))
--     and the policies only honour the tenant id when the signature verifies
--     against a key stored in the private schema `app_private`, which
--     hotel_app cannot read. Knowing another tenant's uuid is not enough, and
--     setting `app.context` does nothing any more.
--  3. The key is installed by the API at start-up through
--     app_install_context_key(), executable only by hotel_platform.
--
-- Policies call the verifying functions through a scalar sub-select
-- `(SELECT app_current_tenant_id())`, which Postgres evaluates once per query
-- (InitPlan) instead of once per row.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_platform') THEN
    CREATE ROLE hotel_platform NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Private key store.
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS app_private.context_keys (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  key        text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_private.context_keys FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_install_context_key(p_key text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_key IS NULL OR length(p_key) < 32 THEN
    RAISE EXCEPTION 'context key must be at least 32 characters';
  END IF;
  INSERT INTO app_private.context_keys (id, key, updated_at) VALUES (1, p_key, now())
  ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, updated_at = now()
  WHERE app_private.context_keys.key IS DISTINCT FROM EXCLUDED.key;
END
$$;
REVOKE ALL ON FUNCTION app_install_context_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_install_context_key(text) TO hotel_platform;

-- Signature check shared by the context functions.
CREATE OR REPLACE FUNCTION app_private.verify_context(p_payload text, p_sig text) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  IF p_payload IS NULL OR p_sig IS NULL THEN
    RETURN false;
  END IF;
  SELECT key INTO v_key FROM app_private.context_keys WHERE id = 1;
  IF v_key IS NULL THEN
    RETURN false;
  END IF;
  RETURN encode(hmac(convert_to(p_payload, 'UTF8'), convert_to(v_key, 'UTF8'), 'sha256'), 'hex') = lower(p_sig);
END
$$;
REVOKE ALL ON FUNCTION app_private.verify_context(text, text) FROM PUBLIC;

-- Tenant id of the current transaction, or NULL unless correctly signed.
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_tid text := NULLIF(current_setting('app.tenant_id', true), '');
  v_sig text := NULLIF(current_setting('app.context_sig', true), '');
BEGIN
  IF v_tid IS NULL OR v_tid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  IF app_private.verify_context('tenant:' || lower(v_tid), v_sig) THEN
    RETURN v_tid::uuid;
  END IF;
  RETURN NULL;
END
$$;

-- True only inside a correctly signed anonymous marketplace context.
CREATE OR REPLACE FUNCTION app_is_public() RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN current_setting('app.context', true) = 'public'
     AND app_private.verify_context('public', NULLIF(current_setting('app.context_sig', true), ''));
END
$$;

REVOKE ALL ON FUNCTION app_current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_public() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO hotel_app, hotel_platform;
GRANT EXECUTE ON FUNCTION app_is_public() TO hotel_app, hotel_platform;
GRANT USAGE ON SCHEMA app_private TO hotel_app, hotel_platform;
GRANT EXECUTE ON FUNCTION app_private.verify_context(text, text) TO hotel_app, hotel_platform;

-- The M1 escape hatch: app_context() = 'system'. It stays defined (always
-- returning a value hotel_app may set) but no policy consults it any more.
CREATE OR REPLACE FUNCTION app_context() RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.context', true), ''), 'none')
$$;

-- -----------------------------------------------------------------------------
-- Rebuild policies on every tenant-scoped table (M1 + M2).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- M1
    'properties', 'room_types', 'rooms', 'users', 'refresh_tokens',
    'tenant_feature_overrides', 'subscriptions', 'invoices', 'audit_logs',
    -- M2
    'guests', 'reservations', 'folios', 'folio_entries', 'document_counters',
    'guest_invoices', 'receipts', 'tax_settings', 'digest_settings',
    'cashier_shifts', 'guard_flags', 'owner_digests', 'night_audit_runs',
    'daily_stats', 'housekeeping_tasks', 'idempotency_keys'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS system_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO hotel_app
         USING (tenant_id = (SELECT app_current_tenant_id()))
         WITH CHECK (tenant_id = (SELECT app_current_tenant_id()))', t);
    EXECUTE format(
      'CREATE POLICY platform_access ON %I FOR ALL TO hotel_platform
         USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;

DROP POLICY IF EXISTS tenant_isolation ON tenants;
DROP POLICY IF EXISTS system_access ON tenants;
CREATE POLICY tenant_isolation ON tenants FOR ALL TO hotel_app
  USING (id = (SELECT app_current_tenant_id()))
  WITH CHECK (id = (SELECT app_current_tenant_id()));
CREATE POLICY platform_access ON tenants FOR ALL TO hotel_platform
  USING (true) WITH CHECK (true);

-- Public marketplace reads (signed public context): SELECT only.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'properties', 'room_types', 'rooms', 'subscriptions']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS public_read ON %I', t);
    EXECUTE format(
      'CREATE POLICY public_read ON %I FOR SELECT TO hotel_app USING ((SELECT app_is_public()))', t);
  END LOOP;
END
$$;

-- Global catalogue: readable by both roles, writable only by hotel_platform.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'features', 'plan_features']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS system_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY platform_access ON %I FOR ALL TO hotel_platform USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;

-- Platform-only tables.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_users', 'payment_events']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS system_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY platform_access ON %I FOR ALL TO hotel_platform USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Grants.
-- -----------------------------------------------------------------------------
-- hotel_app loses what it can no longer use: platform tables and catalogue writes.
REVOKE ALL ON platform_users, payment_events FROM hotel_app;
REVOKE INSERT, UPDATE, DELETE ON plans, features, plan_features FROM hotel_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  guests, reservations, folios, document_counters, tax_settings,
  digest_settings, cashier_shifts, guard_flags, owner_digests,
  night_audit_runs, daily_stats, housekeeping_tasks, idempotency_keys
TO hotel_app;
GRANT SELECT, INSERT ON folio_entries, guest_invoices, receipts TO hotel_app;

GRANT USAGE ON SCHEMA public TO hotel_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, properties, room_types, rooms, users, refresh_tokens,
  tenant_feature_overrides, subscriptions, invoices, payment_events,
  platform_users, plans, features, plan_features,
  guests, reservations, folios, document_counters, tax_settings,
  digest_settings, cashier_shifts, guard_flags, owner_digests,
  night_audit_runs, daily_stats, housekeeping_tasks, idempotency_keys
TO hotel_platform;
GRANT SELECT, INSERT ON audit_logs, folio_entries, guest_invoices, receipts TO hotel_platform;
