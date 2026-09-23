-- M4, part 2: permissions and custom roles, housekeeping, maintenance and room
-- blocks, rates / seasons / restrictions, promo codes, corporate accounts and
-- the City Ledger, WhatsApp owner alerts. Every new tenant table gets RLS
-- (tenant_isolation for hotel_app, platform_access for hotel_platform).

-- AlterTable
ALTER TABLE "housekeeping_tasks" ADD COLUMN     "assignee_id" UUID,
ADD COLUMN     "assignee_name" TEXT,
ADD COLUMN     "business_date" DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Lagos')::date,
ADD COLUMN     "checklist" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "client_created_at" TIMESTAMPTZ(3),
ADD COLUMN     "due_at" TIMESTAMPTZ(3),
ADD COLUMN     "inspected_at" TIMESTAMPTZ(3),
ADD COLUMN     "inspected_by_id" UUID,
ADD COLUMN     "inspected_by_name" TEXT,
ADD COLUMN     "inspection_note" TEXT,
ADD COLUMN     "photos" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "skipped_reason" TEXT,
ADD COLUMN     "started_at" TIMESTAMPTZ(3),
ADD COLUMN     "type" "HousekeepingTaskType" NOT NULL DEFAULT 'CHECKOUT_CLEAN',
ALTER COLUMN "status" SET DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "require_inspection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stayover_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "cancel_policy" JSONB,
ADD COLUMN     "corporate_account_id" UUID,
ADD COLUMN     "nightly_rates" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "promo_code_id" UUID,
ADD COLUMN     "rate_plan_id" UUID;

-- AlterTable
ALTER TABLE "room_types" ADD COLUMN     "deep_clean_every_stays" INTEGER;

-- AlterTable
ALTER TABLE "rooms" ADD COLUMN     "stays_since_deep_clean" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "custom_role_id" UUID;

-- CreateTable
CREATE TABLE "custom_roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "based_on" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "custom_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_checklists" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "room_type_id" UUID,
    "task_type" "HousekeepingTaskType" NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "housekeeping_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_found_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Other',
    "room_id" UUID,
    "location" TEXT,
    "found_by_id" UUID,
    "found_by_name" TEXT,
    "found_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "LostFoundStatus" NOT NULL DEFAULT 'HELD',
    "storage_location" TEXT,
    "guest_id" UUID,
    "reservation_id" UUID,
    "returned_to" TEXT,
    "returned_at" TIMESTAMPTZ(3),
    "disposed_at" TIMESTAMPTZ(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "photos" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lost_found_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "room_id" UUID,
    "area" TEXT,
    "category" "MaintenanceCategory" NOT NULL,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "photos" JSONB NOT NULL DEFAULT '[]',
    "reported_by_id" UUID,
    "reported_by_name" TEXT,
    "assignee_id" UUID,
    "assignee_name" TEXT,
    "vendor_name" TEXT,
    "vendor_phone" TEXT,
    "blocks_room" BOOLEAN NOT NULL DEFAULT false,
    "cost_kobo" BIGINT,
    "resolution_note" TEXT,
    "sla_due_at" TIMESTAMPTZ(3) NOT NULL,
    "housekeeping_task_id" UUID,
    "schedule_id" UUID,
    "started_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "client_created_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "maintenance_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_ticket_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "from_value" TEXT,
    "to_value" TEXT,
    "note" TEXT,
    "by_id" UUID,
    "by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_blocks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "ticket_id" UUID,
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "room_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" "MaintenanceCategory" NOT NULL,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "room_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "area" TEXT,
    "every_days" INTEGER NOT NULL,
    "next_due_at" TIMESTAMPTZ(3) NOT NULL,
    "last_run_at" TIMESTAMPTZ(3),
    "checklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "maintenance_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "litres" DOUBLE PRECISION NOT NULL,
    "cost_kobo" BIGINT NOT NULL,
    "supplier" TEXT NOT NULL DEFAULT '',
    "run_hours" DOUBLE PRECISION,
    "generator" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "logged_by_id" UUID,
    "logged_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fuel_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" "RatePlanKind" NOT NULL,
    "is_bar" BOOLEAN NOT NULL DEFAULT false,
    "pricing" "RatePlanPricing" NOT NULL DEFAULT 'DERIVED',
    "adjustment_type" "AdjustmentType",
    "adjustment_value" INTEGER,
    "fixed_prices" JSONB NOT NULL DEFAULT '[]',
    "cancel_policy" JSONB,
    "min_nights" INTEGER,
    "max_nights" INTEGER,
    "includes_breakfast" BOOLEAN NOT NULL DEFAULT false,
    "channels" TEXT[] DEFAULT ARRAY['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE']::TEXT[],
    "room_type_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "room_type_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "days_of_week" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "adjustment_type" "AdjustmentType" NOT NULL,
    "adjustment_value" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT 'brass',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_overrides" (
    "tenant_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "rate_kobo" INTEGER NOT NULL,
    "note" TEXT,
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_overrides_pkey" PRIMARY KEY ("room_type_id","date")
);

