# Hotel Management API

Backend for a multi-tenant hotel management SaaS built by Devstrike Digital
Limited for the Nigerian market. Hotels subscribe to a plan (Starter, Growth,
Pro, Enterprise). Guests book through a public marketplace and through
per-hotel microsites.

The product name is not final, so the code never hard-codes it. It comes from
`APP_NAME`, `APP_DOMAIN` and `SUPPORT_EMAIL` (placeholders: `HotelOS`,
`hotelos.ng`).

- NestJS 12 (ESM), TypeScript, class-validator DTOs, Swagger at `/docs`
- PostgreSQL 16 with row-level security, Prisma 7.10 (driver adapter `@prisma/adapter-pg`)
- BullMQ on Redis 7 for background jobs
- argon2id password hashing, JWT access tokens (15 min), rotating opaque refresh tokens (30 days)
- Paystack for subscription payments
- Vitest (unit and e2e, with supertest), oxlint

Base URL: `http://localhost:4000/api/v1`. Swagger UI: `http://localhost:4000/docs`
(JSON at `/docs/json`).

---

## Quick start

Requirements: Node 22, pnpm 10, PostgreSQL 16 and Redis 7. You can start
PostgreSQL and Redis with `docker compose up -d`, or use your own.

```bash
pnpm install                 # also runs `prisma generate`
cp .env.example .env         # then adjust if needed
pnpm db:migrate              # apply migrations as the owner role
pnpm db:seed                 # plans, features, demo hotel, 8 marketplace hotels
pnpm start:dev               # http://localhost:4000/api/v1
```

The database needs two roles:

| role | used for | attributes |
|---|---|---|
| `hotel` | owns the schema, runs migrations and the seed (`DATABASE_MIGRATION_URL`) | owner (superuser locally) |
| `hotel_app` | the running API (`DATABASE_URL`) | `NOSUPERUSER NOBYPASSRLS`, so RLS applies |

`docker compose` creates both (see `docker/postgres/init.sql`). On a
database you manage yourself, create `hotel_app` with `LOGIN` and a password.
The RLS migration creates it `NOLOGIN` if it is missing, so the grants still
apply.

### Seed accounts

| who | email | password |
|---|---|---|
| Platform console (Devstrike) | `admin@devstrike.ng` | `Admin1234!` |
| Demo hotel owner, The Palmwine House (Growth, ACTIVE, 24 rooms, Lekki Phase 1) | `demo@palmwine.ng` | `Demo1234!` |
| Palmwine staff | `tunde@` (manager), `ngozi@` (front desk), `musa@` (housekeeping), `funmi@palmwine.ng` (accountant) | `Demo1234!` |
| Starter hotel on trial (housekeeping is locked) | `owner@wusegarden.ng` | `Demo1234!` |
| Starter hotel, PAST_DUE | `owner@marinacreek.ng` | `Demo1234!` |

The other marketplace hotels are `ikoyi-lantern` (Pro), `eko-tides` (Growth),
`maitama-court` (Enterprise), `garden-city-lodge` (Growth), `bodija-heights`
(Starter) and `coal-city-retreat` (Growth). Each owner is
`owner@<domain>.ng`; see `prisma/seed-data/hotels.ts`.

The seed is idempotent. It upserts everything by natural key (codes, slugs,
emails, room numbers) and writes a hotel's audit history only once, because
audit rows can never be updated or deleted.

---

## Scripts

| script | what it does |
|---|---|
| `pnpm start:dev` | API in watch mode |
| `pnpm build` / `pnpm start:prod` | compile to `dist/` / run the compiled API |
| `pnpm lint` | oxlint with type-aware rules |
| `pnpm typecheck` | `tsc --noEmit` over src, test, prisma and scripts |
| `pnpm test` | unit tests (`src/**/*.spec.ts`) |
| `pnpm test:e2e` | end-to-end tests against a throwaway `hotel_test` database |
| `pnpm db:migrate` | `prisma migrate deploy` (as `DATABASE_MIGRATION_URL`) |
| `pnpm db:migrate:dev` | create or apply migrations in development |
| `pnpm db:seed` | idempotent seed |
| `pnpm db:reset` | drop, re-migrate and re-seed the dev database |
| `pnpm prisma:generate` | regenerate the Prisma client into `src/generated/prisma` |
| `pnpm images:verify` | check that every seed image URL returns HTTP 200 |

