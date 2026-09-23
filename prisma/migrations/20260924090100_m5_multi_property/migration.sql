-- M5, part 2: multi-property.
--
-- Every operational table becomes property-scoped. Existing rows get the
-- tenant's primary (oldest) property, or the property of the row they hang
-- off (folio, reservation, room, room type). RLS stays tenant-based; the API
-- enforces property access on top of it (see README "Property scope").

-- The tenant's primary property (oldest, ties broken by id).
CREATE OR REPLACE FUNCTION pg_temp.primary_property(p_tenant uuid) RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT id FROM properties WHERE tenant_id = p_tenant ORDER BY created_at, id LIMIT 1
$$;

-- -----------------------------------------------------------------------------
-- New columns (nullable first, backfilled, then NOT NULL).
-- -----------------------------------------------------------------------------
ALTER TABLE "folio_entries" ADD COLUMN "property_id" UUID;
ALTER TABLE "guest_invoices" ADD COLUMN "property_id" UUID;
ALTER TABLE "receipts" ADD COLUMN "property_id" UUID;
ALTER TABLE "cashier_shifts" ADD COLUMN "property_id" UUID;
ALTER TABLE "guard_flags" ADD COLUMN "property_id" UUID;
ALTER TABLE "owner_digests" ADD COLUMN "property_id" UUID;
ALTER TABLE "night_audit_runs" ADD COLUMN "property_id" UUID;
ALTER TABLE "daily_stats" ADD COLUMN "property_id" UUID;
ALTER TABLE "housekeeping_tasks" ADD COLUMN "property_id" UUID;
ALTER TABLE "housekeeping_checklists" ADD COLUMN "property_id" UUID;
ALTER TABLE "lost_found_items" ADD COLUMN "property_id" UUID;
ALTER TABLE "maintenance_tickets" ADD COLUMN "property_id" UUID;
ALTER TABLE "room_blocks" ADD COLUMN "property_id" UUID;
ALTER TABLE "maintenance_schedules" ADD COLUMN "property_id" UUID;
ALTER TABLE "fuel_logs" ADD COLUMN "property_id" UUID;
ALTER TABLE "rate_overrides" ADD COLUMN "property_id" UUID;
ALTER TABLE "rate_restrictions" ADD COLUMN "property_id" UUID;
ALTER TABLE "payout_accounts" ADD COLUMN "property_id" UUID;
ALTER TABLE "booking_payments" ADD COLUMN "property_id" UUID;
ALTER TABLE "commission_entries" ADD COLUMN "property_id" UUID;
ALTER TABLE "audit_logs" ADD COLUMN "property_id" UUID;
ALTER TABLE "city_ledger_charges" ADD COLUMN "property_id" UUID;

ALTER TABLE "promo_codes" ADD COLUMN "property_ids" UUID[] DEFAULT ARRAY[]::UUID[];
ALTER TABLE "properties" ADD COLUMN "invoice_prefix" TEXT,
  ADD COLUMN "pos_void_approval_kobo" INTEGER NOT NULL DEFAULT 1000000;
ALTER TABLE "users" ADD COLUMN "all_properties" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "default_property_id" UUID;

-- -----------------------------------------------------------------------------
-- Backfill. The append-only ledgers are opened for this one statement each.
-- -----------------------------------------------------------------------------
ALTER TABLE "folio_entries" DISABLE TRIGGER folio_entries_append_only;
UPDATE "folio_entries" e SET property_id = f.property_id FROM "folios" f WHERE f.id = e.folio_id;
ALTER TABLE "folio_entries" ENABLE TRIGGER folio_entries_append_only;

ALTER TABLE "guest_invoices" DISABLE TRIGGER guest_invoices_append_only;
UPDATE "guest_invoices" i SET property_id = f.property_id FROM "folios" f WHERE f.id = i.folio_id;
ALTER TABLE "guest_invoices" ENABLE TRIGGER guest_invoices_append_only;

ALTER TABLE "receipts" DISABLE TRIGGER receipts_append_only;
UPDATE "receipts" r SET property_id = f.property_id FROM "folios" f WHERE f.id = r.folio_id;
ALTER TABLE "receipts" ENABLE TRIGGER receipts_append_only;

