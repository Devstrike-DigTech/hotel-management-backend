-- =============================================================================
-- M3: online booking, Paystack split payments, commission ledger, payouts,
-- guest accounts, reviews and notifications.
--
-- Tenant-scoped tables get the same signed-context RLS as M2. Guest identity
-- tables are platform-level: RLS on with a hotel_platform policy only and no
-- grants to hotel_app at all.
-- =============================================================================

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('ONLINE', 'PAY_AT_HOTEL');

-- CreateEnum
CREATE TYPE "GuaranteeType" AS ENUM ('NONE', 'PREPAID');

-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('GUEST', 'HOTEL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "BookingPaymentStatus" AS ENUM ('INITIALIZED', 'SUCCEEDED', 'FAILED', 'ORPHANED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrphanReason" AS ENUM ('LATE_NO_INVENTORY', 'AMOUNT_MISMATCH', 'BOOKING_CANCELLED', 'DUPLICATE_PAYMENT');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('GUEST_CANCELLED', 'HOTEL_CANCELLED', 'PAYMENT_ORPHANED');

-- CreateEnum
CREATE TYPE "CommissionKind" AS ENUM ('ACCRUED', 'COLLECTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN', 'FLAGGED');

-- CreateEnum
CREATE TYPE "TravellerType" AS ENUM ('BUSINESS', 'COUPLE', 'FAMILY', 'SOLO', 'FRIENDS');

-- CreateEnum
CREATE TYPE "ModerationReason" AS ENUM ('ABUSE', 'PII', 'SPAM', 'OFF_TOPIC', 'OTHER');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'OUTBOX');

-- CreateEnum
CREATE TYPE "NotificationAudience" AS ENUM ('GUEST', 'HOTEL', 'PLATFORM');

-- CreateEnum
CREATE TYPE "GuestChallengeKind" AS ENUM ('OTP', 'MAGIC_LINK');

-- AlterEnum
ALTER TYPE "GuardRule" ADD VALUE 'PAYMENT_ORPHANED';

