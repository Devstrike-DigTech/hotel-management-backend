-- M4, part 1: enum values. Kept in their own migration because a value added
-- with ALTER TYPE ... ADD VALUE cannot be used in the same transaction.

-- CreateEnum
CREATE TYPE "HousekeepingTaskType" AS ENUM ('CHECKOUT_CLEAN', 'STAYOVER', 'DEEP_CLEAN', 'TURNDOWN', 'INSPECTION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "LostFoundStatus" AS ENUM ('HELD', 'RETURNED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "MaintenanceCategory" AS ENUM ('ELECTRICAL', 'PLUMBING', 'AC_HVAC', 'FURNITURE', 'APPLIANCE', 'GENERATOR', 'CIVIL', 'IT', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RatePlanKind" AS ENUM ('BAR', 'NON_REFUNDABLE', 'CORPORATE', 'LONG_STAY', 'PACKAGE');

-- CreateEnum
CREATE TYPE "RatePlanPricing" AS ENUM ('DERIVED', 'FIXED');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('PERCENT', 'AMOUNT', 'FIXED');

-- CreateEnum
CREATE TYPE "PromoType" AS ENUM ('PERCENT', 'AMOUNT', 'FREE_NIGHT');

-- CreateEnum
CREATE TYPE "PromoRedemptionStatus" AS ENUM ('HELD', 'CONFIRMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('PER_STAY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "CityLedgerInvoiceStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "CityLedgerInvoiceKind" AS ENUM ('PER_STAY', 'STATEMENT');

-- CreateEnum
CREATE TYPE "LedgerPaymentMethod" AS ENUM ('TRANSFER', 'CHEQUE', 'CASH', 'POS');

-- CreateEnum
CREATE TYPE "GuardAlertStatus" AS ENUM ('PENDING', 'SENT', 'DEFERRED', 'FAILED', 'ACKNOWLEDGED');

ALTER TYPE "DocumentCounterKind" ADD VALUE IF NOT EXISTS 'MAINTENANCE_TICKET';
ALTER TYPE "DocumentCounterKind" ADD VALUE IF NOT EXISTS 'CITY_LEDGER';

ALTER TYPE "HousekeepingTaskReason" ADD VALUE IF NOT EXISTS 'STAYOVER_JOB';
ALTER TYPE "HousekeepingTaskReason" ADD VALUE IF NOT EXISTS 'DEEP_CLEAN_RULE';
ALTER TYPE "HousekeepingTaskReason" ADD VALUE IF NOT EXISTS 'MAINTENANCE';

-- M2 PENDING becomes OPEN (existing rows keep their meaning).
ALTER TYPE "HousekeepingTaskStatus" RENAME VALUE 'PENDING' TO 'OPEN';
ALTER TYPE "HousekeepingTaskStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "HousekeepingTaskStatus" ADD VALUE IF NOT EXISTS 'INSPECTED';
ALTER TYPE "HousekeepingTaskStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "HousekeepingTaskStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'SUPERVISOR';
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'MAINTENANCE';
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'CUSTOM';