UPDATE "cashier_shifts" SET property_id = pg_temp.primary_property(tenant_id);
UPDATE "guard_flags" g SET property_id = COALESCE(
  (SELECT r.property_id FROM reservations r WHERE r.id = g.reservation_id),
  (SELECT rm.property_id FROM rooms rm WHERE rm.id = g.room_id),
  (SELECT s.property_id FROM cashier_shifts s WHERE s.id = g.shift_id),
  pg_temp.primary_property(g.tenant_id));
UPDATE "owner_digests" SET property_id = pg_temp.primary_property(tenant_id);
UPDATE "night_audit_runs" SET property_id = pg_temp.primary_property(tenant_id);
UPDATE "daily_stats" SET property_id = pg_temp.primary_property(tenant_id);
UPDATE "housekeeping_tasks" t SET property_id = rm.property_id FROM "rooms" rm WHERE rm.id = t.room_id;
UPDATE "housekeeping_checklists" c SET property_id = COALESCE(
  (SELECT rt.property_id FROM room_types rt WHERE rt.id = c.room_type_id),
  pg_temp.primary_property(c.tenant_id));
UPDATE "lost_found_items" l SET property_id = COALESCE(
  (SELECT rm.property_id FROM rooms rm WHERE rm.id = l.room_id),
  pg_temp.primary_property(l.tenant_id));
UPDATE "maintenance_tickets" m SET property_id = COALESCE(
  (SELECT rm.property_id FROM rooms rm WHERE rm.id = m.room_id),
  pg_temp.primary_property(m.tenant_id));
UPDATE "room_blocks" b SET property_id = rm.property_id FROM "rooms" rm WHERE rm.id = b.room_id;
UPDATE "maintenance_schedules" SET property_id = pg_temp.primary_property(tenant_id);
UPDATE "fuel_logs" SET property_id = pg_temp.primary_property(tenant_id);
UPDATE "rate_overrides" o SET property_id = rt.property_id FROM "room_types" rt WHERE rt.id = o.room_type_id;
UPDATE "rate_restrictions" x SET property_id = COALESCE(
  (SELECT rt.property_id FROM room_types rt WHERE rt.id = x.room_type_id),
  pg_temp.primary_property(x.tenant_id));
UPDATE "payout_accounts" SET property_id = pg_temp.primary_property(tenant_id);
UPDATE "booking_payments" p SET property_id = r.property_id FROM "reservations" r WHERE r.id = p.reservation_id;
UPDATE "commission_entries" c SET property_id = r.property_id FROM "reservations" r WHERE r.id = c.reservation_id;
UPDATE "city_ledger_charges" c SET property_id = r.property_id FROM "reservations" r WHERE r.id = c.reservation_id;
UPDATE "city_ledger_charges" c SET property_id = pg_temp.primary_property(c.tenant_id) WHERE property_id IS NULL;

-- Per-property document numbering: the existing invoice, proforma and
-- receipt sequences belong to the primary property.
ALTER TABLE "document_counters" DROP CONSTRAINT "document_counters_pkey",
  ADD COLUMN "scope" TEXT NOT NULL DEFAULT '';
UPDATE "document_counters" SET scope = pg_temp.primary_property(tenant_id)::text
 WHERE kind IN ('INVOICE', 'PROFORMA', 'RECEIPT');
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_pkey" PRIMARY KEY ("tenant_id", "kind", "year", "scope");

ALTER TABLE "folio_entries" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "guest_invoices" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "receipts" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "cashier_shifts" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "guard_flags" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "owner_digests" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "night_audit_runs" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "daily_stats" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "housekeeping_tasks" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "housekeeping_checklists" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "lost_found_items" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "maintenance_tickets" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "room_blocks" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "maintenance_schedules" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "fuel_logs" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "rate_overrides" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "rate_restrictions" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "payout_accounts" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "booking_payments" ALTER COLUMN "property_id" SET NOT NULL;
ALTER TABLE "commission_entries" ALTER COLUMN "property_id" SET NOT NULL;

-- -----------------------------------------------------------------------------
-- Keys and indexes.
-- -----------------------------------------------------------------------------
DROP INDEX "daily_stats_tenant_id_date_key";
DROP INDEX "night_audit_runs_tenant_id_business_date_key";
DROP INDEX "payout_accounts_tenant_id_key";
DROP INDEX "rate_plans_tenant_id_code_key";