---

## Environment

All variables are validated at startup (`src/config/env.schema.ts`). The
process refuses to start and lists every missing or invalid value.

| variable | required | notes |
|---|---|---|
| `APP_NAME`, `APP_DOMAIN`, `SUPPORT_EMAIL` | yes | product identity, returned by `GET /public/app` |
| `PORT` | no (4000) | |
| `NODE_ENV` | no (development) | `production` disables `/billing/dev/confirm` and the mock checkout |
| `DATABASE_URL` | yes | runtime role `hotel_app` |
| `DATABASE_MIGRATION_URL` | for migrate/seed | owner role `hotel` |
| `DATABASE_POOL_MAX` | no (10) | pg pool size |
| `REDIS_URL` | yes | BullMQ |
| `JWT_ACCESS_SECRET` | yes, min 32 chars | hotel staff tokens (audience `hotel`) |
| `JWT_PLATFORM_SECRET` | yes, min 32 chars | platform console tokens (audience `platform`) |
| `JWT_REFRESH_SECRET` | yes, min 32 chars | HMAC key for stored refresh-token hashes |
| `JWT_ACCESS_TTL`, `REFRESH_TOKEN_TTL_DAYS` | no (15m, 30) | |
| `PAYSTACK_SECRET_KEY` | no | empty means mock checkout (not allowed in production) |
| `PAYSTACK_BASE_URL` | no | defaults to `https://api.paystack.co` |
| `ADMIN_URL`, `WEB_URL` | yes | frontend origins, used for payment callbacks |
| `CORS_ORIGINS` | no | comma-separated; defaults to both local frontends |
| `AUTH_RATE_LIMIT` | no (20) | requests per minute per IP on auth endpoints |
| `JOBS_ENABLED` | no (true) | `false` starts no BullMQ workers or schedules |
| `SWAGGER_ENABLED` | no (true) | serve `/docs` |

---

## Architecture

```
src/
  main.ts, setup-app.ts        bootstrap: prefix, CORS, helmet, validation, error filter, Swagger
  config/                      zod-validated env + typed AppConfigService
  prisma/                      PrismaService (hotel_app) and DbService (RLS contexts)
  common/                      error envelope, decorators, AuthGuard, RolesGuard
  modules/
    health, public             anonymous endpoints
    auth, me                   staff auth and session info
    entitlements               plan + override computation, feature/limit/subscription guards
    audit                      append-only audit trail + GET /audit-logs
    dashboard, property, room-types, rooms, staff, housekeeping
    billing                    subscription, invoices, checkout, Paystack webhook, dunning logic
    jobs                       BullMQ queue, processor and daily scheduler
    platform                   Devstrike console: auth, metrics, tenants, overrides, plans
prisma/
  schema.prisma, migrations/   schema; the RLS migration is hand-written SQL
  seed.ts, seed-data/          idempotent seed
```

Global guards run in this order: `AuthGuard` (JWT and audience) →
`RolesGuard` (`@Roles`) → `SubscriptionGuard` (blocks writes on read-only
subscriptions) → `FeatureGuard` (`@RequireFeature`) → `LimitGuard`
(`@CheckLimit`). Entitlements are loaded at most once per request and cached
on it.

Every error uses one envelope:

```json
{ "statusCode": 403, "code": "LIMIT_REACHED", "message": "...", "details": { "limit": "max_rooms", "max": 60, "current": 60, "upgradePlan": "pro" } }
```

---

## Tenant isolation: row-level security

Every tenant-scoped table has a `tenant_id` column. The tables are
`properties`, `room_types`, `rooms`, `users`, `refresh_tokens`,
`tenant_feature_overrides`, `subscriptions`, `invoices` and `audit_logs`.
`tenants` is keyed by its own `id`. The migration
`prisma/migrations/*_rls_grants_audit` runs `ENABLE` and `FORCE ROW LEVEL
SECURITY` on all of them and creates this policy:

```sql
CREATE POLICY tenant_isolation ON rooms FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

`NULLIF` is there because after the first transaction-local `set_config`, the
setting reads as `''` rather than NULL, and `''::uuid` would raise an error.

### Setting the tenant per request

The API connects as `hotel_app`, which has neither `SUPERUSER` nor
`BYPASSRLS`. All data access goes through `DbService`
(`src/prisma/db.service.ts`):

```ts
await this.db.tenant(user.tenantId, async (tx) => {
  // first statement inside the transaction, added by DbService:
  //   SELECT set_config('app.tenant_id', $1, true)
  return tx.room.findMany({ ... });
});
```

- `DbService` opens a Prisma interactive transaction. Its first statement is
  `set_config(..., true)`. The third argument makes the setting
  **transaction-local**, so Postgres discards it at COMMIT or ROLLBACK. It
  cannot leak to the next request that reuses the pooled connection, which is
  the main risk with session-level `SET`.
- The tenant id comes only from the verified JWT (`req.user.tenantId`),
  never from the request body or URL. It is also checked to be a UUID
  before use.
- Queries outside a `DbService` context fail closed. With no setting, every
  tenant table looks empty and every write fails its `WITH CHECK`.
- Services still add `where: { tenantId }` to their queries. RLS is the
  backstop that holds even when a query forgets the filter.
- A mutation and its audit entry run in the same transaction, so they commit
  together or not at all.

We chose an explicit transaction helper over a Prisma client extension that
wraps every query in its own batch transaction. The helper lets a
multi-statement operation (for example: check the limit, insert rooms, write
the audit entry) run atomically under one tenant context, and it is easy to
review with grep.

### Deliberate cross-tenant paths

Some reads must span tenants. Each has its own narrow mechanism, so no code
path gets RLS switched off completely:

| path | mechanism | what it can do |
|---|---|---|
| Public marketplace (`/public/*`) | `db.public()` sets `app.context = 'public'` | **SELECT only** on `tenants`, `properties`, `room_types`, `rooms` and `subscriptions` (to hide SUSPENDED hotels). No policy exposes `users`, `refresh_tokens`, `invoices`, `audit_logs` or overrides to this context, and there are no write policies. |
| Login and refresh-token lookup | `SECURITY DEFINER` functions `app_auth_find_user(email)` and `app_auth_find_refresh_token(hash)` | Return the single row that matches an exact email or token hash. Everything after the lookup runs in that user's tenant context. |
| Signup | none needed | The new tenant id is generated first and set as `app.tenant_id`, so every insert passes the normal tenant policy. |
| Platform console, Paystack webhooks, dunning job | `db.system()` sets `app.context = 'system'` | Full access. Used only in `PlatformService`, `PlatformAuthService`, `PaystackWebhookService` and `DunningService`. Audit with `grep -rn "\.system(" src`. |

Global tables work as follows. `plans`, `features` and `plan_features` are
readable in every context and writable only in `system`. `platform_users`
and `payment_events` are available only in `system`. Platform-level audit
rows (plan edits, console logins) have a NULL `tenant_id`, so they match no
tenant policy.

**Caveat, and the next hardening step.** `app.context` is a normal GUC, so
any SQL running as `hotel_app` could set it, for example through a SQL
injection. Prisma parameterises every query, and the three contexts are set
only inside `DbService`. For stronger separation, run the platform console
and webhooks under a third role with its own policies, instead of a GUC on
the shared role.

### Grants and append-only audit

- `hotel_app` gets explicit per-table grants. No default privileges are set,
  so a new table stays invisible to the API until a migration grants it
  (and enables RLS if it is tenant-scoped).
- `audit_logs`: `hotel_app` has only `SELECT` and `INSERT`. Triggers raise
  an error on `UPDATE`, `DELETE` and `TRUNCATE` for every role, including the
  owner. Staff deletion is a hard delete, while audit rows keep the actor's
  id and a snapshot of their name (with no foreign key), so history survives.

The e2e suite (`test/tenant-isolation.e2e-spec.ts`) checks all of this over
the API and directly in SQL as `hotel_app`.

---

## Entitlements

`EntitlementsService` (`src/modules/entitlements`) computes, for a tenant:

- **features** = the plan's features, plus overrides with `enabled = true`
  (add-ons), minus overrides with `enabled = false`
- **limits** = the plan's `limits` JSON (`max_rooms`, `max_staff`,
  `max_properties`; `-1` means unlimited)
- **usage** = rooms, active staff (the owner counts), properties
- **writeBlocked** = the subscription is `READ_ONLY` or `SUSPENDED`, or
  `CANCELLED` after the paid period

Decorators and guards:

```ts
@RequireFeature('housekeeping')   // 403 FEATURE_LOCKED  { feature, requiredPlan }
@CheckLimit('max_rooms')          // 403 LIMIT_REACHED   { limit, max, current, upgradePlan }
@Roles('OWNER', 'MANAGER')        // 403 FORBIDDEN
@AllowWhenReadOnly()              // lets a write through a read-only subscription (billing, logout)
```

- `requiredPlan` is the cheapest active plan (by `sortOrder`) that includes
  the feature.
- `upgradePlan` is the next plan up whose limit fits the requested usage.
- `SubscriptionGuard` returns `402 SUBSCRIPTION_READ_ONLY` for any non-GET
  hotel request while writes are blocked. Reads, billing and logout still
  work.
- Bulk operations (for example `POST /rooms/bulk`) re-check the exact count
  inside their transaction. The request is rejected as a whole if it would
  overshoot.
- Some checks depend on the request body, and services run them explicitly.
  Branding fields on `PATCH /property` need `booking_site_branding`, and a
  non-null `hourlyPriceKobo` needs `hourly_bookings`.

Plans and plan features are data. The platform console edits them through
`PATCH /platform/plans/:code`, and per-tenant add-ons go through
`PUT /platform/tenants/:id/features`.

---

## Auth

- **Staff**: `POST /auth/signup` creates a tenant, its primary property, an
  OWNER user and a 14-day Growth trial, all in one transaction.
  `POST /auth/login` returns `{ accessToken, refreshToken, user }`.
- **Access tokens**: HS256 JWT, 15 min, audience `hotel`, claims
  `sub, tid, role, email, name`.
- **Refresh tokens** are opaque, 256-bit random, and stored only as
  `HMAC-SHA256(JWT_REFRESH_SECRET, token)`.
  - Each refresh rotates the token: the old one is revoked with reason
    `rotated`, and a new one is issued in the same family.
  - If a rotated token is presented again, it was copied. The whole family
    is revoked and the API returns `401 REFRESH_TOKEN_REUSED`. A conditional
    update also treats two concurrent refreshes of the same token as reuse.
  - Logout revokes the family.
  - Changing a staff member's password, role or active flag revokes their
    tokens.
- **Platform console**: separate `platform_users` table, separate secret
  (`JWT_PLATFORM_SECRET`) and audience `platform`. The two kinds of token are
  not interchangeable.
- Login, signup and refresh are rate-limited per IP. Login verifies against
  a dummy hash when the email is unknown, so response timing does not reveal
  which emails are registered.

---

## Billing and Paystack

```
admin app                     API                                   Paystack
   |  POST /billing/checkout    |                                        |
   |--------------------------->| create Invoice (PENDING, reference)    |
   |                            | POST /transaction/initialize --------->|
   |<---- { authorizationUrl } -|<------------- authorization_url -------|
   |  redirect user ------------------------------------------------------>| pays
   |                            |<-- POST /billing/webhooks/paystack ----| charge.success
   |                            | verify x-paystack-signature (HMAC-SHA512 of raw body)
   |                            | insert payment_events(event_key) -- unique = idempotent
   |                            | mark invoice PAID, subscription ACTIVE, extend period
```

- **Signature.** The app starts with `rawBody: true`, and the handler
  computes an HMAC-SHA512 of the exact bytes received, keyed with
  `PAYSTACK_SECRET_KEY`, then compares in constant time. A missing or wrong
  signature returns `401 INVALID_SIGNATURE`. If no key is configured, every
  webhook is rejected.
- **Idempotency.** The key is `paystack:<event>:<data.id | reference | subscription_code | sha256(body)>`.
  The ledger insert and the state change share one transaction. A replay
  gets `200 { received: true, duplicate: true }`. If processing fails, both
  roll back, so Paystack's retry is processed normally.
- **Events handled:**
  - `charge.success`: the amount and currency must match the invoice.
    Activates or extends the subscription and stores the customer code.
  - `subscription.create`: links the Paystack subscription code.
  - `subscription.disable`: sets the subscription to CANCELLED.
  - `invoice.payment_failed`: moves an ACTIVE subscription to PAST_DUE.
- **Development without a Paystack key.** Checkout returns
  `${ADMIN_URL}/billing/mock-checkout?reference=...`, and the admin app then
  calls `POST /billing/dev/confirm { reference }` to simulate the payment.
  That route returns 404 when `NODE_ENV=production`, and production refuses
  checkout without a key.
- **Enterprise.** Its price is `null`, so checkout returns 400 with a
  contact-sales message.

### Dunning

A BullMQ job scheduler (`dunning-daily`, `0 2 * * *` Africa/Lagos) runs
`DunningService`. The state machine (`billing/dunning.logic.ts`) is:

| from | condition | to |
|---|---|---|
| TRIALING | past `trialEndsAt` without a payment | READ_ONLY |
| ACTIVE | past `currentPeriodEnd` + 3 days | PAST_DUE |
| PAST_DUE | 7 days after becoming past due | READ_ONLY |
| READ_ONLY | 30 days after becoming read-only | SUSPENDED |

- Each transition is stamped with the moment its threshold was crossed, and
  the job applies every step that is due. If the job was down for a week, it
  still produces the correct timeline.
- Every transition is audited.
- Public booking pages keep working in every state except SUSPENDED.
- Run the job on demand with `POST /platform/jobs/dunning/run`.

---

## API surface

The full contract is in Swagger at `/docs`. Summary:

- **Public**: `GET /health`, `/public/app`, `/public/plans`,
  `/public/features`, `/public/cities`, `/public/hotels`,
  `/public/hotels/:slug`, `/public/resolve-host?host=`
- **Auth**: `POST /auth/signup`, `/auth/login`, `/auth/refresh`,
  `/auth/logout`; `GET /me`
- **Hotel** (Bearer staff token):
  - `GET /dashboard/summary`, `GET|PATCH /property`
  - `/room-types` (CRUD); `/rooms` (list, create, bulk, patch, status, delete)
  - `/staff` (CRUD)
  - `GET /audit-logs`, `GET /housekeeping/tasks`
  - `GET /billing/subscription`, `GET /billing/invoices`,
    `POST /billing/checkout`, `POST /billing/dev/confirm`
- **Webhook**: `POST /billing/webhooks/paystack`
- **Platform** (Bearer platform token):
  - `POST /platform/auth/login`, `GET /platform/auth/me`
  - `GET /platform/metrics`
  - `GET /platform/tenants`, `GET /platform/tenants/:id`,
    `PATCH /platform/tenants/:id/subscription`
  - `PUT /platform/tenants/:id/features`,
    `DELETE /platform/tenants/:id/features/:featureCode`
  - `GET /platform/plans`, `PATCH /platform/plans/:code`
  - `POST /platform/jobs/dunning/run`

Conventions:

- Money is always integer kobo, in fields named `...Kobo`.
- Dates are ISO 8601 strings in UTC. Business logic uses Africa/Lagos
  (UTC+1) where days matter.
- `DELETE` routes return `{ "success": true }`.

---

## Testing

```bash
pnpm test        # unit
pnpm test:e2e    # needs local Postgres (roles hotel, hotel_app) and Redis
```

The e2e global setup drops and recreates the `hotel_test` database (override
with `E2E_DB_NAME`). It runs `prisma migrate deploy` as `hotel` and then the
seed. The suites run the real Nest app through supertest, with the API
connected as `hotel_app`. A small local HTTP stub stands in for
`api.paystack.co`.

---

## Docker

```bash
docker compose up -d                    # postgres + redis only
docker compose --profile api up --build # also build and run the API (runs migrate deploy first)
```

The `Dockerfile` is a multi-stage build on `node:22-bookworm-slim`. The final
image contains only production dependencies (including the Prisma CLI for
`migrate deploy`) and the compiled `dist/`, and runs as the `node` user.

---

## Seed images

Hotel and room images are Unsplash CDN URLs
(`https://images.unsplash.com/photo-...?w=1600&q=80`), listed in one place:
`PHOTOS` in `prisma/seed-data/hotels.ts`. Run `pnpm images:verify` to check
that each one returns HTTP 200. Replace any failing id in `PHOTOS` and re-run
`pnpm db:seed`.
