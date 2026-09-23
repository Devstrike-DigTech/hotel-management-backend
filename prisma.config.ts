import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Migrations and seeding run as the schema owner (`hotel`). The application
// itself connects as the restricted `hotel_app` role via DATABASE_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url:
      process.env.DATABASE_MIGRATION_URL ??
      'postgresql://hotel:hotel@localhost:5432/hotel',
  },
});