CREATE INDEX "daily_stats_tenant_id_date_idx" ON "daily_stats"("tenant_id", "date");
CREATE UNIQUE INDEX "daily_stats_property_id_date_key" ON "daily_stats"("property_id", "date");
CREATE INDEX "night_audit_runs_tenant_id_business_date_idx" ON "night_audit_runs"("tenant_id", "business_date");
CREATE UNIQUE INDEX "night_audit_runs_property_id_business_date_key" ON "night_audit_runs"("property_id", "business_date");
CREATE UNIQUE INDEX "payout_accounts_property_id_key" ON "payout_accounts"("property_id");
CREATE INDEX "payout_accounts_tenant_id_idx" ON "payout_accounts"("tenant_id");
CREATE UNIQUE INDEX "properties_tenant_id_invoice_prefix_key" ON "properties"("tenant_id", "invoice_prefix");
CREATE INDEX "rate_plans_tenant_id_idx" ON "rate_plans"("tenant_id");
CREATE UNIQUE INDEX "rate_plans_property_id_code_key" ON "rate_plans"("property_id", "code");

-- Property lookups used by the scoped queries.
CREATE INDEX "folio_entries_property_id_business_date_idx" ON "folio_entries"("property_id", "business_date");
CREATE INDEX "cashier_shifts_property_id_status_idx" ON "cashier_shifts"("property_id", "status");
CREATE INDEX "guard_flags_property_id_status_idx" ON "guard_flags"("property_id", "status");
CREATE INDEX "housekeeping_tasks_property_id_business_date_idx" ON "housekeeping_tasks"("property_id", "business_date");
CREATE INDEX "reservations_property_id_arrival_at_idx" ON "reservations"("property_id", "arrival_at");
CREATE INDEX "folios_property_id_status_idx" ON "folios"("property_id", "status");
CREATE INDEX "audit_logs_property_id_idx" ON "audit_logs"("property_id") WHERE property_id IS NOT NULL;

-- One open cashier shift per user per property (was: per user).
DROP INDEX "cashier_shifts_one_open_per_user";
CREATE UNIQUE INDEX "cashier_shifts_one_open_per_user"
  ON "cashier_shifts" ("user_id", "property_id") WHERE "status" = 'OPEN';

-- Invoice prefixes: 2-6 characters A-Z / 0-9.
ALTER TABLE "properties" ADD CONSTRAINT "properties_invoice_prefix_format"
  CHECK (invoice_prefix IS NULL OR invoice_prefix ~ '^[A-Z0-9]{2,6}$');

-- -----------------------------------------------------------------------------
-- Foreign keys.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'folio_entries', 'guest_invoices', 'receipts', 'cashier_shifts', 'guard_flags', 'owner_digests',
    'night_audit_runs', 'daily_stats', 'housekeeping_tasks', 'housekeeping_checklists', 'lost_found_items',
    'maintenance_tickets', 'room_blocks', 'maintenance_schedules', 'fuel_logs', 'rate_overrides',
    'rate_restrictions', 'payout_accounts', 'booking_payments', 'commission_entries',
    'rate_plans', 'rate_rules', 'notification_settings'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE',
      t, t || '_property_id_fkey');
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Staff property access.
-- -----------------------------------------------------------------------------
CREATE TABLE "user_property_access" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_property_access_pkey" PRIMARY KEY ("user_id", "property_id")
);
CREATE INDEX "user_property_access_tenant_id_idx" ON "user_property_access"("tenant_id");
CREATE INDEX "user_property_access_property_id_idx" ON "user_property_access"("property_id");
ALTER TABLE "user_property_access" ADD CONSTRAINT "user_property_access_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_property_access" ADD CONSTRAINT "user_property_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_property_access" ADD CONSTRAINT "user_property_access_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_property_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_property_access" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_property_access" FOR ALL TO hotel_app
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));
CREATE POLICY platform_access ON "user_property_access" FOR ALL TO hotel_platform
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_property_access" TO hotel_app, hotel_platform;

-- New properties are created by the API (POST /properties): hotel_app may
-- insert them for its own tenant (tenant_isolation policy already covers it).
