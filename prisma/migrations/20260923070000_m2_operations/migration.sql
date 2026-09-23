-- CreateEnum
CREATE TYPE "StayType" AS ENUM ('NIGHTLY', 'DAY_USE');

-- CreateEnum
CREATE TYPE "ReservationSource" AS ENUM ('WALK_IN', 'PHONE', 'WHATSAPP', 'MARKETPLACE', 'BOOKING_SITE', 'CORPORATE', 'OTA');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('NIN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "VisitPurpose" AS ENUM ('BUSINESS', 'LEISURE', 'EVENT', 'TRANSIT', 'OTHER');

-- CreateEnum
CREATE TYPE "FolioKind" AS ENUM ('RESERVATION', 'WALK_IN');

-- CreateEnum
CREATE TYPE "FolioStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "FolioEntryType" AS ENUM ('ROOM', 'DAY_USE', 'EXTRA', 'TAX', 'SERVICE_CHARGE', 'DISCOUNT', 'PAYMENT', 'REFUND', 'VOID');

-- CreateEnum
CREATE TYPE "TaxCode" AS ENUM ('VAT', 'CONSUMPTION', 'SERVICE_CHARGE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'POS', 'CARD_ONLINE', 'COMPLIMENTARY', 'CITY_LEDGER');

-- CreateEnum
CREATE TYPE "GuestInvoiceKind" AS ENUM ('PROFORMA', 'FINAL');

-- CreateEnum
CREATE TYPE "DocumentCounterKind" AS ENUM ('INVOICE', 'PROFORMA', 'RECEIPT');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED', 'APPROVED');

-- CreateEnum
CREATE TYPE "GuardRule" AS ENUM ('SHIFT_VARIANCE', 'VOIDED_PAYMENT', 'CHECKOUT_WITH_BALANCE', 'OCCUPIED_WITHOUT_STAY', 'DISCOUNT_OVER_THRESHOLD', 'DIRTY_OVERRIDE_CHECKIN', 'DAY_USE_OVERSTAY', 'LATE_REGISTRATION', 'REPEATED_VOIDS_BY_USER', 'ROOM_STATUS_FLIP');

-- CreateEnum
CREATE TYPE "GuardSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "GuardStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "HousekeepingTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE');

-- CreateEnum
CREATE TYPE "HousekeepingTaskReason" AS ENUM ('CHECKOUT', 'ROOM_MOVE', 'MANUAL');

-- CreateEnum
CREATE TYPE "DigestChannel" AS ENUM ('WHATSAPP', 'LOG');

-- CreateEnum
CREATE TYPE "DigestStatus" AS ENUM ('SENT', 'LOGGED', 'FAILED');

-- CreateEnum
CREATE TYPE "NightAuditStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "approval_pin_hash" TEXT,
ADD COLUMN     "pin_failed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pin_locked_until" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "guests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "gender" "Gender",
    "date_of_birth" DATE,
    "nationality" TEXT NOT NULL DEFAULT 'Nigerian',
    "address" TEXT,
    "id_type" "IdType",
    "id_number_enc" TEXT,
    "id_number_last4" TEXT,
    "id_image_key" TEXT,
    "id_image_content_type" TEXT,
    "vehicle_plate" TEXT,
    "company" TEXT,
    "vip" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "consent_at" TIMESTAMPTZ(3),
    "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "anonymised_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "guest_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "room_id" UUID,
    "stay_type" "StayType" NOT NULL DEFAULT 'NIGHTLY',
    "arrival_at" TIMESTAMPTZ(3) NOT NULL,
    "departure_at" TIMESTAMPTZ(3) NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "source" "ReservationSource" NOT NULL DEFAULT 'WALK_IN',
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "rate_kobo" BIGINT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID,
    "checked_in_at" TIMESTAMPTZ(3),
    "checked_in_by_id" UUID,
    "checked_out_at" TIMESTAMPTZ(3),
    "checked_out_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "no_show_at" TIMESTAMPTZ(3),
    "client_created_at" TIMESTAMPTZ(3),
    "reg_arriving_from" TEXT,
    "reg_going_to" TEXT,
    "reg_purpose" "VisitPurpose",
    "reg_vehicle_plate" TEXT,
    "registration_completed_at" TIMESTAMPTZ(3),
    "registration_completed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folios" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "kind" "FolioKind" NOT NULL DEFAULT 'RESERVATION',
    "status" "FolioStatus" NOT NULL DEFAULT 'OPEN',
    "reservation_id" UUID,
    "guest_id" UUID,
    "name" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "folios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "type" "FolioEntryType" NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "description" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "parent_entry_id" UUID,
    "ref_entry_id" UUID,
    "tax_code" "TaxCode",
    "rate_bps" INTEGER,
    "inclusive" BOOLEAN,
    "payment_method" "PaymentMethod",
    "payment_ref" TEXT,
    "shift_id" UUID,
    "reason" TEXT,
    "approved_by_id" UUID,
    "created_by_id" UUID,
    "client_created_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folio_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_counters" (
    "tenant_id" UUID NOT NULL,
    "kind" "DocumentCounterKind" NOT NULL,
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("tenant_id","kind","year")
);

-- CreateTable
CREATE TABLE "guest_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "kind" "GuestInvoiceKind" NOT NULL,
    "number" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_date" DATE NOT NULL,
    "total_kobo" BIGINT NOT NULL,
    "balance_kobo" BIGINT NOT NULL,
    "guest_name" TEXT,
    "reservation_code" TEXT,
    "document" JSONB NOT NULL,
    "issued_by_id" UUID,

    CONSTRAINT "guest_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" "PaymentMethod" NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "guest_name" TEXT,
    "reservation_code" TEXT,
    "document" JSONB NOT NULL,
    "issued_by_id" UUID,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "vat_enabled" BOOLEAN NOT NULL DEFAULT true,
    "vat_rate_bps" INTEGER NOT NULL DEFAULT 750,
    "vat_inclusive" BOOLEAN NOT NULL DEFAULT false,
    "consumption_enabled" BOOLEAN NOT NULL DEFAULT false,
    "consumption_rate_bps" INTEGER NOT NULL DEFAULT 500,
    "consumption_inclusive" BOOLEAN NOT NULL DEFAULT false,
    "consumption_label" TEXT NOT NULL DEFAULT 'Lagos consumption tax',
    "service_charge_enabled" BOOLEAN NOT NULL DEFAULT false,
    "service_charge_rate_bps" INTEGER NOT NULL DEFAULT 1000,
    "service_charge_inclusive" BOOLEAN NOT NULL DEFAULT false,
    "discount_approval_threshold_bps" INTEGER NOT NULL DEFAULT 1000,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digest_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "digest_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashier_shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "user_name" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_float_kobo" BIGINT NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "counted_cash_kobo" BIGINT,
    "declared_pos_kobo" BIGINT,
    "declared_transfer_kobo" BIGINT,
    "denominations" JSONB,
    "expected_cash_kobo" BIGINT,
    "expected_pos_kobo" BIGINT,
    "expected_transfer_kobo" BIGINT,
    "payments_count" INTEGER,
    "notes" TEXT NOT NULL DEFAULT '',
    "close_notes" TEXT,
    "approved_by_id" UUID,
    "approved_by_name" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "approval_notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cashier_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_flags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule" "GuardRule" NOT NULL,
    "severity" "GuardSeverity" NOT NULL,
    "status" "GuardStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "amount_kobo" BIGINT,
    "room_id" UUID,
    "reservation_id" UUID,
    "shift_id" UUID,
    "user_id" UUID,
    "user_name" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "suggestion" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "resolved_by_id" UUID,
    "resolved_by_name" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guard_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_digests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "trigger" "JobTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "channel" "DigestChannel" NOT NULL,
    "status" "DigestStatus" NOT NULL,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_digests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "night_audit_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "NightAuditStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" "JobTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "summary" JSONB,
    "error" TEXT,
    "run_by_id" UUID,
    "run_by_name" TEXT,

    CONSTRAINT "night_audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_stats" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "rooms_available" INTEGER NOT NULL,
    "rooms_sold" INTEGER NOT NULL,
    "occupancy_rate" DOUBLE PRECISION NOT NULL,
    "adr_kobo" BIGINT NOT NULL,
    "revpar_kobo" BIGINT NOT NULL,
    "room_revenue_kobo" BIGINT NOT NULL,
    "total_revenue_kobo" BIGINT NOT NULL,
    "payments_total_kobo" BIGINT NOT NULL,
    "day_use_count" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "reservation_id" UUID,
    "status" "HousekeepingTaskStatus" NOT NULL DEFAULT 'PENDING',
    "reason" "HousekeepingTaskReason" NOT NULL DEFAULT 'CHECKOUT',
    "notes" TEXT NOT NULL DEFAULT '',
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "completed_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "housekeeping_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateIndex
CREATE INDEX "guests_tenant_id_full_name_idx" ON "guests"("tenant_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "guests_tenant_id_phone_key" ON "guests"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_status_idx" ON "reservations"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_arrival_at_idx" ON "reservations"("tenant_id", "arrival_at");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_departure_at_idx" ON "reservations"("tenant_id", "departure_at");

-- CreateIndex
CREATE INDEX "reservations_guest_id_idx" ON "reservations"("guest_id");

-- CreateIndex
CREATE INDEX "reservations_room_type_id_idx" ON "reservations"("room_type_id");

-- CreateIndex
CREATE INDEX "reservations_room_id_idx" ON "reservations"("room_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenant_id_code_key" ON "reservations"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "folios_reservation_id_key" ON "folios"("reservation_id");

-- CreateIndex
CREATE INDEX "folios_tenant_id_status_idx" ON "folios"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "folio_entries_ref_entry_id_key" ON "folio_entries"("ref_entry_id");

-- CreateIndex
CREATE INDEX "folio_entries_folio_id_created_at_idx" ON "folio_entries"("folio_id", "created_at");

-- CreateIndex
CREATE INDEX "folio_entries_tenant_id_business_date_idx" ON "folio_entries"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "folio_entries_tenant_id_type_created_at_idx" ON "folio_entries"("tenant_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "folio_entries_shift_id_idx" ON "folio_entries"("shift_id");

-- CreateIndex
CREATE INDEX "folio_entries_parent_entry_id_idx" ON "folio_entries"("parent_entry_id");

-- CreateIndex
CREATE INDEX "guest_invoices_tenant_id_issued_at_idx" ON "guest_invoices"("tenant_id", "issued_at");

-- CreateIndex
CREATE INDEX "guest_invoices_folio_id_idx" ON "guest_invoices"("folio_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_invoices_tenant_id_number_key" ON "guest_invoices"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_entry_id_key" ON "receipts"("entry_id");

-- CreateIndex
CREATE INDEX "receipts_tenant_id_issued_at_idx" ON "receipts"("tenant_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_tenant_id_number_key" ON "receipts"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "tax_settings_property_id_key" ON "tax_settings"("property_id");

-- CreateIndex
CREATE INDEX "tax_settings_tenant_id_idx" ON "tax_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "digest_settings_property_id_key" ON "digest_settings"("property_id");

-- CreateIndex
CREATE INDEX "digest_settings_tenant_id_idx" ON "digest_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "cashier_shifts_tenant_id_status_idx" ON "cashier_shifts"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "cashier_shifts_tenant_id_opened_at_idx" ON "cashier_shifts"("tenant_id", "opened_at");

-- CreateIndex
CREATE INDEX "cashier_shifts_user_id_idx" ON "cashier_shifts"("user_id");

-- CreateIndex
CREATE INDEX "guard_flags_tenant_id_status_created_at_idx" ON "guard_flags"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "guard_flags_tenant_id_rule_idx" ON "guard_flags"("tenant_id", "rule");

-- CreateIndex
CREATE INDEX "owner_digests_tenant_id_created_at_idx" ON "owner_digests"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "owner_digests_tenant_id_business_date_idx" ON "owner_digests"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "night_audit_runs_tenant_id_business_date_key" ON "night_audit_runs"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_stats_tenant_id_date_key" ON "daily_stats"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_tenant_id_status_idx" ON "housekeeping_tasks"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "cashier_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_invoices" ADD CONSTRAINT "guest_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_invoices" ADD CONSTRAINT "guest_invoices_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_folio_id_fkey" FOREIGN KEY ("folio_id") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "folio_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digest_settings" ADD CONSTRAINT "digest_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digest_settings" ADD CONSTRAINT "digest_settings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_flags" ADD CONSTRAINT "guard_flags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_flags" ADD CONSTRAINT "guard_flags_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_flags" ADD CONSTRAINT "guard_flags_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_digests" ADD CONSTRAINT "owner_digests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "night_audit_runs" ADD CONSTRAINT "night_audit_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written: constraints Prisma cannot express.
-- =============================================================================

-- No double booking, enforced by the database. Two active stays on the same
-- room may not overlap in time. '[)' makes a 12:00 departure and a 12:00
-- arrival compatible.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_overlap"
  EXCLUDE USING gist (
    "room_id" WITH =,
    tstzrange("arrival_at", "departure_at", '[)') WITH &&
  ) WHERE ("room_id" IS NOT NULL AND "status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN'));

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_valid_range" CHECK ("departure_at" > "arrival_at"),
  ADD CONSTRAINT "reservations_occupancy" CHECK ("adults" >= 1 AND "children" >= 0),
  ADD CONSTRAINT "reservations_rate" CHECK ("rate_kobo" >= 0);

-- Sign rules for ledger lines. Taxes may be negative (discount tax), VOID
-- mirrors whatever it voids.
ALTER TABLE "folio_entries"
  ADD CONSTRAINT "folio_entries_sign" CHECK (
    ("type" IN ('ROOM', 'DAY_USE', 'EXTRA', 'REFUND') AND "amount_kobo" > 0)
    OR ("type" IN ('PAYMENT', 'DISCOUNT') AND "amount_kobo" < 0)
    OR ("type" IN ('TAX', 'SERVICE_CHARGE', 'VOID'))
  ),
  ADD CONSTRAINT "folio_entries_void_ref" CHECK (("type" = 'VOID') = ("ref_entry_id" IS NOT NULL));

-- Folio entries are immutable for every role, including the owner.
CREATE OR REPLACE FUNCTION folio_entries_block_mutation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'folio_entries is append-only: % is not allowed (post a VOID entry instead)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER folio_entries_append_only
  BEFORE UPDATE OR DELETE ON "folio_entries"
  FOR EACH ROW EXECUTE FUNCTION folio_entries_block_mutation();

CREATE TRIGGER folio_entries_no_truncate
  BEFORE TRUNCATE ON "folio_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION folio_entries_block_mutation();

-- Issued documents are immutable too.
CREATE TRIGGER guest_invoices_append_only
  BEFORE UPDATE OR DELETE ON "guest_invoices"
  FOR EACH ROW EXECUTE FUNCTION folio_entries_block_mutation();
CREATE TRIGGER receipts_append_only
  BEFORE UPDATE OR DELETE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION folio_entries_block_mutation();

-- One open cashier shift per user.
CREATE UNIQUE INDEX "cashier_shifts_one_open_per_user"
  ON "cashier_shifts" ("user_id") WHERE "status" = 'OPEN';

-- One live Revenue Guard flag per subject.
CREATE UNIQUE INDEX "guard_flags_live_dedupe"
  ON "guard_flags" ("tenant_id", "dedupe_key") WHERE "status" IN ('OPEN', 'ACKNOWLEDGED');

ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_positive" CHECK ("last_value" >= 0);
