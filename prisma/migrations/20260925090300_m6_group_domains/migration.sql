-- M6: a verified custom domain can point at the group root instead of one property.
ALTER TABLE "custom_domains" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'PROPERTY';
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_scope_check" CHECK ("scope" IN ('PROPERTY', 'GROUP'));
-- At most one group-root domain per tenant.
CREATE UNIQUE INDEX "custom_domains_tenant_group_key" ON "custom_domains"("tenant_id") WHERE "scope" = 'GROUP';
