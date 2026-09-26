-- M8, part 1: enum values (own migration: a value added with ALTER TYPE ...
-- ADD VALUE cannot be used in the same transaction).
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'CONCIERGE';
ALTER TYPE "DocumentCounterKind" ADD VALUE IF NOT EXISTS 'CONCIERGE_REQUEST';