-- AlterTable
ALTER TABLE "guests" ADD COLUMN     "guest_account_id" UUID;

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "allow_pay_at_hotel" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "free_cancellation_hours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "late_cancellation_fee_pct" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "no_show_fee_pct" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "online_booking_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "payout_ready" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pre_arrival_message" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "rating_cleanliness" DOUBLE PRECISION,
ADD COLUMN     "rating_distribution" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "rating_location" DOUBLE PRECISION,
ADD COLUMN     "rating_service" DOUBLE PRECISION,
ADD COLUMN     "rating_value" DOUBLE PRECISION,
ADD COLUMN     "require_card_for_pay_at_hotel" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "cancellation_fee_kobo" BIGINT,
ADD COLUMN     "cancelled_by" "CancelledBy",
ADD COLUMN     "commission_bps" INTEGER,
ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "guarantee_type" "GuaranteeType",
ADD COLUMN     "guest_account_id" UUID,
ADD COLUMN     "hold_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "payment_mode" "PaymentMode",
ADD COLUMN     "quote" JSONB,
ADD COLUMN     "quote_ref" TEXT,
ADD COLUMN     "quoted_total_kobo" BIGINT,
ADD COLUMN     "special_requests" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "booking_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paystack',
    "status" "BookingPaymentStatus" NOT NULL DEFAULT 'INITIALIZED',
    "amount_kobo" BIGINT NOT NULL,
    "commission_kobo" BIGINT NOT NULL,
    "commission_bps" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "subaccount_code" TEXT,
    "authorization_url" TEXT,
    "access_code" TEXT,
    "callback_url" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "paid_amount_kobo" BIGINT,
    "paid_at" TIMESTAMPTZ(3),
    "channel" TEXT,
    "provider_transaction_id" TEXT,
    "orphan_reason" "OrphanReason",
    "folio_entry_id" UUID,
    "last_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_refunds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "amount_kobo" BIGINT NOT NULL,
    "reason" "RefundReason" NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "provider_refund_id" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_by" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "payment_id" UUID,
    "kind" "CommissionKind" NOT NULL,
    "accrual" BOOLEAN NOT NULL DEFAULT false,
    "amount_kobo" BIGINT NOT NULL,
    "base_kobo" BIGINT NOT NULL,
    "commission_bps" INTEGER NOT NULL,
    "channel" "ReservationSource" NOT NULL,
    "note" TEXT,
    "settled_at" TIMESTAMPTZ(3),
    "settlement_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "bank_code" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_number_enc" TEXT NOT NULL,
    "account_number_last4" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "subaccount_code" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paystack',
    "settlement_verified" BOOLEAN NOT NULL DEFAULT false,
    "percentage_charge" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "guest_account_id" UUID,
    "overall" INTEGER NOT NULL,
    "cleanliness" INTEGER NOT NULL,
    "service" INTEGER NOT NULL,
    "location" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "stay_month" TEXT NOT NULL,
    "traveller_type" "TravellerType" NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
    "hotel_reply" TEXT,
    "hotel_replied_at" TIMESTAMPTZ(3),
    "hotel_replied_by_id" UUID,
    "flagged_reason" TEXT,
    "flagged_at" TIMESTAMPTZ(3),
    "hidden_reason" "ModerationReason",
    "moderation_note" TEXT,
    "moderated_at" TIMESTAMPTZ(3),
    "moderated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "reservation_id" UUID,
    "guest_account_id" UUID,
    "template" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "audience" "NotificationAudience" NOT NULL DEFAULT 'GUEST',
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "dedupe_key" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_accounts" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "full_name" TEXT NOT NULL DEFAULT '',
    "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guest_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_otp_challenges" (
    "id" UUID NOT NULL,
    "kind" "GuestChallengeKind" NOT NULL DEFAULT 'OTP',
    "phone" TEXT,
    "email" TEXT,
    "channel" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_refresh_tokens" (
    "id" UUID NOT NULL,
    "guest_account_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_payments_reference_key" ON "booking_payments"("reference");

-- CreateIndex
CREATE INDEX "booking_payments_tenant_id_created_at_idx" ON "booking_payments"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "booking_payments_reservation_id_idx" ON "booking_payments"("reservation_id");

-- CreateIndex
CREATE INDEX "booking_payments_status_idx" ON "booking_payments"("status");

-- CreateIndex
CREATE INDEX "booking_refunds_tenant_id_created_at_idx" ON "booking_refunds"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "booking_refunds_payment_id_idx" ON "booking_refunds"("payment_id");

-- CreateIndex
CREATE INDEX "booking_refunds_status_idx" ON "booking_refunds"("status");

-- CreateIndex
CREATE INDEX "commission_entries_tenant_id_created_at_idx" ON "commission_entries"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "commission_entries_reservation_id_idx" ON "commission_entries"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_accounts_tenant_id_key" ON "payout_accounts"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_reservation_id_key" ON "reviews"("reservation_id");

-- CreateIndex
CREATE INDEX "reviews_property_id_status_created_at_idx" ON "reviews"("property_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reviews_tenant_id_created_at_idx" ON "reviews"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "reviews_status_idx" ON "reviews"("status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_dedupe_key_key" ON "notification_logs"("dedupe_key");

-- CreateIndex
CREATE INDEX "notification_logs_tenant_id_created_at_idx" ON "notification_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_logs_reservation_id_idx" ON "notification_logs"("reservation_id");

-- CreateIndex
CREATE INDEX "notification_logs_status_idx" ON "notification_logs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "guest_accounts_phone_key" ON "guest_accounts"("phone");

-- CreateIndex
CREATE INDEX "guest_accounts_email_idx" ON "guest_accounts"("email");

-- CreateIndex
CREATE INDEX "guest_otp_challenges_phone_created_at_idx" ON "guest_otp_challenges"("phone", "created_at");

-- CreateIndex
CREATE INDEX "guest_otp_challenges_email_created_at_idx" ON "guest_otp_challenges"("email", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "guest_refresh_tokens_token_hash_key" ON "guest_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "guest_refresh_tokens_guest_account_id_idx" ON "guest_refresh_tokens"("guest_account_id");

-- CreateIndex
CREATE INDEX "guest_refresh_tokens_family_id_idx" ON "guest_refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "guests_guest_account_id_idx" ON "guests"("guest_account_id");

-- CreateIndex
CREATE INDEX "reservations_guest_account_id_idx" ON "reservations"("guest_account_id");

-- CreateIndex
CREATE INDEX "reservations_status_hold_expires_at_idx" ON "reservations"("status", "hold_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenant_id_quote_ref_key" ON "reservations"("tenant_id", "quote_ref");

-- AddForeignKey
ALTER TABLE "booking_payments" ADD CONSTRAINT "booking_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_payments" ADD CONSTRAINT "booking_payments_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_refunds" ADD CONSTRAINT "booking_refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_refunds" ADD CONSTRAINT "booking_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "booking_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_refunds" ADD CONSTRAINT "booking_refunds_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "booking_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_refresh_tokens" ADD CONSTRAINT "guest_refresh_tokens_guest_account_id_fkey" FOREIGN KEY ("guest_account_id") REFERENCES "guest_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- Integrity checks Prisma cannot express.
-- -----------------------------------------------------------------------------
ALTER TABLE reviews ADD CONSTRAINT reviews_scores_range CHECK (
  overall BETWEEN 1 AND 5 AND cleanliness BETWEEN 1 AND 5 AND service BETWEEN 1 AND 5
  AND location BETWEEN 1 AND 5 AND value BETWEEN 1 AND 5);
ALTER TABLE reviews ADD CONSTRAINT reviews_body_length CHECK (char_length(body) BETWEEN 20 AND 2000);
ALTER TABLE commission_entries ADD CONSTRAINT commission_entries_amount_positive CHECK (amount_kobo >= 0);
ALTER TABLE booking_refunds ADD CONSTRAINT booking_refunds_amount_positive CHECK (amount_kobo > 0);
ALTER TABLE properties ADD CONSTRAINT properties_cancellation_policy_range CHECK (
  free_cancellation_hours BETWEEN 0 AND 720 AND late_cancellation_fee_pct BETWEEN 0 AND 100
  AND no_show_fee_pct BETWEEN 0 AND 100);

-- -----------------------------------------------------------------------------
-- RLS: tenant-scoped M3 tables.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'booking_payments', 'booking_refunds', 'commission_entries', 'payout_accounts',
    'reviews', 'notification_logs'
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

-- Published reviews are public (marketplace hotel pages), SELECT only.
CREATE POLICY public_read ON reviews FOR SELECT TO hotel_app
  USING ((SELECT app_is_public()) AND status IN ('PUBLISHED', 'FLAGGED'));

-- Tax components are shown to guests with every quote.
CREATE POLICY public_read ON tax_settings FOR SELECT TO hotel_app
  USING ((SELECT app_is_public()));

-- -----------------------------------------------------------------------------
-- RLS: platform-level guest identity. hotel_app gets no grants and no policy.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guest_accounts', 'guest_otp_challenges', 'guest_refresh_tokens']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY platform_access ON %I FOR ALL TO hotel_platform USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Marketplace availability without exposing bookings.
--
-- Returns, per room type of the given properties, the peak number of active
-- stays (PENDING, CONFIRMED, CHECKED_IN) overlapping [p_start, p_end), the
-- same measure as AvailabilityService.assertAvailable (peak concurrency; ends
-- sort before starts at the same instant because ranges are '[)').
-- SECURITY DEFINER so it can count reservations, but it only answers inside
-- the signed public context and returns counts only: no guest, code or date.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_public_room_type_peaks(p_property_ids uuid[], p_start timestamptz, p_end timestamptz)
  RETURNS TABLE (room_type_id uuid, peak integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app_is_public() THEN
    RETURN;
  END IF;
  IF p_end <= p_start OR p_end - p_start > interval '400 days' THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH stays AS (
    SELECT r.room_type_id AS rt,
           greatest(r.arrival_at, p_start) AS s,
           least(r.departure_at, p_end)    AS e
      FROM reservations r
     WHERE r.property_id = ANY (p_property_ids)
       AND r.status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
       AND r.arrival_at < p_end
       AND r.departure_at > p_start
  ), events AS (
    SELECT rt, s AS at, 1 AS delta FROM stays WHERE s < e
    UNION ALL
    SELECT rt, e AS at, -1 AS delta FROM stays WHERE s < e
  ), running AS (
    SELECT rt, sum(delta) OVER (PARTITION BY rt ORDER BY at, delta ROWS UNBOUNDED PRECEDING) AS cur
      FROM events
  )
  SELECT rt, max(cur)::integer FROM running GROUP BY rt;
END
$$;
REVOKE ALL ON FUNCTION app_public_room_type_peaks(uuid[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_room_type_peaks(uuid[], timestamptz, timestamptz) TO hotel_app;

-- -----------------------------------------------------------------------------
-- Grants.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON booking_payments, booking_refunds, notification_logs, reviews TO hotel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON payout_accounts TO hotel_app;
-- The commission ledger is append-only for the API (settlement is a platform action).
GRANT SELECT, INSERT ON commission_entries TO hotel_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  booking_payments, booking_refunds, commission_entries, payout_accounts, reviews,
  notification_logs, guest_accounts, guest_otp_challenges, guest_refresh_tokens
TO hotel_platform;
