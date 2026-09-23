-- Runs once when the postgres container initialises an empty data directory.
-- POSTGRES_USER (hotel) owns the schema and runs migrations; hotel_app is the
-- restricted runtime role the API connects as, so row-level security applies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_app') THEN
    CREATE ROLE hotel_app LOGIN PASSWORD 'hotel_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
