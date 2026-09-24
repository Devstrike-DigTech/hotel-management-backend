-- M6: partner API bookings carry the partner's own reference.
ALTER TABLE "reservations" ADD COLUMN "external_ref" TEXT;
CREATE INDEX "reservations_tenant_id_external_ref_idx" ON "reservations"("tenant_id", "external_ref") WHERE "external_ref" IS NOT NULL;
