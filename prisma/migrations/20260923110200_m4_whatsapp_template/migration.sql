-- M4: WhatsApp messages outside the 24-hour window go out as approved
-- templates; the template name and parameters are kept with the message so
-- retries send the same thing.
ALTER TABLE "notification_logs" ADD COLUMN "wa_template" JSONB;