-- CreateTable
CREATE TABLE "rate_restrictions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "room_type_id" UUID,
    "date" DATE NOT NULL,
    "closed_to_arrival" BOOLEAN NOT NULL DEFAULT false,
    "closed_to_departure" BOOLEAN NOT NULL DEFAULT false,
    "stop_sell" BOOLEAN NOT NULL DEFAULT false,
    "min_nights" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "type" "PromoType" NOT NULL,
    "value" INTEGER NOT NULL,
    "valid_from" DATE,
    "valid_to" DATE,
    "stay_from" DATE,
    "stay_to" DATE,
    "min_nights" INTEGER,
    "max_uses" INTEGER,
    "per_guest_limit" INTEGER,
    "channels" TEXT[] DEFAULT ARRAY['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE']::TEXT[],
    "room_type_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "first_booking_only" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_redemptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "promo_code_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "guest_phone" TEXT,
    "channel" TEXT NOT NULL,
    "status" "PromoRedemptionStatus" NOT NULL DEFAULT 'HELD',
    "discount_kobo" BIGINT NOT NULL,
    "nights" INTEGER NOT NULL DEFAULT 1,
    "confirmed_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "tax_id" TEXT NOT NULL DEFAULT '',
    "rate_plan_id" UUID,
    "credit_limit_kobo" BIGINT NOT NULL,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "billing_cycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "corporate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "city_ledger_charges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "reservation_id" UUID,
    "folio_id" UUID,
    "folio_entry_id" UUID,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "guest_name" TEXT,
    "reservation_code" TEXT,
    "invoice_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "city_ledger_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "city_ledger_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "CityLedgerInvoiceKind" NOT NULL,
    "period_from" DATE,
    "period_to" DATE,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "total_kobo" BIGINT NOT NULL,
    "paid_kobo" BIGINT NOT NULL DEFAULT 0,
    "status" "CityLedgerInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT NOT NULL DEFAULT '',
    "issued_by_id" UUID,
    "issued_by_name" TEXT,
    "reminders_sent" INTEGER NOT NULL DEFAULT 0,
    "last_reminder_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "city_ledger_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "city_ledger_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "method" "LedgerPaymentMethod" NOT NULL,
    "reference" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "recorded_by_id" UUID,
    "recorded_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "city_ledger_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "city_ledger_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "city_ledger_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guard_alerts" JSONB NOT NULL DEFAULT '{}',
    "quiet_hours" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "GuardAlertStatus" NOT NULL DEFAULT 'PENDING',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "flag_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipient_user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "deferred_reason" TEXT,
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by_id" UUID,
    "acknowledged_by_name" TEXT,
    "error" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guard_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_inbound" (
    "id" UUID NOT NULL,
    "message_id" TEXT NOT NULL,
    "from_phone" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "tenant_id" UUID,
    "user_id" UUID,
    "command" TEXT,
    "result" TEXT,
    "handled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_inbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_roles_tenant_id_name_key" ON "custom_roles"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "housekeeping_checklists_tenant_id_idx" ON "housekeeping_checklists"("tenant_id");

-- CreateIndex
CREATE INDEX "lost_found_items_tenant_id_status_found_at_idx" ON "lost_found_items"("tenant_id", "status", "found_at" DESC);

