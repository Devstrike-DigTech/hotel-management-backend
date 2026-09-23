-- M5: uniqueness that was per hotel becomes per property (hotel groups).

-- One BAR plan per property.
DROP INDEX IF EXISTS "rate_plans_one_bar";
CREATE UNIQUE INDEX "rate_plans_one_bar" ON "rate_plans" ("property_id") WHERE "is_bar";

-- Checklist templates: one per property, room type (or all) and task type.
DROP INDEX IF EXISTS "housekeeping_checklists_unique";
CREATE UNIQUE INDEX "housekeeping_checklists_unique"
  ON "housekeeping_checklists" ("property_id", COALESCE("room_type_id", '00000000-0000-0000-0000-000000000000'::uuid), "task_type");

-- Restrictions: one per property, room type (or all) and date.
DROP INDEX IF EXISTS "rate_restrictions_unique";
CREATE UNIQUE INDEX "rate_restrictions_unique"
  ON "rate_restrictions" ("property_id", COALESCE("room_type_id", '00000000-0000-0000-0000-000000000000'::uuid), "date");
