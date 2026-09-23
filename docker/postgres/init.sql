-- Runs once when the postgres container initialises an empty data directory.
-- POSTGRES_USER (hotel) owns the schema and runs migrations.
--   hotel_app      : restricted runtime role for tenant requests (RLS applies)
--   hotel_platform : restricted role for cross-tenant work (platform console,
--                    webhooks, scheduled jobs); access comes only from
--                    policies granted TO hotel_platform.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_app') THEN
    CREATE ROLE hotel_app LOGIN PASSWORD 'hotel_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_platform') THEN
    CREATE ROLE hotel_platform LOGIN PASSWORD 'hotel_platform' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
