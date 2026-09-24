-- M6: new platform roles and the partner API reservation source. Enum values
-- are added in their own migration so the next one can use them.
ALTER TYPE "PlatformRole" ADD VALUE IF NOT EXISTS 'OPERATIONS';
ALTER TYPE "PlatformRole" ADD VALUE IF NOT EXISTS 'FINANCE';
ALTER TYPE "PlatformRole" ADD VALUE IF NOT EXISTS 'SALES_READONLY';
ALTER TYPE "ReservationSource" ADD VALUE IF NOT EXISTS 'API';
