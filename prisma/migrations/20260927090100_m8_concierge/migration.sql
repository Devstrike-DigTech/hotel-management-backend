-- M8, part 2: the concierge (lawful guest requests): acceptable use, settings,
-- vendors, services (screened, platform-reviewable), requests and their online payments.

-- CreateEnum
CREATE TYPE "ConciergeCategory" AS ENUM ('WELLNESS', 'DINING', 'ROMANCE_AND_CELEBRATION', 'GROOMING', 'TRANSPORT', 'SECURITY', 'TOURS_AND_EXPERIENCES', 'FAMILY', 'SHOPPING', 'PHOTOGRAPHY', 'EVENTS', 'NIGHTLIFE_RESERVATIONS', 'BUSINESS', 'LAUNDRY_EXPRESS', 'OTHER');

-- CreateEnum
CREATE TYPE "ConciergePricing" AS ENUM ('FIXED', 'FROM', 'PER_HOUR', 'PER_PERSON', 'FREE');

-- CreateEnum
CREATE TYPE "ConciergeLocation" AS ENUM ('IN_ROOM', 'ON_PROPERTY', 'OFF_PROPERTY');

-- CreateEnum
CREATE TYPE "ConciergeReviewStatus" AS ENUM ('LIVE', 'PENDING_REVIEW', 'REJECTED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "ConciergeRequestStatus" AS ENUM ('NEW', 'QUOTED', 'AWAITING_GUEST', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "concierge_accounts" (
    "tenant_id" UUID NOT NULL,
    "aup_version" TEXT,
    "aup_accepted_at" TIMESTAMPTZ(3),
    "aup_accepted_by_id" UUID,
    "aup_accepted_by_name" TEXT,
    "aup_accepted_ip" TEXT,
    "suspended_at" TIMESTAMPTZ(3),
    "suspended_reason" TEXT,
    "suspended_by_name" TEXT,
    "reinstated_at" TIMESTAMPTZ(3),
    "reinstated_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "concierge_accounts_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "concierge_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sla_in_stay_minutes" INTEGER NOT NULL DEFAULT 15,
    "sla_pre_arrival_minutes" INTEGER NOT NULL DEFAULT 120,
    "escalate_after_minutes" INTEGER NOT NULL DEFAULT 0,
    "folio_label_in_room" TEXT NOT NULL DEFAULT 'In-room service',
    "folio_label_other" TEXT NOT NULL DEFAULT 'Guest service',
    "redact_after_days" INTEGER NOT NULL DEFAULT 90,
    "discreet_visibility" TEXT NOT NULL DEFAULT 'MASKED',
    "vendor_share_surname" BOOLEAN NOT NULL DEFAULT false,
    "vendor_share_room" BOOLEAN NOT NULL DEFAULT false,
    "pay_online" BOOLEAN NOT NULL DEFAULT true,
    "pay_folio" BOOLEAN NOT NULL DEFAULT true,
    "free_form_enabled" BOOLEAN NOT NULL DEFAULT true,
    "quote_validity_hours" INTEGER NOT NULL DEFAULT 24,
    "intro" TEXT,
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "concierge_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concierge_vendors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ConciergeCategory" NOT NULL DEFAULT 'OTHER',
    "contact_name" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "commission_type" TEXT NOT NULL DEFAULT 'NONE',
    "commission_value" INTEGER NOT NULL DEFAULT 0,
    "payout_notes" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "concierge_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concierge_services" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" "ConciergeCategory" NOT NULL DEFAULT 'OTHER',
    "image_url" TEXT,
    "pricing" "ConciergePricing" NOT NULL DEFAULT 'FROM',
    "price_kobo" INTEGER,
    "variants" JSONB NOT NULL DEFAULT '[]',
    "duration_minutes" INTEGER,
    "lead_time_hours" INTEGER NOT NULL DEFAULT 0,
    "availability" JSONB,
    "requires_slot" BOOLEAN NOT NULL DEFAULT false,
    "slot_capacity" INTEGER,
    "location" "ConciergeLocation" NOT NULL DEFAULT 'ON_PROPERTY',
    "fulfilled_by" TEXT NOT NULL DEFAULT 'STAFF',
    "vendor_id" UUID,
    "discreet_eligible" BOOLEAN NOT NULL DEFAULT false,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "channels" TEXT[] DEFAULT ARRAY['BOOKING_FLOW', 'TRIP_PAGE', 'FRONT_DESK']::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "review_status" "ConciergeReviewStatus" NOT NULL DEFAULT 'LIVE',
    "flagged_terms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flag_matches" JSONB NOT NULL DEFAULT '[]',
    "review_reason" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "concierge_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concierge_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "reservation_id" UUID,
    "guest_id" UUID NOT NULL,
    "service_id" UUID,
    "service_name" TEXT NOT NULL,
    "category" "ConciergeCategory" NOT NULL DEFAULT 'OTHER',
    "pricing" "ConciergePricing",
    "location" "ConciergeLocation",
    "variant_id" TEXT,
    "variant_name" TEXT,
    "hours" INTEGER,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "request_text" TEXT,
    "preferred_start" TIMESTAMPTZ(3),
    "preferred_end" TIMESTAMPTZ(3),
    "party_size" INTEGER,
    "notes" TEXT,
    "internal_notes" TEXT,
    "discreet" BOOLEAN NOT NULL DEFAULT false,
    "contact_preference" TEXT NOT NULL DEFAULT 'SMS',
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "status" "ConciergeRequestStatus" NOT NULL DEFAULT 'NEW',
    "source" TEXT NOT NULL DEFAULT 'TRIP_PAGE',
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flag_terms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flag_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flag_status" TEXT,
    "flag_note" TEXT,
    "flag_reviewed_by_id" UUID,
    "flag_reviewed_by_name" TEXT,
    "flag_reviewed_at" TIMESTAMPTZ(3),
    "price_amount_kobo" INTEGER,
    "price_net_kobo" INTEGER,
    "price_tax_kobo" INTEGER,
    "price_taxes" JSONB,
    "price_description" TEXT,
    "tax_components" JSONB NOT NULL DEFAULT '[]',
    "quote_version" INTEGER NOT NULL DEFAULT 0,
    "quote_amount_kobo" INTEGER,
    "quote_net_kobo" INTEGER,
    "quote_tax_kobo" INTEGER,
    "quote_taxes" JSONB,
    "quote_valid_until" TIMESTAMPTZ(3),
    "quote_note" TEXT,
    "quote_sent_at" TIMESTAMPTZ(3),
    "quote_sent_by_id" UUID,
    "quote_sent_by_name" TEXT,
    "quote_channel" TEXT,
    "quote_answer" TEXT,
    "quote_answered_at" TIMESTAMPTZ(3),
    "quote_answered_via" TEXT,
    "payment_method" TEXT,
    "payment_status" TEXT NOT NULL DEFAULT 'NONE',
    "payment_reference" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "folio_id" UUID,
    "folio_entry_id" UUID,
    "posted_at" TIMESTAMPTZ(3),
    "folio_description" TEXT,
    "assignee_id" UUID,
    "assignee_name" TEXT,
    "vendor_id" UUID,
    "vendor_name" TEXT,
    "vendor_sent_at" TIMESTAMPTZ(3),
    "vendor_sent_via" TEXT,
    "commission_type" TEXT,
    "commission_value" INTEGER,
    "commission_kobo" INTEGER,
    "vendor_payable_kobo" INTEGER,
    "vendor_settled_at" TIMESTAMPTZ(3),
    "vendor_settlement_ref" TEXT,
    "sla_target" TEXT NOT NULL DEFAULT 'PRE_ARRIVAL',
    "sla_due_at" TIMESTAMPTZ(3) NOT NULL,
    "first_response_at" TIMESTAMPTZ(3),
    "escalated_at" TIMESTAMPTZ(3),
    "scheduled_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "decline_reason" TEXT,
    "cancel_reason" TEXT,
    "rating" INTEGER,
    "rating_comment" TEXT,
    "rated_at" TIMESTAMPTZ(3),
    "vendor_rating" INTEGER,
    "timeline" JSONB NOT NULL DEFAULT '[]',
    "redacted_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "client_created_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "concierge_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concierge_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "amount_kobo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIALIZED',
    "email" TEXT NOT NULL,
    "quote_version" INTEGER NOT NULL DEFAULT 0,
    "authorization_url" TEXT,
    "access_code" TEXT,
    "subaccount_code" TEXT,
    "channel" TEXT,
    "provider_transaction_id" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "last_verified_at" TIMESTAMPTZ(3),
    "refunded_at" TIMESTAMPTZ(3),
    "refund_reference" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "concierge_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "concierge_settings_property_id_key" ON "concierge_settings"("property_id");

-- CreateIndex
CREATE INDEX "concierge_settings_tenant_id_idx" ON "concierge_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "concierge_vendors_tenant_id_idx" ON "concierge_vendors"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "concierge_vendors_property_id_name_key" ON "concierge_vendors"("property_id", "name");

-- CreateIndex
CREATE INDEX "concierge_services_tenant_id_idx" ON "concierge_services"("tenant_id");

-- CreateIndex
CREATE INDEX "concierge_services_review_status_idx" ON "concierge_services"("review_status");

-- CreateIndex
CREATE UNIQUE INDEX "concierge_services_property_id_name_key" ON "concierge_services"("property_id", "name");

-- CreateIndex
CREATE INDEX "concierge_requests_tenant_id_idx" ON "concierge_requests"("tenant_id");

-- CreateIndex
CREATE INDEX "concierge_requests_property_id_status_idx" ON "concierge_requests"("property_id", "status");

-- CreateIndex
CREATE INDEX "concierge_requests_property_id_created_at_idx" ON "concierge_requests"("property_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "concierge_requests_guest_id_idx" ON "concierge_requests"("guest_id");

-- CreateIndex
CREATE INDEX "concierge_requests_reservation_id_idx" ON "concierge_requests"("reservation_id");

-- CreateIndex
CREATE INDEX "concierge_requests_status_sla_due_at_idx" ON "concierge_requests"("status", "sla_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "concierge_requests_property_id_seq_key" ON "concierge_requests"("property_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "concierge_requests_property_id_number_key" ON "concierge_requests"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "concierge_payments_reference_key" ON "concierge_payments"("reference");

-- CreateIndex
CREATE INDEX "concierge_payments_tenant_id_idx" ON "concierge_payments"("tenant_id");

-- CreateIndex
CREATE INDEX "concierge_payments_request_id_idx" ON "concierge_payments"("request_id");

-- AddForeignKey
ALTER TABLE "concierge_accounts" ADD CONSTRAINT "concierge_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_settings" ADD CONSTRAINT "concierge_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_settings" ADD CONSTRAINT "concierge_settings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_vendors" ADD CONSTRAINT "concierge_vendors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_vendors" ADD CONSTRAINT "concierge_vendors_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_services" ADD CONSTRAINT "concierge_services_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_services" ADD CONSTRAINT "concierge_services_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_services" ADD CONSTRAINT "concierge_services_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "concierge_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "concierge_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "concierge_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_payments" ADD CONSTRAINT "concierge_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_payments" ADD CONSTRAINT "concierge_payments_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierge_payments" ADD CONSTRAINT "concierge_payments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "concierge_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Integrity rules Prisma cannot express.
-- -----------------------------------------------------------------------------
ALTER TABLE "concierge_settings" ADD CONSTRAINT "concierge_settings_visibility_check" CHECK ("discreet_visibility" IN ('MASKED', 'HIDDEN'));
ALTER TABLE "concierge_settings" ADD CONSTRAINT "concierge_settings_ranges_check" CHECK (
  "sla_in_stay_minutes" BETWEEN 5 AND 240 AND "sla_pre_arrival_minutes" BETWEEN 15 AND 2880 AND "escalate_after_minutes" BETWEEN 0 AND 240
  AND "redact_after_days" BETWEEN 7 AND 3650 AND "quote_validity_hours" BETWEEN 1 AND 168);
ALTER TABLE "concierge_vendors" ADD CONSTRAINT "concierge_vendors_commission_check" CHECK (
  ("commission_type" = 'NONE' AND "commission_value" = 0)
  OR ("commission_type" = 'PERCENT' AND "commission_value" BETWEEN 1 AND 10000)
  OR ("commission_type" = 'FIXED' AND "commission_value" > 0));
ALTER TABLE "concierge_services" ADD CONSTRAINT "concierge_services_fulfilled_by_check" CHECK ("fulfilled_by" IN ('STAFF', 'VENDOR'));
ALTER TABLE "concierge_services" ADD CONSTRAINT "concierge_services_price_check" CHECK ("price_kobo" IS NULL OR "price_kobo" >= 0);
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_contact_check" CHECK ("contact_preference" IN ('WHATSAPP', 'SMS', 'EMAIL', 'IN_APP'));
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_source_check" CHECK ("source" IN ('BOOKING_FLOW', 'TRIP_PAGE', 'WHATSAPP', 'FRONT_DESK'));
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_payment_check" CHECK (
  ("payment_method" IS NULL OR "payment_method" IN ('ONLINE', 'FOLIO', 'NONE'))
  AND "payment_status" IN ('NONE', 'PENDING', 'PAID', 'POSTED', 'REFUNDED'));
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_flag_check" CHECK ("flag_status" IS NULL OR "flag_status" IN ('PENDING', 'CLEARED', 'DECLINED'));
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_sla_check" CHECK ("sla_target" IN ('IN_STAY', 'PRE_ARRIVAL'));
ALTER TABLE "concierge_requests" ADD CONSTRAINT "concierge_requests_rating_check" CHECK (
  ("rating" IS NULL OR "rating" BETWEEN 1 AND 5) AND ("vendor_rating" IS NULL OR "vendor_rating" BETWEEN 1 AND 5));
ALTER TABLE "concierge_payments" ADD CONSTRAINT "concierge_payments_status_check" CHECK ("status" IN ('INITIALIZED', 'SUCCEEDED', 'FAILED', 'REFUNDED'));
-- Open requests by SLA (the escalation job).
CREATE INDEX "concierge_requests_open_sla_idx" ON "concierge_requests" ("sla_due_at") WHERE "first_response_at" IS NULL AND "escalated_at" IS NULL;

-- -----------------------------------------------------------------------------
-- RLS on the new tenant tables (data plane: they move with a dedicated database).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'concierge_accounts', 'concierge_settings', 'concierge_vendors', 'concierge_services', 'concierge_requests', 'concierge_payments'
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

-- -----------------------------------------------------------------------------
-- Grants. Payments are never deleted by the API.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  concierge_accounts, concierge_settings, concierge_vendors, concierge_services, concierge_requests
TO hotel_app;
GRANT SELECT, INSERT, UPDATE ON concierge_payments TO hotel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  concierge_accounts, concierge_settings, concierge_vendors, concierge_services, concierge_requests, concierge_payments
TO hotel_platform;

-- -----------------------------------------------------------------------------
-- Data: feature codes (the seed keeps names and descriptions up to date).
-- -----------------------------------------------------------------------------
INSERT INTO features (code, name, description, category) VALUES
  ('concierge', 'Guest concierge', 'Guests ask for lawful services (spa, chef, car hire, tours, celebrations) and the team quotes, arranges and bills them, privately when asked.', 'Guests'),
  ('concierge_vendors', 'Concierge vendors and commission', 'Track the commission you earn from outside providers such as spas, chefs and car hire firms.', 'Revenue')
ON CONFLICT (code) DO NOTHING;

INSERT INTO plan_features (plan_id, feature_code)
SELECT p.id, f.code
FROM plans p
JOIN (VALUES
  ('growth', 'concierge'),
  ('pro', 'concierge'), ('pro', 'concierge_vendors'),
  ('enterprise', 'concierge'), ('enterprise', 'concierge_vendors')
) AS f(plan_code, code) ON f.plan_code = p.code
WHERE EXISTS (SELECT 1 FROM features WHERE features.code = f.code)
ON CONFLICT DO NOTHING;
