-- M5: where a date override came from (the rates calendar or dynamic pricing).
ALTER TABLE "rate_overrides" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