-- CreateIndex
CREATE INDEX "maintenance_tickets_tenant_id_status_idx" ON "maintenance_tickets"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "maintenance_tickets_room_id_idx" ON "maintenance_tickets"("room_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_tickets_tenant_id_number_key" ON "maintenance_tickets"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "maintenance_ticket_events_ticket_id_created_at_idx" ON "maintenance_ticket_events"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "room_blocks_tenant_id_starts_at_ends_at_idx" ON "room_blocks"("tenant_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "room_blocks_room_id_idx" ON "room_blocks"("room_id");

-- CreateIndex
CREATE INDEX "maintenance_schedules_tenant_id_active_next_due_at_idx" ON "maintenance_schedules"("tenant_id", "active", "next_due_at");

-- CreateIndex
CREATE INDEX "fuel_logs_tenant_id_date_idx" ON "fuel_logs"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "rate_plans_property_id_idx" ON "rate_plans"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_tenant_id_code_key" ON "rate_plans"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "rate_rules_tenant_id_date_from_date_to_idx" ON "rate_rules"("tenant_id", "date_from", "date_to");

-- CreateIndex
CREATE INDEX "rate_overrides_tenant_id_date_idx" ON "rate_overrides"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "rate_restrictions_tenant_id_date_idx" ON "rate_restrictions"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_tenant_id_code_key" ON "promo_codes"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_reservation_id_key" ON "promo_redemptions"("reservation_id");

-- CreateIndex
CREATE INDEX "promo_redemptions_promo_code_id_status_idx" ON "promo_redemptions"("promo_code_id", "status");

-- CreateIndex
CREATE INDEX "promo_redemptions_tenant_id_guest_phone_idx" ON "promo_redemptions"("tenant_id", "guest_phone");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_accounts_tenant_id_name_key" ON "corporate_accounts"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "city_ledger_charges_account_id_invoice_id_idx" ON "city_ledger_charges"("account_id", "invoice_id");

-- CreateIndex
CREATE INDEX "city_ledger_charges_tenant_id_date_idx" ON "city_ledger_charges"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "city_ledger_invoices_account_id_status_idx" ON "city_ledger_invoices"("account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "city_ledger_invoices_tenant_id_number_key" ON "city_ledger_invoices"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "city_ledger_payments_account_id_received_at_idx" ON "city_ledger_payments"("account_id", "received_at");

-- CreateIndex
CREATE INDEX "city_ledger_allocations_invoice_id_idx" ON "city_ledger_allocations"("invoice_id");

-- CreateIndex
CREATE INDEX "city_ledger_allocations_payment_id_idx" ON "city_ledger_allocations"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_property_id_key" ON "notification_settings"("property_id");

-- CreateIndex
CREATE INDEX "notification_settings_tenant_id_idx" ON "notification_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "guard_alerts_tenant_id_created_at_idx" ON "guard_alerts"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "guard_alerts_status_scheduled_for_idx" ON "guard_alerts"("status", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_inbound_message_id_key" ON "whatsapp_inbound"("message_id");

-- CreateIndex
CREATE INDEX "whatsapp_inbound_from_phone_created_at_idx" ON "whatsapp_inbound"("from_phone", "created_at");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_tenant_id_business_date_idx" ON "housekeeping_tasks"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_assignee_id_idx" ON "housekeeping_tasks"("assignee_id");

-- CreateIndex
CREATE INDEX "users_custom_role_id_idx" ON "users"("custom_role_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_custom_role_id_fkey" FOREIGN KEY ("custom_role_id") REFERENCES "custom_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "rate_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_corporate_account_id_fkey" FOREIGN KEY ("corporate_account_id") REFERENCES "corporate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_checklists" ADD CONSTRAINT "housekeeping_checklists_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_found_items" ADD CONSTRAINT "lost_found_items_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_housekeeping_task_id_fkey" FOREIGN KEY ("housekeeping_task_id") REFERENCES "housekeeping_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_ticket_events" ADD CONSTRAINT "maintenance_ticket_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_ticket_events" ADD CONSTRAINT "maintenance_ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "maintenance_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "maintenance_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_logs" ADD CONSTRAINT "fuel_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_rules" ADD CONSTRAINT "rate_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_overrides" ADD CONSTRAINT "rate_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_overrides" ADD CONSTRAINT "rate_overrides_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "room_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_restrictions" ADD CONSTRAINT "rate_restrictions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_accounts" ADD CONSTRAINT "corporate_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_accounts" ADD CONSTRAINT "corporate_accounts_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "rate_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_charges" ADD CONSTRAINT "city_ledger_charges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_charges" ADD CONSTRAINT "city_ledger_charges_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "corporate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_charges" ADD CONSTRAINT "city_ledger_charges_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_charges" ADD CONSTRAINT "city_ledger_charges_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "city_ledger_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_invoices" ADD CONSTRAINT "city_ledger_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_invoices" ADD CONSTRAINT "city_ledger_invoices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "corporate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_payments" ADD CONSTRAINT "city_ledger_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_payments" ADD CONSTRAINT "city_ledger_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "corporate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_allocations" ADD CONSTRAINT "city_ledger_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_allocations" ADD CONSTRAINT "city_ledger_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "city_ledger_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "city_ledger_allocations" ADD CONSTRAINT "city_ledger_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "city_ledger_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_alerts" ADD CONSTRAINT "guard_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Checks.
-- -----------------------------------------------------------------------------
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_value_positive CHECK (value > 0);
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_code_format CHECK (code ~ '^[A-Z0-9]{3,20}$');
ALTER TABLE corporate_accounts ADD CONSTRAINT corporate_accounts_credit_limit CHECK (credit_limit_kobo >= 0 AND payment_terms_days BETWEEN 0 AND 365);
ALTER TABLE city_ledger_payments ADD CONSTRAINT city_ledger_payments_positive CHECK (amount_kobo > 0);
ALTER TABLE city_ledger_allocations ADD CONSTRAINT city_ledger_allocations_positive CHECK (amount_kobo > 0);
ALTER TABLE room_blocks ADD CONSTRAINT room_blocks_window CHECK (ends_at > starts_at);
ALTER TABLE rate_rules ADD CONSTRAINT rate_rules_dates CHECK (date_to >= date_from);
ALTER TABLE maintenance_schedules ADD CONSTRAINT maintenance_schedules_every CHECK (every_days BETWEEN 1 AND 730);
ALTER TABLE fuel_logs ADD CONSTRAINT fuel_logs_positive CHECK (litres > 0 AND cost_kobo >= 0);
ALTER TABLE users ADD CONSTRAINT users_custom_role_consistent CHECK ((role = 'CUSTOM') = (custom_role_id IS NOT NULL));

-- One BAR plan per hotel; one stayover task per room per day; one restriction row per type (or all types) and date.
CREATE UNIQUE INDEX rate_plans_one_bar ON rate_plans (tenant_id) WHERE is_bar;
CREATE UNIQUE INDEX housekeeping_tasks_one_stayover ON housekeeping_tasks (tenant_id, room_id, business_date) WHERE type = 'STAYOVER';
CREATE UNIQUE INDEX rate_restrictions_unique ON rate_restrictions (tenant_id, COALESCE(room_type_id, '00000000-0000-0000-0000-000000000000'::uuid), date);
CREATE UNIQUE INDEX housekeeping_checklists_unique ON housekeeping_checklists (tenant_id, COALESCE(room_type_id, '00000000-0000-0000-0000-000000000000'::uuid), task_type);
CREATE UNIQUE INDEX custom_roles_name_ci ON custom_roles (tenant_id, lower(name));

-- -----------------------------------------------------------------------------
-- Backfill.
-- -----------------------------------------------------------------------------
-- Tasks: type from the M2 reason, business date from creation.
UPDATE housekeeping_tasks
   SET type = CASE WHEN reason = 'MANUAL' THEN 'CUSTOM'::"HousekeepingTaskType" ELSE 'CHECKOUT_CLEAN'::"HousekeepingTaskType" END,
       business_date = (created_at AT TIME ZONE 'Africa/Lagos')::date,
       started_at = CASE WHEN status IN ('IN_PROGRESS', 'DONE') THEN updated_at ELSE NULL END;

-- Every property gets its Best Available Rate plan (= room type base price).
INSERT INTO rate_plans (id, tenant_id, property_id, code, name, description, kind, is_bar, pricing, channels, sort_order, created_at, updated_at)
SELECT gen_random_uuid(), p.tenant_id, p.id, 'BAR', 'Best Available Rate', 'Flexible rate at the day''s best price.', 'BAR', true, 'DERIVED',
       ARRAY['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'], 0, now(), now()
  FROM properties p
 WHERE NOT EXISTS (SELECT 1 FROM rate_plans rp WHERE rp.tenant_id = p.tenant_id AND rp.is_bar);

-- Existing stays: BAR plan and a per-night snapshot at their single M2 rate.
UPDATE reservations r
   SET rate_plan_id = rp.id
  FROM rate_plans rp
 WHERE rp.tenant_id = r.tenant_id AND rp.is_bar AND r.rate_plan_id IS NULL;

UPDATE reservations r
   SET nightly_rates = COALESCE((
     SELECT jsonb_agg(jsonb_build_object(
              'date', to_char(d, 'YYYY-MM-DD'), 'rateKobo', r.rate_kobo, 'baseRateKobo', r.rate_kobo,
              'source', 'BASE', 'ruleId', NULL, 'ruleName', NULL, 'discountKobo', 0) ORDER BY d)
       FROM generate_series((r.arrival_at AT TIME ZONE 'Africa/Lagos')::date,
                            (r.departure_at AT TIME ZONE 'Africa/Lagos')::date - 1, interval '1 day') AS d
   ), '[]'::jsonb)
 WHERE r.stay_type = 'NIGHTLY' AND r.nightly_rates = '[]'::jsonb;

-- -----------------------------------------------------------------------------
-- RLS: tenant-scoped M4 tables.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'custom_roles', 'housekeeping_checklists', 'lost_found_items',
    'maintenance_tickets', 'maintenance_ticket_events', 'room_blocks', 'maintenance_schedules', 'fuel_logs',
    'rate_plans', 'rate_rules', 'rate_overrides', 'rate_restrictions', 'promo_codes', 'promo_redemptions',
    'corporate_accounts', 'city_ledger_charges', 'city_ledger_invoices', 'city_ledger_payments', 'city_ledger_allocations',
    'notification_settings', 'guard_alerts'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
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

-- Prices are public: marketplace search reads active plans, rules, overrides
-- and restrictions in the signed public context (SELECT only). Promo codes,
-- blocks, corporate accounts and the City Ledger are never public.
CREATE POLICY public_read ON rate_plans FOR SELECT TO hotel_app USING ((SELECT app_is_public()) AND active);
CREATE POLICY public_read ON rate_rules FOR SELECT TO hotel_app USING ((SELECT app_is_public()) AND active);
CREATE POLICY public_read ON rate_overrides FOR SELECT TO hotel_app USING ((SELECT app_is_public()));
CREATE POLICY public_read ON rate_restrictions FOR SELECT TO hotel_app USING ((SELECT app_is_public()));

-- Platform-level inbound WhatsApp log: hotel_platform only.
ALTER TABLE whatsapp_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbound FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_access ON whatsapp_inbound FOR ALL TO hotel_platform USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Marketplace search: rooms that cannot be sold per room type and night,
-- without exposing why (no block reasons, tickets or guests). A room is
-- unsellable on night D when a room block overlaps the night window
-- [D check-in, D+1 check-out) (Lagos), or when it is OUT_OF_ORDER with no
-- block covering now (a manual out-of-order with no end date). Answers only
-- inside the signed public context.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_public_unsellable_rooms(p_property_ids uuid[], p_from date, p_to date)
  RETURNS TABLE (room_type_id uuid, night date, unsellable integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app_is_public() THEN
    RETURN;
  END IF;
  IF p_to <= p_from OR p_to - p_from > 400 THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH nights AS (
    SELECT p.id AS property_id, d::date AS night,
           ((d::date + p.check_in_time::time) AT TIME ZONE 'Africa/Lagos') AS ws,
           ((d::date + 1 + p.check_out_time::time) AT TIME ZONE 'Africa/Lagos') AS we
      FROM properties p, generate_series(p_from, p_to - 1, interval '1 day') AS d
     WHERE p.id = ANY (p_property_ids)
  )
  SELECT rm.room_type_id, n.night, count(*)::integer
    FROM nights n
    JOIN rooms rm ON rm.property_id = n.property_id
   WHERE EXISTS (SELECT 1 FROM room_blocks b
                  WHERE b.room_id = rm.id AND b.starts_at < n.we AND b.ends_at > n.ws)
      OR (rm.status = 'OUT_OF_ORDER'
          AND NOT EXISTS (SELECT 1 FROM room_blocks b
                           WHERE b.room_id = rm.id AND b.starts_at <= now() AND b.ends_at > now()))
   GROUP BY rm.room_type_id, n.night;
END
$$;
REVOKE ALL ON FUNCTION app_public_unsellable_rooms(uuid[], date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_unsellable_rooms(uuid[], date, date) TO hotel_app;

-- -----------------------------------------------------------------------------
-- Grants.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  custom_roles, housekeeping_checklists, lost_found_items,
  maintenance_tickets, room_blocks, maintenance_schedules, fuel_logs,
  rate_plans, rate_rules, rate_overrides, rate_restrictions, promo_codes, promo_redemptions,
  corporate_accounts, city_ledger_charges, city_ledger_invoices, city_ledger_allocations,
  notification_settings, guard_alerts
TO hotel_app;
-- Ticket timelines and City Ledger payments are append-only for the API.
GRANT SELECT, INSERT ON maintenance_ticket_events, city_ledger_payments TO hotel_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  custom_roles, housekeeping_checklists, lost_found_items,
  maintenance_tickets, maintenance_ticket_events, room_blocks, maintenance_schedules, fuel_logs,
  rate_plans, rate_rules, rate_overrides, rate_restrictions, promo_codes, promo_redemptions,
  corporate_accounts, city_ledger_charges, city_ledger_invoices, city_ledger_payments, city_ledger_allocations,
  notification_settings, guard_alerts, whatsapp_inbound
TO hotel_platform;
