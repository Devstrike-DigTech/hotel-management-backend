-- M5, part 3: POS, stock and minibar; channel manager; dynamic pricing; guest
-- inbox; loyalty; custom domains. Every table is tenant-scoped with RLS.

-- CreateEnum
CREATE TYPE "OutletType" AS ENUM ('RESTAURANT', 'BAR', 'POOL_BAR', 'ROOM_SERVICE', 'MINIBAR', 'LAUNDRY', 'SPA', 'OTHER');

-- CreateEnum
CREATE TYPE "KdsStation" AS ENUM ('KITCHEN', 'BAR', 'NONE');

-- CreateEnum
CREATE TYPE "PosOrderStatus" AS ENUM ('OPEN', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PosLineStatus" AS ENUM ('PENDING', 'SENT', 'VOIDED');

-- CreateEnum
CREATE TYPE "KdsTicketStatus" AS ENUM ('NEW', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PosSettlement" AS ENUM ('PAYMENT', 'ROOM_CHARGE', 'CITY_LEDGER', 'COMPLIMENTARY');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE', 'SALE', 'VOID_RETURN', 'WASTE', 'ADJUSTMENT', 'COUNT', 'MINIBAR');

-- CreateEnum
CREATE TYPE "ChannelProviderKind" AS ENUM ('ICAL', 'CHANNEX');

-- CreateEnum
CREATE TYPE "OtaChannel" AS ENUM ('AIRBNB', 'BOOKING_COM', 'EXPEDIA', 'AGODA', 'VRBO', 'HOTELS_NG', 'OTHER');

-- CreateEnum
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('PUSH', 'PULL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('ARI', 'BOOKING', 'ICAL_IMPORT', 'CONNECT', 'MAPPING');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('OK', 'ERROR', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ChannelBookingStatus" AS ENUM ('NEW', 'MODIFIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PricingMode" AS ENUM ('OFF', 'SUGGEST', 'AUTOPILOT');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'APPLIED', 'SUPERSEDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PriceChangeSource" AS ENUM ('ACCEPTED', 'AUTOPILOT', 'REVERT');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'NOTE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TaskSuggestionStatus" AS ENUM ('PENDING', 'CREATED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "LoyaltyTxnType" AS ENUM ('EARN', 'REDEEM', 'EXPIRE', 'ADJUST', 'REVERSAL');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- AlterTable

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "expected_arrival_time" TEXT,
ADD COLUMN     "loyalty_points" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ota_channel" "OtaChannel",
ADD COLUMN     "ota_commission_kobo" BIGINT,
ADD COLUMN     "ota_ref" TEXT,
ADD COLUMN     "overbooked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "pos_outlets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "OutletType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "default_station" "KdsStation" NOT NULL DEFAULT 'KITCHEN',
    "service_charge_applies" BOOLEAN NOT NULL DEFAULT false,
    "allow_room_charge" BOOLEAN NOT NULL DEFAULT true,
    "allow_city_ledger" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_outlets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "station" "KdsStation",
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price_kobo" INTEGER NOT NULL,
    "outlet_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "available" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "vat" BOOLEAN NOT NULL DEFAULT true,
    "consumption_tax" BOOLEAN NOT NULL DEFAULT true,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "station" "KdsStation",
    "stock_links" JSONB NOT NULL DEFAULT '[]',
    "image_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_price_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "outlet_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "category_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "item_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "days_of_week" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "adjustment_type" "AdjustmentType" NOT NULL,
    "value" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "PosOrderStatus" NOT NULL DEFAULT 'OPEN',
    "table_label" TEXT,
    "room_id" UUID,
    "reservation_id" UUID,
    "guest_name" TEXT,
    "covers" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT NOT NULL DEFAULT '',
    "discount_mode" TEXT,
    "discount_value" INTEGER,
    "discount_kobo" BIGINT NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    "discount_approved_by" UUID,
    "settlement" "PosSettlement",
    "payments" JSONB NOT NULL DEFAULT '[]',
    "tip_kobo" BIGINT NOT NULL DEFAULT 0,
    "folio_id" UUID,
    "corporate_account_id" UUID,
    "signature" TEXT,
    "totals" JSONB,
    "net_kobo" BIGINT NOT NULL DEFAULT 0,
    "total_kobo" BIGINT NOT NULL DEFAULT 0,
    "tax_kobo" BIGINT NOT NULL DEFAULT 0,
    "opened_by_id" UUID,
    "opened_by_name" TEXT,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),
    "settled_by_id" UUID,
    "settled_by_name" TEXT,
    "shift_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "split_from_order_id" UUID,
    "client_created_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_order_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_kobo" INTEGER NOT NULL,
    "base_price_kobo" INTEGER NOT NULL,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    "station" "KdsStation" NOT NULL,
    "vat" BOOLEAN NOT NULL DEFAULT true,
    "consumption" BOOLEAN NOT NULL DEFAULT true,
    "status" "PosLineStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMPTZ(3),
    "ticket_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "voided_by_id" UUID,
    "voided_by_name" TEXT,
    "approved_by_id" UUID,
    "added_by_id" UUID,
    "added_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "station" "KdsStation" NOT NULL,
    "status" "KdsTicketStatus" NOT NULL DEFAULT 'NEW',
    "server_id" UUID,
    "server_name" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "served_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pos_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "sku" TEXT,
    "on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reorder_level" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "par_level" DECIMAL(12,3),
    "unit_cost_kobo" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_cost_kobo" INTEGER,
    "reference" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "order_id" UUID,
    "count_id" UUID,
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "lines" JSONB NOT NULL DEFAULT '[]',
    "variance_value_kobo" BIGINT NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "counted_by_id" UUID,
    "counted_by_name" TEXT,
    "counted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "minibar_pars" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "par_qty" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "minibar_pars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "provider" "ChannelProviderKind" NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "OtaChannel",
    "status" "ChannelConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "external_property_id" TEXT,
    "api_key_enc" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "ical_version" INTEGER NOT NULL DEFAULT 1,
    "ari_state" JSONB NOT NULL DEFAULT '{}',
    "ari_dirty_since" TIMESTAMPTZ(3),
    "ari_dirty_from" DATE,
    "ari_dirty_to" DATE,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ical_feeds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "room_id" UUID,
    "room_type_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "last_fetched_at" TIMESTAMPTZ(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "events_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ical_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "rate_plan_id" UUID,
    "external_room_type_id" TEXT NOT NULL,
    "external_room_type_name" TEXT,
    "external_rate_plan_id" TEXT,
    "external_rate_plan_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_sync_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "summary" TEXT NOT NULL,
    "items" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "payload" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "channel_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_bookings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "ChannelProviderKind" NOT NULL,
    "channel" "OtaChannel" NOT NULL,
    "external_id" TEXT NOT NULL,
    "revision_id" TEXT,
    "status" "ChannelBookingStatus" NOT NULL DEFAULT 'NEW',
    "reservation_id" UUID,
    "gross_kobo" BIGINT,
    "commission_kobo" BIGINT,
    "commission_bps" INTEGER,
    "overbooked" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channel_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "mode" "PricingMode" NOT NULL DEFAULT 'OFF',
    "horizon_days" INTEGER NOT NULL DEFAULT 90,
    "min_change_bps" INTEGER NOT NULL DEFAULT 300,
    "pace_spike_enabled" BOOLEAN NOT NULL DEFAULT true,
    "pace_spike_rooms" INTEGER NOT NULL DEFAULT 3,
    "last_run_at" TIMESTAMPTZ(3),
    "last_spike_run_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pricing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_guardrails" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "floor_kobo" INTEGER NOT NULL,
    "ceiling_kobo" INTEGER NOT NULL,
    "max_daily_change_bps" INTEGER NOT NULL DEFAULT 1500,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pricing_guardrails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_frozen_dates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "room_type_id" UUID,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_frozen_dates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
    "national_key" TEXT,
    "name" TEXT NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "impact" TEXT NOT NULL DEFAULT 'MEDIUM',
    "uplift_bps" INTEGER NOT NULL,
    "city" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pricing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_rates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "competitor_name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "rate_kobo" INTEGER NOT NULL,
    "room_type_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_suggestions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "current_kobo" INTEGER NOT NULL,
    "suggested_kobo" INTEGER NOT NULL,
    "change_bps" INTEGER NOT NULL,
    "factors" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "occupancy" JSONB NOT NULL DEFAULT '{}',
    "confidence" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "decided_by_name" TEXT,

    CONSTRAINT "price_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "from_kobo" INTEGER NOT NULL,
    "to_kobo" INTEGER NOT NULL,
    "previous_kobo" INTEGER,
    "source" "PriceChangeSource" NOT NULL,
    "reason" TEXT NOT NULL,
    "suggestion_id" UUID,
    "by_id" UUID,
    "by_name" TEXT,
    "reverted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "guest_id" UUID,
    "guest_phone" TEXT NOT NULL,
    "guest_name" TEXT NOT NULL,
    "reservation_id" UUID,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assignee_id" UUID,
    "assignee_name" TEXT,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_outbound_at" TIMESTAMPTZ(3),
    "last_preview" TEXT NOT NULL DEFAULT '',
    "last_direction" "MessageDirection",
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "sla_due_at" TIMESTAMPTZ(3),
    "flow_state" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "template_name" TEXT,
    "template_params" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "provider_message_id" TEXT,
    "sent_by_id" UUID,
    "sent_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quick_replies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quick_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_suggestions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "category" "MaintenanceCategory",
    "room_id" UUID,
    "status" "TaskSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "housekeeping_task_id" UUID,
    "ticket_id" UUID,
    "decided_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "wifi_name" TEXT NOT NULL DEFAULT '',
    "wifi_password" TEXT NOT NULL DEFAULT '',
    "directions" TEXT NOT NULL DEFAULT '',
    "pre_arrival_confirm" BOOLEAN NOT NULL DEFAULT true,
    "in_stay_prompt" BOOLEAN NOT NULL DEFAULT true,
    "keyword_suggestions" BOOLEAN NOT NULL DEFAULT true,
    "sla_minutes" INTEGER NOT NULL DEFAULT 15,
    "phone_number_id" TEXT,
    "whatsapp_phone" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbox_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_programmes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT NOT NULL,
    "earn_points_per_1000" INTEGER NOT NULL DEFAULT 10,
    "point_value_kobo" INTEGER NOT NULL DEFAULT 100,
    "min_redeem_points" INTEGER NOT NULL DEFAULT 1000,
    "max_redeem_bps" INTEGER NOT NULL DEFAULT 5000,
    "expiry_months" INTEGER NOT NULL DEFAULT 24,
    "adjustment_flag_points" INTEGER NOT NULL DEFAULT 5000,
    "enrol_online" BOOLEAN NOT NULL DEFAULT true,
    "member_no_prefix" TEXT NOT NULL DEFAULT 'MBR',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_tiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_nights" INTEGER NOT NULL DEFAULT 0,
    "bonus_bps" INTEGER NOT NULL DEFAULT 0,
    "perks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "color" TEXT NOT NULL DEFAULT 'palm',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "member_no" TEXT NOT NULL,
    "tier_id" UUID,
    "points" INTEGER NOT NULL DEFAULT 0,
    "lifetime_points" INTEGER NOT NULL DEFAULT 0,
    "nights_12m" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enrolled_via" TEXT NOT NULL DEFAULT 'DESK',
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loyalty_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_transactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "type" "LoyaltyTxnType" NOT NULL,
    "points" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "reason" TEXT,
    "property_id" UUID,
    "reservation_id" UUID,
    "folio_id" UUID,
    "folio_entry_id" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "dedupe_key" TEXT,
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "approved_by_id" UUID,
    "approved_by_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_challenges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "folio_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_domains" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING',
    "token" TEXT NOT NULL,
    "failures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "txt_ok" BOOLEAN,
    "cname_ok" BOOLEAN,
    "check_count" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMPTZ(3),
    "verified_at" TIMESTAMPTZ(3),
    "failing_since" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "custom_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pos_outlets_tenant_id_idx" ON "pos_outlets"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_outlets_property_id_code_key" ON "pos_outlets"("property_id", "code");

-- CreateIndex
CREATE INDEX "pos_categories_tenant_id_idx" ON "pos_categories"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_categories_property_id_name_key" ON "pos_categories"("property_id", "name");

-- CreateIndex
CREATE INDEX "pos_items_tenant_id_idx" ON "pos_items"("tenant_id");

-- CreateIndex
CREATE INDEX "pos_items_property_id_category_id_idx" ON "pos_items"("property_id", "category_id");

-- CreateIndex
CREATE INDEX "pos_price_rules_tenant_id_idx" ON "pos_price_rules"("tenant_id");

-- CreateIndex
CREATE INDEX "pos_price_rules_property_id_idx" ON "pos_price_rules"("property_id");

-- CreateIndex
CREATE INDEX "pos_orders_tenant_id_idx" ON "pos_orders"("tenant_id");

-- CreateIndex
CREATE INDEX "pos_orders_property_id_status_idx" ON "pos_orders"("property_id", "status");

-- CreateIndex
CREATE INDEX "pos_orders_property_id_settled_at_idx" ON "pos_orders"("property_id", "settled_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_orders_property_id_number_key" ON "pos_orders"("property_id", "number");

-- CreateIndex
CREATE INDEX "pos_order_lines_tenant_id_idx" ON "pos_order_lines"("tenant_id");

-- CreateIndex
CREATE INDEX "pos_order_lines_order_id_idx" ON "pos_order_lines"("order_id");

-- CreateIndex
CREATE INDEX "pos_order_lines_property_id_created_at_idx" ON "pos_order_lines"("property_id", "created_at");

-- CreateIndex
CREATE INDEX "pos_tickets_tenant_id_idx" ON "pos_tickets"("tenant_id");

-- CreateIndex
CREATE INDEX "pos_tickets_property_id_status_idx" ON "pos_tickets"("property_id", "status");

-- CreateIndex
CREATE INDEX "pos_tickets_property_id_updated_at_idx" ON "pos_tickets"("property_id", "updated_at");

-- CreateIndex
CREATE INDEX "stock_items_tenant_id_idx" ON "stock_items"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_property_id_name_key" ON "stock_items"("property_id", "name");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_idx" ON "stock_movements"("tenant_id");

-- CreateIndex
CREATE INDEX "stock_movements_property_id_created_at_idx" ON "stock_movements"("property_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_stock_item_id_created_at_idx" ON "stock_movements"("stock_item_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_counts_tenant_id_idx" ON "stock_counts"("tenant_id");

-- CreateIndex
CREATE INDEX "stock_counts_property_id_counted_at_idx" ON "stock_counts"("property_id", "counted_at");

-- CreateIndex
CREATE INDEX "minibar_pars_tenant_id_idx" ON "minibar_pars"("tenant_id");

-- CreateIndex
CREATE INDEX "minibar_pars_property_id_idx" ON "minibar_pars"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "minibar_pars_room_type_id_item_id_key" ON "minibar_pars"("room_type_id", "item_id");

-- CreateIndex
CREATE INDEX "channel_connections_tenant_id_idx" ON "channel_connections"("tenant_id");

-- CreateIndex
CREATE INDEX "channel_connections_property_id_idx" ON "channel_connections"("property_id");

-- CreateIndex
CREATE INDEX "ical_feeds_tenant_id_idx" ON "ical_feeds"("tenant_id");

-- CreateIndex
CREATE INDEX "ical_feeds_connection_id_idx" ON "ical_feeds"("connection_id");

-- CreateIndex
CREATE INDEX "channel_mappings_tenant_id_idx" ON "channel_mappings"("tenant_id");

-- CreateIndex
CREATE INDEX "channel_mappings_connection_id_idx" ON "channel_mappings"("connection_id");

-- CreateIndex
CREATE INDEX "channel_sync_logs_tenant_id_idx" ON "channel_sync_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "channel_sync_logs_connection_id_started_at_idx" ON "channel_sync_logs"("connection_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "channel_sync_logs_property_id_started_at_idx" ON "channel_sync_logs"("property_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "channel_bookings_tenant_id_idx" ON "channel_bookings"("tenant_id");

-- CreateIndex
CREATE INDEX "channel_bookings_property_id_received_at_idx" ON "channel_bookings"("property_id", "received_at");

-- CreateIndex
CREATE INDEX "channel_bookings_reservation_id_idx" ON "channel_bookings"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_bookings_connection_id_external_id_key" ON "channel_bookings"("connection_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_settings_property_id_key" ON "pricing_settings"("property_id");

-- CreateIndex
CREATE INDEX "pricing_settings_tenant_id_idx" ON "pricing_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_guardrails_room_type_id_key" ON "pricing_guardrails"("room_type_id");

-- CreateIndex
CREATE INDEX "pricing_guardrails_tenant_id_idx" ON "pricing_guardrails"("tenant_id");

-- CreateIndex
CREATE INDEX "pricing_guardrails_property_id_idx" ON "pricing_guardrails"("property_id");

-- CreateIndex
CREATE INDEX "pricing_frozen_dates_tenant_id_idx" ON "pricing_frozen_dates"("tenant_id");

-- CreateIndex
CREATE INDEX "pricing_frozen_dates_property_id_date_idx" ON "pricing_frozen_dates"("property_id", "date");

-- CreateIndex
CREATE INDEX "pricing_events_tenant_id_idx" ON "pricing_events"("tenant_id");

-- CreateIndex
CREATE INDEX "pricing_events_property_id_date_from_idx" ON "pricing_events"("property_id", "date_from");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_events_property_id_national_key_key" ON "pricing_events"("property_id", "national_key");

-- CreateIndex
CREATE INDEX "competitor_rates_tenant_id_idx" ON "competitor_rates"("tenant_id");

-- CreateIndex
CREATE INDEX "competitor_rates_property_id_date_idx" ON "competitor_rates"("property_id", "date");

-- CreateIndex
CREATE INDEX "price_suggestions_tenant_id_idx" ON "price_suggestions"("tenant_id");

-- CreateIndex
CREATE INDEX "price_suggestions_property_id_date_idx" ON "price_suggestions"("property_id", "date");

-- CreateIndex
CREATE INDEX "price_suggestions_room_type_id_date_status_idx" ON "price_suggestions"("room_type_id", "date", "status");

-- CreateIndex
CREATE INDEX "price_changes_tenant_id_idx" ON "price_changes"("tenant_id");

-- CreateIndex
CREATE INDEX "price_changes_property_id_date_idx" ON "price_changes"("property_id", "date");

-- CreateIndex
CREATE INDEX "price_changes_room_type_id_date_idx" ON "price_changes"("room_type_id", "date");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_idx" ON "conversations"("tenant_id");

-- CreateIndex
CREATE INDEX "conversations_property_id_last_message_at_idx" ON "conversations"("property_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_property_id_guest_phone_idx" ON "conversations"("property_id", "guest_phone");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_provider_message_id_key" ON "conversation_messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "conversation_messages_tenant_id_idx" ON "conversation_messages"("tenant_id");

-- CreateIndex
CREATE INDEX "conversation_messages_conversation_id_created_at_idx" ON "conversation_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "quick_replies_tenant_id_idx" ON "quick_replies"("tenant_id");

-- CreateIndex
CREATE INDEX "quick_replies_property_id_idx" ON "quick_replies"("property_id");

-- CreateIndex
CREATE INDEX "task_suggestions_tenant_id_idx" ON "task_suggestions"("tenant_id");

-- CreateIndex
CREATE INDEX "task_suggestions_property_id_status_idx" ON "task_suggestions"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_settings_property_id_key" ON "inbox_settings"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_settings_phone_number_id_key" ON "inbox_settings"("phone_number_id");

-- CreateIndex
CREATE INDEX "inbox_settings_tenant_id_idx" ON "inbox_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_programmes_tenant_id_key" ON "loyalty_programmes"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_tiers_tenant_id_name_key" ON "loyalty_tiers"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_members_guest_id_key" ON "loyalty_members"("guest_id");

-- CreateIndex
CREATE INDEX "loyalty_members_tenant_id_tier_id_idx" ON "loyalty_members"("tenant_id", "tier_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_members_tenant_id_member_no_key" ON "loyalty_members"("tenant_id", "member_no");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_transactions_dedupe_key_key" ON "loyalty_transactions"("dedupe_key");

-- CreateIndex
CREATE INDEX "loyalty_transactions_tenant_id_created_at_idx" ON "loyalty_transactions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_transactions_member_id_created_at_idx" ON "loyalty_transactions"("member_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_transactions_type_expires_at_idx" ON "loyalty_transactions"("type", "expires_at");

-- CreateIndex
CREATE INDEX "loyalty_challenges_tenant_id_idx" ON "loyalty_challenges"("tenant_id");

-- CreateIndex
CREATE INDEX "loyalty_challenges_member_id_idx" ON "loyalty_challenges"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_domains_domain_key" ON "custom_domains"("domain");

-- CreateIndex
CREATE INDEX "custom_domains_tenant_id_idx" ON "custom_domains"("tenant_id");

-- CreateIndex
CREATE INDEX "custom_domains_property_id_idx" ON "custom_domains"("property_id");

-- CreateIndex
CREATE INDEX "custom_domains_status_idx" ON "custom_domains"("status");

-- AddForeignKey
ALTER TABLE "pos_outlets" ADD CONSTRAINT "pos_outlets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_outlets" ADD CONSTRAINT "pos_outlets_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_categories" ADD CONSTRAINT "pos_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_categories" ADD CONSTRAINT "pos_categories_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "pos_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_price_rules" ADD CONSTRAINT "pos_price_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_price_rules" ADD CONSTRAINT "pos_price_rules_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "pos_outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pos_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "pos_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "pos_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tickets" ADD CONSTRAINT "pos_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tickets" ADD CONSTRAINT "pos_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pos_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tickets" ADD CONSTRAINT "pos_tickets_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "pos_outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "minibar_pars" ADD CONSTRAINT "minibar_pars_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "minibar_pars" ADD CONSTRAINT "minibar_pars_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "pos_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ical_feeds" ADD CONSTRAINT "ical_feeds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ical_feeds" ADD CONSTRAINT "ical_feeds_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_mappings" ADD CONSTRAINT "channel_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_mappings" ADD CONSTRAINT "channel_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_logs" ADD CONSTRAINT "channel_sync_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sync_logs" ADD CONSTRAINT "channel_sync_logs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_bookings" ADD CONSTRAINT "channel_bookings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_bookings" ADD CONSTRAINT "channel_bookings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "channel_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_settings" ADD CONSTRAINT "pricing_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_guardrails" ADD CONSTRAINT "pricing_guardrails_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_frozen_dates" ADD CONSTRAINT "pricing_frozen_dates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_events" ADD CONSTRAINT "pricing_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_rates" ADD CONSTRAINT "competitor_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_suggestions" ADD CONSTRAINT "price_suggestions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_suggestions" ADD CONSTRAINT "task_suggestions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_suggestions" ADD CONSTRAINT "task_suggestions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_settings" ADD CONSTRAINT "inbox_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_programmes" ADD CONSTRAINT "loyalty_programmes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "loyalty_tiers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_members" ADD CONSTRAINT "loyalty_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_members" ADD CONSTRAINT "loyalty_members_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_members" ADD CONSTRAINT "loyalty_members_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "loyalty_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "loyalty_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_challenges" ADD CONSTRAINT "loyalty_challenges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- Integrity rules Prisma cannot express.
-- -----------------------------------------------------------------------------
ALTER TABLE "pos_order_lines" ADD CONSTRAINT "pos_order_lines_quantity" CHECK (quantity >= 1);
ALTER TABLE "pos_items" ADD CONSTRAINT "pos_items_price" CHECK (price_kobo >= 0);
ALTER TABLE "loyalty_members" ADD CONSTRAINT "loyalty_members_points" CHECK (points >= 0);
ALTER TABLE "pricing_guardrails" ADD CONSTRAINT "pricing_guardrails_range" CHECK (floor_kobo > 0 AND ceiling_kobo >= floor_kobo);
-- One open guest conversation per phone per property.
CREATE UNIQUE INDEX "conversations_one_open_per_phone"
  ON "conversations" ("property_id", "guest_phone") WHERE "status" <> 'CLOSED';
-- One pending suggestion per room type and night.
CREATE UNIQUE INDEX "price_suggestions_one_pending"
  ON "price_suggestions" ("room_type_id", "date") WHERE "status" = 'PENDING';

-- -----------------------------------------------------------------------------
-- RLS: every M5 table is tenant-scoped (property access is enforced by the API).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pos_outlets', 'pos_categories', 'pos_items', 'pos_price_rules', 'pos_orders', 'pos_order_lines', 'pos_tickets',
    'stock_items', 'stock_movements', 'stock_counts', 'minibar_pars',
    'channel_connections', 'ical_feeds', 'channel_mappings', 'channel_sync_logs', 'channel_bookings',
    'pricing_settings', 'pricing_guardrails', 'pricing_frozen_dates', 'pricing_events', 'competitor_rates',
    'price_suggestions', 'price_changes',
    'conversations', 'conversation_messages', 'quick_replies', 'task_suggestions', 'inbox_settings',
    'loyalty_programmes', 'loyalty_tiers', 'loyalty_members', 'loyalty_transactions', 'loyalty_challenges',
    'custom_domains'
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
-- Grants. Stock movements and loyalty transactions are ledgers: append-only
-- for the API (SELECT, INSERT); loyalty lots are consumed through UPDATE of
-- `remaining` only, so loyalty_transactions keeps UPDATE for that column.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  pos_outlets, pos_categories, pos_items, pos_price_rules, pos_orders, pos_order_lines, pos_tickets,
  stock_items, stock_counts, minibar_pars,
  channel_connections, ical_feeds, channel_mappings, channel_sync_logs, channel_bookings,
  pricing_settings, pricing_guardrails, pricing_frozen_dates, pricing_events, competitor_rates,
  price_suggestions, price_changes,
  conversations, conversation_messages, quick_replies, task_suggestions, inbox_settings,
  loyalty_programmes, loyalty_tiers, loyalty_members, loyalty_challenges,
  custom_domains
TO hotel_app;
GRANT SELECT, INSERT ON stock_movements TO hotel_app;
GRANT SELECT, INSERT ON loyalty_transactions TO hotel_app;
GRANT UPDATE (remaining) ON loyalty_transactions TO hotel_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  pos_outlets, pos_categories, pos_items, pos_price_rules, pos_orders, pos_order_lines, pos_tickets,
  stock_items, stock_movements, stock_counts, minibar_pars,
  channel_connections, ical_feeds, channel_mappings, channel_sync_logs, channel_bookings,
  pricing_settings, pricing_guardrails, pricing_frozen_dates, pricing_events, competitor_rates,
  price_suggestions, price_changes,
  conversations, conversation_messages, quick_replies, task_suggestions, inbox_settings,
  loyalty_programmes, loyalty_tiers, loyalty_members, loyalty_transactions, loyalty_challenges,
  custom_domains
TO hotel_platform;
