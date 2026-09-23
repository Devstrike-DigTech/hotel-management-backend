-- Idempotency keys record whether a business transaction of the request has
-- committed (set inside that transaction). See IdempotencyInterceptor.
ALTER TABLE "idempotency_keys" ADD COLUMN "applied" BOOLEAN NOT NULL DEFAULT false;
