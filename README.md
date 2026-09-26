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
- Paystack for subscription payments and for guest bookings (split payments
  to hotel subaccounts with the platform commission taken per transaction)
- Hotel operations (M2): reservations with database-enforced no double booking,
  guest register (NDPA-aware), check-in/out, folios with Nigerian taxes,
  invoices and receipts, cashier shifts, Revenue Guard, night audit, reports,
  owner digest, and offline-safe writes with `Idempotency-Key`
- The guest side (M3): availability-aware marketplace search, signed quotes,
  20-minute holds, online payment or pay at hotel, commission ledger, guest
  accounts with phone OTP, trips and manage-booking links, cancellations and
  refunds, email/SMS/WhatsApp notifications with a dev outbox, verified-stay
  reviews, hotel payout onboarding and a marketplace console
- Growth tier (M4): permissions with custom roles, housekeeping (checklists,
  inspection, assignment, lost and found), maintenance (tickets with SLA,
  room blocks, preventive schedules, diesel log), rate plans, seasons,
  restrictions and promo codes behind one pricing function, corporate
  accounts with a city ledger, WhatsApp templates with real-time owner
  alerts and inbound replies, and a trusted client-IP header for rate limits
- Pro tier (M5): hotel groups with several properties (`X-Property-Id` scope,
  per-property numbering, group reports), point of sale with a kitchen
  display, stock and minibar, a channel manager (iCal and Channex) with
  debounced availability pushes and an overbooking guard, dynamic pricing
  (forecast, pace, Nigerian events, guardrails, suggest or autopilot), a
  guest WhatsApp inbox, a group loyalty programme, and custom domains
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

The database needs three roles:

| role | used for | attributes |
|---|---|---|
| `hotel` | owns the schema, runs migrations and the seed (`DATABASE_MIGRATION_URL`) | owner (superuser locally) |
| `hotel_app` | tenant requests of the running API (`DATABASE_URL`) | `NOSUPERUSER NOBYPASSRLS`, so RLS applies |
| `hotel_platform` | platform console, Paystack webhooks, scheduled jobs (`DATABASE_PLATFORM_URL`) | `NOSUPERUSER NOBYPASSRLS`; access only through policies granted `TO hotel_platform` |

`docker compose` creates all three (see `docker/postgres/init.sql`). On a
database you manage yourself, create `hotel_app` and `hotel_platform` with
`LOGIN` and a password, for example:

```sql
CREATE ROLE hotel_platform LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
```

The migrations create missing roles `NOLOGIN`, so the grants still apply.

### Seed accounts

| who | email | password |
|---|---|---|
| Platform console (Devstrike), SUPER_ADMIN, TOTP secret `DEVSTRIKEADMINTOTPSECRET234567AB`, recovery codes `adm0-0001` ... `adm0-0010` | `admin@devstrike.ng` | `Admin1234!` |
| Console OPERATIONS / SUPPORT / FINANCE / SALES_READONLY (TOTP secrets `DEVSTRIKEOPSTOTPSECRET234567ABCD`, `DEVSTRIKESUPPORTTOTPSECRET234567`, `DEVSTRIKEFINANCETOTPSECRET234567`, `DEVSTRIKESALESTOTPSECRET234567AB`) | `ops@`, `support@`, `finance@`, `sales@devstrike.ng` | `Admin1234!` |
| Pending console invitation (SUPPORT) | `newhire@devstrike.ng`, token `dev-invite-newhire-0001` | set on acceptance |
| Enterprise group, Harmattan Hotels & Suites (dedicated database `hotel_t_harmattan`, white-label, SSO): Abuja `HHA`, Lagos `HHL`, Port Harcourt `HHP` | `owner@harmattanhotels.com` (break-glass owner), `gm@` (manager), `frontdesk.abuja@harmattanhotels.com` | `Demo1234!` |
| Demo group owner, The Palmwine House (Pro, ACTIVE): The Palmwine House (Lekki Phase 1, 24 rooms, prefix `PWH`) and Palmwine House Ikoyi (12 rooms, prefix `PWI`) | `demo@palmwine.ng` | `Demo1234!` |
| Palmwine staff | `tunde@` (manager), `ngozi@` (front desk, morning), `chidinma@` (front desk, evening, Lekki only), `musa@` and `blessing@` (housekeeping), `grace@` (housekeeping supervisor), `emeka@` (maintenance), `seun@` (custom role "Night Auditor"), `funmi@palmwine.ng` (accountant) | `Demo1234!` |
| Palmwine M5 staff | `kelechi@` (front desk, Ikoyi only), `yemi@` (waiter / cashier, Lekki), `bisi@palmwine.ng` (kitchen / bar, Lekki) | `Demo1234!` |
| Growth hotel (every Pro feature locked) | `owner@ekotides.ng` | `Demo1234!` |
| Starter hotel on trial (housekeeping is locked) | `owner@wusegarden.ng` | `Demo1234!` |
| Starter hotel, PAST_DUE | `owner@marinacreek.ng` | `Demo1234!` |
| Demo guest account (platform level) | phone `+2348030000001` (Adaeze Okafor) | sign in with an OTP; read the code from `GET /api/v1/public/dev/outbox` |

Platform sign-in needs a TOTP code: add the secret to any authenticator app,
run `oathtool --totp -b <secret>`, or (development only) call
`GET /api/v1/platform/auth/dev/totp?email=admin@devstrike.ng`.

Harmattan's development API keys (also written to `storage/dev-api-keys.txt`
by the seed): `hk_live_hhchannel1_devHarmattanLiveKeyDoNotUseInProduction1`
(Channel sync) and `hk_test_hhstaging1_devHarmattanTestKeyDoNotUseInProduction1`
(Staging integration, dry-run writes). Its SSO uses the development OIDC
provider (`/api/v1/dev/oidc`, pick any `@harmattanhotels.com` email). The
white-label hosts `book.harmattanhotels.com` and `staff.harmattanhotels.com`
are verified in the seed (send them as `?host=`).

The other marketplace hotels are `ikoyi-lantern` (Pro), `eko-tides` (Growth),
`maitama-court` (Enterprise), `garden-city-lodge` (Growth), `bodija-heights`
(Starter) and `coal-city-retreat` (Growth). Each owner is
`owner@<domain>.ng`; see `prisma/seed-data/hotels.ts`.

Second-key approval PINs (for discounts above the threshold):

| who | PIN |
|---|---|
| `demo@palmwine.ng` (owner) | `2468` |
| `tunde@palmwine.ng` (manager) | `1357` |

**Operations demo data.** The seed rebuilds The Palmwine House's operational
data relative to the day it runs: 48 guests, about 290 stays over the past 30
days with folios, taxes, payments inside cashier shifts, invoices and
receipts, night audit runs, daily statistics and owner digests, a few Revenue
Guard flags (an open shift variance, a voided payment, a late registration and
an acknowledged city-ledger check-out), and a live today: arrivals (assigned,
unassigned and one pending), guests in house, departures still to check out,
four rooms checked out this morning with housekeeping tasks, a day-use stay in
room 107 and Ngozi's open cash shift. Room statuses match the stays. Re-run
`pnpm db:seed` any day to refresh "today". This part deletes and regenerates
the demo hotel's operational rows (the seed temporarily disables the
append-only triggers for that, as superuser); nothing else is touched.

**Guest-side demo data (M3).** Every seed hotel except Wuse Garden Suites
has a (mock) Paystack subaccount, so Wuse shows payout onboarding and takes
pay-at-hotel bookings only. Cancellation policies differ by hotel. Sixty
verified-stay reviews are tied to checked-out stays (several with hotel
replies, two flagged for moderation), and the hotel cards show their real
aggregates. The Palmwine House has online bookings in every state: paid on
the marketplace and on its booking site, pay at hotel, a guest cancellation
with a processed refund and reversed commission, an expired hold, an
orphaned late payment whose refund failed (retry it from the platform
console) and one live hold with about 15 minutes left. The demo guest has
upcoming trips at The Palmwine House and Eko Tides, a completed stay last
week that can still be reviewed, and an older reviewed stay at The Ikoyi
Lantern.

**Growth-tier demo data (M4).** Inspection is on at The Palmwine House.
Today's housekeeping board has tasks in every state (an URGENT checkout clean
for room 208, which has an arrival, a deep clean in progress, a room done and
waiting for Grace's inspection, a rejected deep clean, stayovers including a
Do Not Disturb skip, a suite turndown) and two weeks of inspected cleans for
the reports; checklists per room type and six lost-and-found items. Nine
maintenance tickets (MT-000001...), including the AC in room 106, which is
blocked for two days, and an URGENT generator fault past its SLA; three
preventive schedules and 30 days of diesel logs. Rate plans BAR,
Non-refundable (-10%), Corporate (fixed prices, front desk only) and Long
stay (7+ nights, -15%); seasons Weekend +10% (Friday, Saturday), Detty
December +35% (15 Dec - 5 Jan) and Easter +20%; New Year's Eve overrides, a
three-night minimum over New Year and no arrivals on Christmas Eve. Promo
codes WELCOME10 (active), LAGOSLONG (cheapest night free on 4+), NAIJA20
(used up) and EASTER15 (expired). Corporate accounts Deltaline Oilfield
Services Ltd (close to its credit limit, with a 90+ day invoice), Crestmark
Bank Plc and Hope Bridge Foundation (per-stay invoicing), with city-ledger
invoices in every aging bucket and part payments; two guests in house are
billed to company accounts. Owner WhatsApp alerts are configured (quiet hours
23:30-06:00) with a sent, a deferred, an acknowledged and a test alert. The
owner's phone is `+2348031234567`. Every other hotel gets its BAR plan.

**Pro-tier demo data (M5).** The Palmwine House group is on Pro with a second
property, Palmwine House Ikoyi (`palmwine-house-ikoyi`): three room types, 12
rooms, past, in-house and arriving stays (some top Lekki guests stay in Ikoyi
too), The Terrace outlet. Lekki has POS outlets The Yard, Palm Bar (happy hour
17:00-19:00, 20% off cocktails and beer), Room service and Minibar with a
Nigerian menu (party jollof, ofada and ayamase, suya, peppered snail, asun,
catfish pepper soup, chapman, zobo, Star, Gulder, Hennessy...) and modifiers,
30 days of sales (cash, card, transfer, charges to rooms, voids), open orders
and kitchen tickets in every state today, stock with purchases, a Palm Bar
count short by two bottles of Hennessy (flagged) and minibar par levels. An
Airbnb iCal connection with an import feed and a (mock) Channex connection
mapped to every room type, Booking.com and Expedia stays over the last and next
30 days with commissions, one overbooked Palm Suite night and a sync log.
Dynamic pricing is in SUGGEST mode at Lekki (guardrails, a Burna Boy concert,
an AFCON qualifier, a conference, competitor prices, a frozen wedding date,
pending suggestions for 30 days and a month of accepted changes for the
"what it earned" report) and on AUTOPILOT at Ikoyi. Eight guest conversations
(towels with a pending suggestion, an AC complaint turned into a ticket, a
pre-arrival arrival-time confirmation, one outside the 24-hour window, one
unassigned and overdue, a closed late check-out, an airport pickup, a
breakfast question) and quick replies. The Palmwine Circle programme (Member,
Silver 10+ nights, Gold 25+ nights) with 30 members, earn, redeem, adjust
(one flagged) and expiry history; the demo guest is a Silver member. Lekki's
booking site is on `book.thepalmwinehouse.com` (VERIFIED); Ikoyi's
`stay.palmwineikoyi.com` is PENDING (CNAME missing). Eko Tides stays on
Growth to show the locks.

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
| `pnpm db:migrate:all` | migrate the shared database and every dedicated tenant database (M6) |
| `pnpm db:seed` | idempotent seed (also provisions Harmattan's dedicated database; `SEED_SKIP_DEDICATED=1` to skip) |
| `pnpm db:reset` | drop, re-migrate and re-seed the dev database |
| `pnpm prisma:generate` | regenerate the Prisma client into `src/generated/prisma` |
| `pnpm images:verify` | check that every seed image URL returns HTTP 200 |

---

## Environment

All variables are validated at startup (`src/config/env.schema.ts`). The
process refuses to start and lists every missing or invalid value. An
empty value (`KEY=` as in `.env.example`) means "not set": optional settings
fall back to their defaults, and the code only ever reads validated values
(`skipProcessEnv`), never a raw empty string.

| variable | required | notes |
|---|---|---|
| `APP_NAME`, `APP_DOMAIN`, `SUPPORT_EMAIL` | yes | product identity, returned by `GET /public/app` |
| `PORT` | no (4000) | |
| `NODE_ENV` | no (development) | `production` disables `/billing/dev/confirm` and the mock checkout |
| `DATABASE_URL` | yes | runtime role `hotel_app` |
| `DATABASE_PLATFORM_URL` | yes | cross-tenant role `hotel_platform` |
| `DATABASE_PLATFORM_POOL_MAX` | no (4) | pool size of the platform connection |
| `DB_CONTEXT_SECRET` | yes, min 32 chars | HMAC key that signs the tenant context (installed in the database at start-up; same value on every instance) |
| `GUEST_DATA_KEY` | yes, min 32 chars | AES-256-GCM key material for guest ID numbers (key = SHA-256 of it). Rotating it makes stored numbers unreadable |
| `SHARE_TOKEN_SECRET` | yes, min 32 chars | signs guest share links and ID-image URLs |
| `API_PUBLIC_URL` | no (`http://localhost:4000`) | base of signed file URLs |
| `STORAGE_DRIVER` | no (`local`) | `local` or `s3` |
| `STORAGE_LOCAL_DIR` | no (`./storage`) | directory for `local` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | for `s3` | any S3-compatible service |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_API_BASE_URL` | no | owner digest, guest messages for hotels with `whatsapp_messaging`, WhatsApp OTP; empty = log / dev outbox |
| `WHATSAPP_APP_SECRET` | no | verifies `X-Hub-Signature-256` on `POST /webhooks/whatsapp`; empty = every delivery rejected |
| `WHATSAPP_VERIFY_TOKEN` | no | answers Meta's webhook subscription check (`GET /webhooks/whatsapp`) |
| `WHATSAPP_APPROVED_TEMPLATES` | no | comma-separated template names Meta approved (shown as APPROVED in the admin) |
| `TRUSTED_PROXY_SECRET` | no, min 16 chars when set | shared with the web server: `X-Client-IP` is used for rate limits only with `X-Proxy-Auth` equal to it; empty = off |
| `GUEST_JWT_SECRET` | yes, min 32 chars | guest access tokens (audience `guest`) |
| `GUEST_TOKEN_SECRET` | yes, min 32 chars | quote tokens, manage-booking and review links, magic links, OTP hashes |
| `GUEST_ACCESS_TTL_SECONDS` | no (3600) | guest access token lifetime (refresh tokens: 30 days) |
| `EMAIL_FROM` | no | sender, e.g. `"HotelOS <bookings@hotelos.ng>"` (default `APP_NAME <SUPPORT_EMAIL>`) |
| `RESEND_API_KEY`, `RESEND_BASE_URL` | no | email through Resend (preferred) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | no | email through SMTP (nodemailer) when Resend is not set |
| `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_BASE_URL`, `TERMII_CHANNEL` | no | SMS through Termii |
| `PLATFORM_ALERT_EMAIL` | no | orphaned-payment alerts (default `SUPPORT_EMAIL`) |
| `PUBLIC_RATE_LIMITS` | no (true) | Redis rate limits on public endpoints |
| `DATABASE_MIGRATION_URL` | for migrate/seed | owner role `hotel` |
| `DATABASE_POOL_MAX` | no (10) | pg pool size |
| `REDIS_URL` | yes | BullMQ, rate limits, caches. Query options reach every connection (e.g. `?family=0` on IPv6-only private networks) |
| `JWT_ACCESS_SECRET` | yes, min 32 chars | hotel staff tokens (audience `hotel`) |
| `JWT_PLATFORM_SECRET` | yes, min 32 chars | platform console tokens (audience `platform`) |
| `JWT_REFRESH_SECRET` | yes, min 32 chars | HMAC key for stored refresh-token hashes |
| `JWT_ACCESS_TTL`, `REFRESH_TOKEN_TTL_DAYS` | no (15m, 30) | |
| `PAYSTACK_SECRET_KEY` | no | empty means mock checkout, mock banks and subaccounts, mock refunds (not allowed in production) |
| `PAYSTACK_BASE_URL` | no | defaults to `https://api.paystack.co` |
| `ADMIN_URL`, `WEB_URL` | yes | frontend origins, used for payment callbacks |
| `CORS_ORIGINS` | no | comma-separated; defaults to both local frontends |
| `AUTH_RATE_LIMIT` | no (20) | requests per minute per IP on auth endpoints |
| `CHANNEX_API_KEY` | no; required in production for Channex | empty = in-process mock Channex (development) |
| `CHANNEX_BASE_URL` | no (`https://staging.channex.io/api/v1`) | use `https://app.channex.io/api/v1` in production |
| `CHANNEX_WEBHOOK_SECRET` | no | verifies `X-Channex-Signature` (hex HMAC-SHA256 of the raw body) on `POST /webhooks/channex`; empty = every delivery rejected |
| `ICAL_POLL_MINUTES` | no (15) | minutes between iCal imports of a connection (5-1440) |
| `OUTBOUND_ALLOW_PRIVATE_HOSTS` | no; must be empty in production | development and tests: hostnames (e.g. `localhost`) whose feed URLs may resolve to private addresses |
| `DNS_PROVIDER` | no (`system` in production, else `mock`) | custom-domain checks: `node:dns` or the in-memory mock |
| `CUSTOM_DOMAIN_TARGET` | no (`sites.<APP_DOMAIN>`) | the CNAME target hotels point their domain at |
| `JOBS_ENABLED` | no (true) | `false` starts no BullMQ workers or schedules (dunning, night audit, digest, guard sweep, M4 jobs) |
| `PROCESS_ROLE` | no (`all`) | `all`: HTTP and BullMQ workers in one process; `api`: HTTP only (enqueues and schedules, processes nothing); `worker`: BullMQ processors (still answers `/api/v1/health`). New `@Processor` classes go in `PROCESSORS` in `src/modules/jobs/jobs.module.ts` |
| `SWAGGER_ENABLED` | no (true) | serve `/docs` |

---

## Architecture

```
src/
  main.ts, setup-app.ts        bootstrap: prefix, CORS, helmet, validation, error filter, Swagger
  config/                      zod-validated env + typed AppConfigService
  prisma/                      PrismaService (hotel_app), PlatformPrismaService (hotel_platform), DbService
  common/                      error envelope, decorators, AuthGuard, RolesGuard
  modules/
    health, public             anonymous endpoints
    auth, me                   staff auth and session info
    entitlements               plan + override computation, feature/limit/subscription guards
    audit                      append-only audit trail + GET /audit-logs
    dashboard, property, room-types, rooms, staff, housekeeping
    billing                    subscription, invoices, checkout, Paystack webhook, dunning logic
    jobs                       BullMQ queues, processors and schedules (dunning, night audit, digest, sweeps)
    platform                   Devstrike console: auth, metrics, tenants, overrides, plans
    guest-side.module.ts       M3 wiring (global):
      booking                  search availability, quotes, bookings, holds, Paystack payments,
                               refunds, cancellations, commission ledger, trips, payouts,
                               booking settings, online feed, marketplace console
      guest-auth               platform-level guest accounts: OTP, magic links, refresh, trips list
      reviews                  verified-stay reviews, replies, moderation, aggregates
      notifications            NotificationService, providers, dev outbox, email/SMS templates
      infra                    Redis client, rate limits, jobs bridge
    operations.module.ts       M2 wiring (global):
      reservations             bookings, availability, tape chart, check-in/out, room moves
      guests                   guest records, ID encryption and images, register, NDPA
      folios, invoices         ledger, taxes, discounts, payments, voids; invoices, receipts, share links
      shifts                   cashier shifts with blind close
      guard                    Revenue Guard rules, flags, sweep
      night-audit, reports     nightly posting and snapshots; daily flash and range reports
      digest                   owner digest and delivery providers
      front-desk, housekeeping today's board; cleaning tasks
      idempotency              Idempotency-Key interceptor
      storage                  object storage (local disk or S3-compatible)
      ops                      shared helpers, approval PIN, cross-tenant job helpers
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

Every tenant-scoped table has a `tenant_id` column: `properties`,
`room_types`, `rooms`, `users`, `refresh_tokens`, `tenant_feature_overrides`,
`subscriptions`, `invoices`, `audit_logs`, and in M2 `guests`,
`reservations`, `folios`, `folio_entries`, `document_counters`,
`guest_invoices`, `receipts`, `tax_settings`, `digest_settings`,
`cashier_shifts`, `guard_flags`, `owner_digests`, `night_audit_runs`,
`daily_stats`, `housekeeping_tasks` and `idempotency_keys`, and in M3
`booking_payments`, `booking_refunds`, `commission_entries`,
`payout_accounts`, `reviews` and `notification_logs` (rows without a tenant,
such as OTP messages, match no tenant policy). `tenants` is keyed
by its own `id`. All of them have `ENABLE` and `FORCE ROW LEVEL SECURITY`. The
current policies come from
`prisma/migrations/*_platform_role_signed_context` (which replaced the M1
policies of `*_rls_grants_audit`).

### Setting the tenant per request (signed context)

The API connects as `hotel_app`, which has neither `SUPERUSER` nor
`BYPASSRLS`. All data access goes through `DbService`
(`src/prisma/db.service.ts`):

```ts
await this.db.tenant(user.tenantId, async (tx) => {
  // first statement inside the transaction, added by DbService:
  //   SELECT set_config('app.tenant_id', $1, true),
  //          set_config('app.context_sig', hex(HMAC-SHA256(DB_CONTEXT_SECRET, 'tenant:' || $1)), true)
  return tx.room.findMany({ ... });
});
```

- The settings are **transaction-local** (third argument `true`), so Postgres
  discards them at COMMIT or ROLLBACK. They cannot leak to the next request
  that reuses a pooled connection.
- The policies accept the tenant id only if the signature verifies:

  ```sql
  CREATE POLICY tenant_isolation ON rooms FOR ALL TO hotel_app
    USING      (tenant_id = (SELECT app_current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));
  ```

  `app_current_tenant_id()` is a `SECURITY DEFINER` function that recomputes
  the HMAC with a key kept in the private schema `app_private`, which
  `hotel_app` cannot read. Knowing another tenant's uuid is not enough, and no
  other GUC changes anything. The scalar sub-select makes Postgres evaluate
  the check once per query (an InitPlan), not once per row.
- The key is `DB_CONTEXT_SECRET`. The API installs it at start-up through
  `app_install_context_key()`, which only `hotel_platform` may execute.
- The tenant id comes only from the verified JWT (`req.user.tenantId`), or
  from a token this API signed itself (guest share links). It is checked to be
  a UUID before use.
- Queries outside a `DbService` context fail closed: every tenant table looks
  empty and every write fails its `WITH CHECK`.
- Services still add `where: { tenantId }` to their queries. RLS is the
  backstop that holds even when a query forgets the filter.
- A mutation, its audit entry and any Revenue Guard flag it raises run in the
  same transaction, so they commit together or not at all.

### Deliberate cross-tenant paths

| path | mechanism | what it can do |
|---|---|---|
| Public marketplace (`/public/*`) | `db.public()`: signed `public` context on `hotel_app` | **SELECT only** on `tenants`, `properties`, `room_types`, `rooms` and `subscriptions`. No policy exposes staff, tokens, invoices, audit, guests or folios to it. |
| Login and refresh-token lookup | `SECURITY DEFINER` functions `app_auth_find_user(email)` and `app_auth_find_refresh_token(hash)` | Return the single row that matches an exact email or token hash. |
| Signup | none needed | The new tenant id is generated first and used as the (signed) tenant context. |
| Platform console, Paystack webhooks, dunning, tenant enumeration for scheduled jobs | `db.system()`: a transaction on the **second Prisma client** connected as `hotel_platform` | Full access through `platform_access` policies granted `TO hotel_platform`. No GUC is involved. Audit with `grep -rn "\.system(" src`. Per-tenant job work (night audit posting, digests, sweeps) still runs in a signed tenant context on `hotel_app`. |
| Online bookings (quote, book, availability of one hotel) | the hotel is looked up by slug in the public context; the rest runs in **that hotel's signed tenant context** on `hotel_app` | The tenant id comes from our own lookup (or from a quote token this API signed), never from the request. |
| Marketplace search with dates | `app_public_room_type_peaks(property_ids, start, end)`, `SECURITY DEFINER`, answers only inside the signed public context | Returns peak counts per room type; no guest, code or date leaves the database. |
| Manage-booking links, review links | signed stateless tokens (`GUEST_TOKEN_SECRET`) carrying tenant + reservation | Each call runs in that tenant's signed context. A token opens only its own booking (the code must match). |
| Guest identity (`guest_accounts`, `guest_otp_challenges`, `guest_refresh_tokens`) and the cross-hotel trip list | `db.system()` only; `hotel_app` has **no grants** on these tables | Trips are read with a query filtered to the signed-in account (bookings made while signed in, or guest records carrying the verified phone). |
| Published reviews | `public_read` policy on `reviews` (`status IN ('PUBLISHED','FLAGGED')`) and on `tax_settings` | SELECT only. |

This replaces the M1 design, where `hotel_app` could switch itself into a
`system` context by setting `app.context`. The e2e suite
(`test/m2-security.e2e-spec.ts`) connects as `hotel_app`, sets every `app.*`
setting it likes (including a real signature for tenant A reused with tenant
B's id), and proves it still sees no other tenant, cannot read or replace
the key, cannot write the plan catalogue and cannot read platform tables.

### Grants and append-only audit

- `hotel_app` and `hotel_platform` get explicit per-table grants. No default privileges are set,
  so a new table stays invisible to the API until a migration grants it
  (and enables RLS if it is tenant-scoped).
- `folio_entries`, `guest_invoices` and `receipts` are append-only in the same
  way (triggers for every role, and only `SELECT, INSERT` granted).
- `audit_logs`: `hotel_app` has only `SELECT` and `INSERT`. Triggers raise
  an error on `UPDATE`, `DELETE` and `TRUNCATE` for every role, including the
  owner. Staff deletion is a hard delete, while audit rows keep the actor's
  id and a snapshot of their name (with no foreign key), so history survives.

The e2e suites (`test/tenant-isolation.e2e-spec.ts`,
`test/m2-security.e2e-spec.ts`) check all of this over the API and directly in
SQL as `hotel_app` and `hotel_platform`.

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

## Hotel operations (M2)

The full request and response contract is in Swagger and in the M2 API
document shared with the admin app. This section explains the rules.

### Reservations and availability

- A stay is `NIGHTLY` (arrival at the property's check-in time, departure at
  its check-out time, Lagos) or `DAY_USE` (exact hours, 2 to 12, needs the
  `hourly_bookings` feature and a room type with an hourly rate). The rate is
  snapshotted on the reservation.
- **No double booking, enforced by Postgres:**

  ```sql
  ALTER TABLE reservations ADD CONSTRAINT reservations_no_overlap
    EXCLUDE USING gist (room_id WITH =, tstzrange(arrival_at, departure_at, '[)') WITH &&)
    WHERE (room_id IS NOT NULL AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN'));
  ```

  `[)` lets a 12:00 departure and a 12:00 arrival share a room.
- Stays without a room are counted against the room type. Inside the booking
  transaction the API takes `pg_advisory_xact_lock(hash(tenant, room type))`
  and checks that the peak number of overlapping active stays plus the new one
  fits the sellable rooms (all rooms of the type that are not OUT_OF_ORDER).
  Peak concurrency (not "anything overlapping") is the right test: interval
  graphs are perfect, so if the peak fits, a room assignment exists.
- Moving, extending or shortening a stay re-runs the same checks. Early
  check-out moves the departure to now; early check-in moves the arrival.
- Availability is per hotel night: night D is `[D check-in, D+1 check-out)`.
- Room picker (`GET /availability/rooms`): `free` means no active stay overlaps
  the window, which is right for future bookings (a room whose guest leaves
  in the morning is free tonight). For a check-in now, pass `forCheckIn=true`:
  the window starts now, so a room with a guest still checked in is not free
  even if they leave later today. `checkInReady` (free, clean, nobody in it
  now) and `reason` (OUT_OF_ORDER, OCCUPIED, BOOKED, DIRTY) tell the desk
  which rooms can take the guest.

### Check-in and check-out

- Check-in needs an assigned room that is VACANT_CLEAN (or RESERVED). A dirty
  room needs a manager override with a reason (audited, `DIRTY_OVERRIDE_CHECKIN`
  flag). The register card (arriving from, going to, purpose, and an ID type
  and number on the guest) must be complete unless the desk explicitly chooses
  `registerLater` (then `LATE_REGISTRATION` fires after an hour). Check-in
  sets the room OCCUPIED and posts the first night (or the day-use block).
- Check-out needs a zero balance. A manager may move a positive balance to the
  city ledger (posted as a CITY_LEDGER payment, `CHECKOUT_WITH_BALANCE` flag).
  The room becomes VACANT_DIRTY with a housekeeping task (when the plan has
  `housekeeping`), the folio closes and the FINAL invoice is issued.

### Money and tax model

- All money is integer kobo (`BIGINT` in the database, numbers in JSON).
  Rates and thresholds are basis points (750 = 7.5%).
- `TaxSetting` per property: VAT 7.5% (on), consumption tax (for example Lagos
  5%, off by default), service charge (off), each with an `inclusive` flag,
  and the discount approval threshold (10%).
- Every component is computed on the **net** amount (no tax on tax):

  ```
  net        = entered / (1 + sum of inclusive rates)
  tax_i      = round(net * rate_i)
  net line   = entered - sum(inclusive taxes)   (absorbs the rounding, so the sum is exact)
  exclusive  = added on top of the entered amount
  ```

  Rounding is half away from zero, so a discount mirrors a charge exactly.
  Each charge posts one ROOM / DAY_USE / EXTRA line plus one TAX or
  SERVICE_CHARGE line per component, each with the rate snapshot and a
  `parentEntryId`. Changing the settings affects future entries only.
- The folio is a ledger of **immutable** `FolioEntry` rows (a trigger blocks
  UPDATE and DELETE). Charges are positive, payments and discounts negative.
  The balance is the sum. Corrections are VOID entries (manager, with a reason)
  that mirror the voided line and its tax lines; `ref_entry_id` is unique, so
  nothing can be voided twice.
- Discounts (amount or percent) apply to one charge or to the whole folio and
  carry negative tax lines. Above the threshold, plans with
  `revenue_guard_full` need a second key: an active manager or owner picks
  themselves and enters their 4 to 6 digit PIN (argon2-hashed, five wrong
  tries lock it for 15 minutes; failed tries are counted even though the
  discount is refused). Plans without it accept the discount and raise
  `DISCOUNT_OVER_THRESHOLD`.
- Invoices `INV-2026-000123` and receipts `RCT-2026-000456` are numbered per
  hotel per Lagos year from a counter row incremented with
  `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` inside the issuing
  transaction. The row lock queues concurrent issuers and a rollback returns
  the number, so the sequence has no gaps. Proformas use their own series.
  The printable document is snapshotted at issue time.
- Share links are stateless HMAC tokens (`SHARE_TOKEN_SECRET`) with an expiry;
  `GET /public/documents/:token` serves the document to the guest.

### Payments and cashier shifts

- Cash, transfer and POS payments must belong to the recording user's OPEN
  shift (`409 SHIFT_REQUIRED`). One open shift per user (partial unique index).
- Closing is **blind**: while a shift is open, front-desk users never see its
  expected totals or payments. The close takes the counted cash (with note
  denominations), POS and transfer totals and returns the variance. Any method
  more than ₦500 out raises `SHIFT_VARIANCE` (HIGH above ₦5,000). A manager
  approves closed shifts (not their own).

### Revenue Guard

| rule | tier | raised when |
|---|---|---|
| SHIFT_VARIANCE | basic | shift closes more than ₦500 out on any method |
| VOIDED_PAYMENT | basic | a payment is voided |
| CHECKOUT_WITH_BALANCE | basic | check-out by city-ledger override |
| DISCOUNT_OVER_THRESHOLD | full (fallback on basic) | discount above the threshold without a second key |
| OCCUPIED_WITHOUT_STAY | full | a room is OCCUPIED, or recently turned dirty, with no checked-in stay or check-out behind it |
| DIRTY_OVERRIDE_CHECKIN | full | check-in to a dirty room by override |
| DAY_USE_OVERSTAY | full | a day-use guest is still in 30 minutes after the booked end (suggests converting to a night) |
| LATE_REGISTRATION | full | checked in over an hour without a complete register |
| REPEATED_VOIDS_BY_USER | full | one user posts three or more voids in 24 hours |
| ROOM_STATUS_FLIP | full | a room is set from OCCUPIED to dirty by hand without a check-out |

Event rules run inside the transaction of the action that triggers them. The
time and state rules run in an hourly BullMQ sweep and in the night audit.
Each flag has a dedupe key with a partial unique index over live flags, so
sweeps never duplicate. Locked rules are skipped (and shown as locked by
`GET /guard/rules`).

### Night audit, reports and the owner digest

- **Night audit** (BullMQ, 02:00 Africa/Lagos, per tenant, for yesterday):
  posts the night's room charge and taxes for each in-house nightly stay (the
  first night is posted at check-in, and a night already charged is skipped),
  marks unarrived PENDING/CONFIRMED stays as NO_SHOW, runs the guard sweep and
  snapshots `DailyStat`. A `night_audit_runs` row per (tenant, business date)
  makes it idempotent; a failed run can be retried and a stuck one is taken
  over after 15 minutes. `POST /night-audit/run` runs it on demand.
- **Reports.** Occupancy comes from the stays: `roomsSold` for night D counts
  nightly stays checked in or out with arrival date <= D < departure date, so
  tonight's guests count before the night audit posts their charge. Money
  comes from the ledger (voided lines excluded): `roomNightsPosted` and
  `roomRevenuePostedKobo` are the posted room charges, ADR is posted revenue
  per posted night, RevPAR is posted revenue per available room; plus revenue
  by type, taxes, payments by method, day use, arrivals, departures, no-shows.
  Where a night-audit snapshot exists, the daily flash uses it.
- Text meant for people (folio lines, digests, flag details) uses Lagos dates
  such as `Tue 22 Sep 2026`; machine fields stay ISO.
- **Owner digest** (`owner_whatsapp_alerts`, 23:00 Lagos): rooms sold,
  occupancy, day use, revenue and money received by method, and the top three
  open flags. Delivery goes through a `DigestProvider`: WhatsApp Cloud API when
  `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are set (note: WhatsApp requires an
  approved template outside the 24-hour service window), otherwise it is
  logged. Every digest is stored and listed in the admin app.

### Guests and NDPA

- Guests are deduplicated by phone (normalised to E.164, Nigerian local
  formats accepted). ID numbers are encrypted with AES-256-GCM (random IV,
  tenant id as associated data) and only the last four digits are kept in
  clear for masking (`••••••4821`). The full number is shown only through an
  audited reveal or a manager's register export.
- ID images go to object storage (`STORAGE_DRIVER=local` or `s3`) and are
  served through signed URLs that expire after ten minutes. Uploads are checked
  by type, size (5 MB) and file signature.
- The guest register (police / security book) exports as JSON or CSV for a
  date range (CSV cells are protected against formula injection).
- NDPA: `GET /guests/:id/export` returns everything held about a guest;
  `POST /guests/:id/anonymise` wipes personal data (name, contacts, ID, image,
  register answers) but keeps reservations, folios and invoices. Both are
  audited.

### Offline front desk: Idempotency-Key and clientCreatedAt

- Any mutating hotel request may carry `Idempotency-Key`. The interceptor
  reserves `(tenant, key)` with a fingerprint of method, path and body in its
  own committed transaction (a concurrent duplicate gets
  `409 IDEMPOTENCY_IN_PROGRESS`), then runs the handler inside an
  AsyncLocalStorage context. Every business transaction of that request that
  writes data sets `applied = true` on the key row as its last statement
  (`DbService.tenant`, guarded by `txid_current_if_assigned()`), so the writes
  and the "used" mark commit atomically. A 2xx response is then stored for 72
  hours and replayed verbatim with `Idempotent-Replayed: true`; the same key
  with a different request gets `422 IDEMPOTENCY_CONFLICT`.
- If the request fails and nothing was applied, the key is released so the
  outbox can retry after fixing the cause. If the process dies after the
  writes committed but before the response was stored, the key stays applied
  and retries get `409` with `details.applied = true`: the action is never
  applied twice, and the client reconciles by reading the resource. An
  unapplied reservation older than two minutes is treated as abandoned and a
  retry takes it over. Expired keys are purged hourly.
- Offline-queued actions send `clientCreatedAt` (at most 72 hours old). It is
  stored on the reservation or folio entries and in the audit metadata, so
  the audit trail shows when things really happened at the desk.

### Roles

M4 replaced these role checks with permissions (see "Permissions and custom
roles" below); the built-in roles keep the M2 boundaries:

| area | OWNER / MANAGER | FRONT_DESK | ACCOUNTANT | HOUSEKEEPING |
|---|---|---|---|---|
| reservations, availability, tape chart | all | all (no custom rate) | read | - |
| guests, register | all, NDPA export and anonymise, register with full IDs | create, edit, reveal ID, masked register | read | - |
| check-in / check-out | all, overrides | all, no overrides | - | - |
| folios | all, voids, refunds, complimentary / online card / city ledger | charges, own-shift payments, discounts up to the threshold | read | - |
| invoices, receipts, share links | all | all | all | - |
| shifts | own; read and close any; approve others | own | read | - |
| Revenue Guard | read and triage | - | read | - |
| reports, night audit, digests | all | today's board | read | - |
| room status | any | any | - | dirty to clean only |

## The guest side (M3)

The request and response contract is in Swagger and in the M3 API document
shared with the web and admin apps. This section explains the rules.

### Channels and commission

- A booking made on the marketplace has source `MARKETPLACE` and pays the
  plan's `commissionBps` (snapshotted on the reservation). A booking on the
  hotel's own site (`/h/:slug`, subdomain, custom domain) has source
  `BOOKING_SITE` and pays nothing. The web app sends the channel; the API
  checks it (marketplace bookings need a listed hotel).
- Commission is charged on the room + tax total. Paid online, it is taken by
  the Paystack split (`transaction_charge`) and recorded as `COLLECTED`; pay
  at hotel on the marketplace records it as `ACCRUED` (a receivable the
  platform invoices monthly and settles in the console). Refunds, guest and
  hotel cancellations and no-shows add `REVERSED` entries (in proportion to
  the refund). The ledger (`commission_entries`) is append-only for the API.

### Quotes, holds and availability

```
web                         API                                           Paystack
 | GET  /public/hotels?checkIn&checkOut   (peaks per room type, public context)
 | POST /public/quotes ------> price like the folio will post it, signed 15 min
 | POST /public/bookings ----> PENDING stay, holdExpiresAt = now + 20 min
 |                             (advisory lock + peak check, like any M2 stay)
 |                             POST /transaction/initialize --------------> subaccount,
 |<------ authorizationUrl --- (metadata kind=booking)                       transaction_charge,
 | guest pays ------------------------------------------------------------> bearer=subaccount
 |                             <------------- POST /billing/webhooks/paystack  charge.success
 |                             confirm, CARD_ONLINE payment + receipt,
 |                             COLLECTED commission, notifications
 | GET /public/payments/:ref/verify (also verifies with Paystack; idempotent)
```

- The quote freezes the rate and the tax components in the token, so the
  booking charges exactly what the guest saw. Each night is priced through
  the M2 tax model, so the quote equals what check-in and the night audit
  post.
- An online booking holds inventory as a `PENDING` reservation for 20
  minutes, under the same capacity lock and exclusion constraint as desk
  bookings: two guests racing for the last room get one `201` and one
  `409 ROOM_UNAVAILABLE`. A BullMQ delayed job at the expiry time (plus a
  one-minute sweep) cancels unpaid holds with reason `HOLD_EXPIRED`, after
  asking Paystack once more in case the webhook is late.
- Pay at hotel confirms at once (`guaranteeType NONE`).
- Retrying `POST /public/bookings` with the same quote returns the same
  booking (`Idempotent-Replayed: true`).

### Payments, webhook and orphaned payments

- The webhook (source of truth), the callback verification and the dev mock
  confirm share one code path. It locks the payment row and then the
  reservation, so whichever arrives first applies the payment and the others
  are no-ops; the webhook ledger (`payment_events`) also drops replays.
- A payment that cannot be applied is **orphaned** and refunded in full
  through `POST /refund`: late after the hold expired and the room has gone
  (a late payment while the room is still free revives the booking instead),
  amount lower than the booking total, booking already cancelled, or a
  second attempt paid after the first. The guest, the hotel and the platform
  are told, and Revenue Guard raises `PAYMENT_ORPHANED`.
- Refunds are sent after the business transaction commits; `refund.*`
  webhooks finish them. A failed refund never undoes the cancellation: it
  shows as FAILED in the platform console, which can retry it.

### Cancellations

- Per-hotel policy: free until `freeCancellationHours` (48) before check-in;
  after that `lateCancellationFeePct` (100) of the first night (room + its
  taxes) is kept. The folio gets an untaxed `Cancellation fee` line and a
  `REFUND` line (method `CARD_ONLINE`), so it balances to zero.
- A hotel cancelling a paid booking always refunds in full.

### Guest accounts and trips

- One account per phone number, at platform level. Six-digit OTP by SMS or
  WhatsApp, valid 5 minutes, stored as an HMAC bound to the challenge; five
  wrong codes burn the challenge and lock the number for 15 minutes; one
  code per minute and five per hour per number. Email magic links are the
  fallback for accounts with an email. Guest JWTs use their own secret and
  audience; refresh tokens rotate with reuse detection, like staff tokens.
- A verified phone links every hotel's guest record with that number to the
  account, so earlier bookings appear in Trips.
- Without an account, the confirmation carries a signed manage-booking link
  (`/trips/:code?t=`), valid until 90 days after departure: view, cancel
  (with a fee preview), calendar file, invoice and receipts, review link.

### Notifications

- Every message is a `notification_logs` row delivered through BullMQ (five
  attempts, exponential backoff); without workers it is delivered inline.
  OTP codes and magic links are sent immediately and logged redacted.
- Providers: Resend or SMTP for email, Termii for SMS, WhatsApp Cloud API
  (guest SMS go over WhatsApp for hotels with `whatsapp_messaging`). With no
  provider in development, messages land in the **dev outbox** (Redis, last
  50): `GET /api/v1/public/dev/outbox` shows them, including OTP codes, for
  the web app's dev mailbox. The outbox and the dev payment confirm answer
  404 in production.
- Templates: booking confirmed, payment receipt, pay-at-hotel confirmed,
  hold expired, cancellation and refund, pre-arrival (24 h before), review
  request (4 h after check-out), orphaned-payment refund, OTP, magic link,
  and the hotel and platform alerts. Emails are table-based HTML with inline
  CSS in the brand system (Fraunces with a Georgia fallback, laterite
  accent, hairlines, dark-mode block), with a plain-text part; booking-site
  mail carries the hotel's name, logo and accent. SMS stay within 160
  characters where possible and write naira as `N` (GSM-7).

### Reviews

- A signed link per checked-out stay allows one review within 30 days
  (overall and four subscores, traveller type, 20 to 2000 characters). The
  public name is first name + last initial. Text with a phone number or email
  is held as FLAGGED. Aggregates live on the property and are recomputed in
  the transaction of every change.
- Hotels reply once (editable) and can report a review; they cannot hide or
  delete one. Platform moderators hide or restore with a reason.

### Payouts

- Owners pick a bank (`GET /payouts/banks`, Paystack list cached 24 h),
  resolve the account name and save it: the API creates (or updates) the
  Paystack subaccount with `percentage_charge: 0`, stores the account number
  encrypted (last four in clear) and marks the property `payoutReady`.
  Without a subaccount a hotel takes pay-at-hotel bookings only.

### Rate limits

Redis fixed windows per IP on search, availability, quotes, bookings,
payment verification, trip cancellation and reviews, plus per phone / email
on bookings, OTP and magic links. Over the limit: `429 RATE_LIMITED` with
`details.retryAfterSec` and a `Retry-After` header.

---

## Growth tier (M4)

### Permissions and custom roles

Every staff route checks a permission (`@RequirePermission('folio.void')`),
not a role. The catalogue (`GET /permissions`, `src/common/permissions/catalogue.ts`)
groups about fifty codes; the built-in roles are OWNER (everything), MANAGER
(everything except `payouts.manage`), FRONT_DESK, ACCOUNTANT, HOUSEKEEPING,
SUPERVISOR (assigns and inspects) and MAINTENANCE. Hotels with `custom_roles`
create their own (`/roles`, cloned from any role). The `PermissionGuard`
reloads the user's role and active flag on every request, so a changed role
applies at once and a deactivated user gets 401. Nobody can grant a
permission they do not hold, edit a role or a person who holds more than
they do, or make an owner unless they are one (`PERMISSION_ESCALATION`,
`403`). `GET /me` returns `permissions[]`; denials are `403 FORBIDDEN` with
`details.permission`. Audit export (`GET /audit-logs/export`) needs
`audit_export`.

### Housekeeping

Check-out (and room moves) open a CHECKOUT_CLEAN task, URGENT while an
arrival waits for the room; every N check-outs (per room type) it is a
DEEP_CLEAN. A 07:00 job opens one STAYOVER per occupied room per day. Tasks
carry a checklist snapshot (templates per room type and task type), photos
and the assignee; `GET /housekeeping/assignments/suggest` balances minutes
across housekeepers keeping floors together. With `requireInspection` on, a
finished turn keeps the room VACANT_DIRTY until a supervisor passes it
(`INSPECTION_REQUIRED` for anyone who only cleans); a failed inspection
sends the task back at HIGH priority. Task creation on check-out runs under a
savepoint, so a housekeeping problem never fails the check-out. Every write
accepts `Idempotency-Key` and `clientCreatedAt` for the offline phone view.
Lost and found lives at `/lost-found`. Revenue Guard room flags carry the
room's housekeeping timeline as evidence.

### Maintenance and room blocks

Tickets (`MT-000123`) have an SLA by priority (URGENT 4 h, HIGH 24 h, NORMAL
72 h, LOW 7 days), an event log, photos, costs and vendors. A `RoomBlock`
takes a room out of order for a window; availability, desk bookings, public
quotes, marketplace search (through the `app_public_unsellable_rooms`
function) and the tape chart exclude every night the block overlaps.
Blocking over an assigned stay is `409 BLOCK_CONFLICT` unless forced (future
stays are unassigned). An hourly job moves rooms in and out of OUT_OF_ORDER as
blocks start and end; resolving the ticket releases its block and opens a
cleaning task. Preventive schedules raise tickets when due (06:00 job), and
the diesel log feeds consumption and cost reports.

### Rates, restrictions and promo codes

`RatesService.resolveNightlyRates` is the one pricing function, used by desk
reservations, `POST /rates/quote`, public availability, quotes, search and
the price calendar, and the night audit. Per night: a date override, else the
highest-priority season rule matching the date and weekday, else the base
price, then the plan (BAR, a derived percent or amount, or fixed prices per
room type), rounded to whole naira. Reservations snapshot their per-night
prices at booking (`nightlyRates`), and the night audit posts each night at
its own price. Restrictions (stop-sell, closed to arrival or departure,
minimum stay) are enforced online (`STAY_RESTRICTED`) and returned as
warnings at the desk. Promo codes (percent, amount, free night) are checked
at quote time and again at booking, held while an online booking waits for
payment, confirmed on payment and released on expiry, cancellation or
no-show; each promo night posts a `DISCOUNT` line "Promo CODE" with mirrored
tax lines. Without `promotions` every stay is priced at BAR.

### Corporate accounts and the city ledger

Accounts have a credit limit, payment terms, a negotiated plan and a billing
cycle. `POST /reservations/:id/check-out` with `cityLedger: true` posts the
balance to the account within the credit limit (`409 CREDIT_LIMIT_EXCEEDED`
otherwise, unless `frontdesk.override`). Per-stay accounts get an invoice at
once; monthly accounts get statements (`CL-2026-000012`, gapless per year) on
the 1st at 06:00. Payments are allocated oldest invoice first; aging buckets
are 0-30, 31-60, 61-90 and 90+ days from issue. A daily 09:00 job reminds at
1, 15 and 30 days overdue.

### WhatsApp: templates, owner alerts, replies

Every business-initiated WhatsApp message uses a template from
`src/modules/whatsapp/templates.registry.ts`; `docs/whatsapp-templates.md`
is the exact text to submit to Meta (a unit test keeps the two in step).
Free-form text is used only inside the 24-hour window after the recipient
wrote to us. A HIGH Revenue Guard flag queues an owner alert: flags within
the debounce window (3 minutes) go out together, alerts during quiet hours
(23:30-06:00 Lagos) wait until they end unless the rule or amount is urgent.
Owners and managers reply `1` to acknowledge the latest alert's flags or
`DIGEST` for today's figures through `POST /webhooks/whatsapp` (signature
checked with `WHATSAPP_APP_SECRET`, duplicates ignored by message id).
Settings: `GET|PUT /notification-settings`; log: `GET /guard/alerts`.

### Trusted client IP

The web server calls the API from one socket IP for many visitors, so it
sends the visitor's IP in `X-Client-IP` with `X-Proxy-Auth` =
`TRUSTED_PROXY_SECRET`. Rate limits (public Redis limits and the auth
throttler) use `X-Client-IP` only when the secret matches (constant-time
compare) and the value is a valid IP; otherwise the socket IP. A spoofed
header from a browser changes nothing. Audit `ip` fields are unchanged.

### Scheduled jobs (Africa/Lagos)

| job | when |
|---|---|
| dunning | 02:00 |
| night audit | 02:00 |
| owner digest | 23:00 |
| Revenue Guard sweep | hourly at :05 |
| idempotency key purge | hourly at :35 |
| stayover cleaning tasks | 07:00 |
| preventive maintenance tickets | 06:00 |
| room blocks start / end | hourly at :01 |
| owner alerts due | every minute |
| city ledger statements | 1st of the month, 06:00 |
| city ledger overdue reminders | 09:00 |
| channel manager: push pending availability and rates (debounced 30 s) | every minute |
| channel manager: safety sweep of the whole horizon (diffed) | every 15 minutes |
| iCal imports (each connection every `ICAL_POLL_MINUTES`) | checked every 5 minutes |
| dynamic pricing run (SUGGEST / AUTOPILOT properties) | 03:00 |
| autopilot pace-spike check | every 10 minutes |
| loyalty expiry and tier recalculation | 04:00 |
| custom domain checks (PENDING; VERIFIED daily) | every 10 minutes |

---

## Pro tier (M5)

The contract is `API-M5.md` (shared with the admin and web apps). Every M5
table carries `tenant_id` and is under row-level security like the rest.

### Property scope

A tenant is a hotel group; each operational row also carries `property_id`.
Staff requests run in one current property: the `X-Property-Id` header, else
the user's default, else the first property they may open. The
`PermissionGuard` checks it against the user's access (`allProperties` or
`user_property_access`; owners always see every property) and answers
`403 PROPERTY_ACCESS_DENIED` otherwise; responses echo `X-Property-Id`.

The scope lives in an AsyncLocalStorage store (`src/common/property-scope.ts`).
`DbService.tenant()` runs on a Prisma client extension that adds
`AND property_id IN (scope)` to every read, update and delete of a
property-scoped model and refuses creates for another property, so a query that
forgets its filter still cannot cross properties (the same belt-and-braces idea
as RLS for tenants). An id from another property is a 404, never a 403. Group
work (group reports, loyalty) lifts the filter explicitly
(`withAllProperties`, `withProperties`). Jobs (night audit, digests, guard
sweep, stayovers, preventive maintenance, room blocks, pricing) loop per
property. Invoice, proforma, receipt, POS order and kitchen ticket numbers are
per property; a property prefix gives `INV-PWH-2026-000123`. Guests, staff,
corporate accounts, promo codes (with optional `propertyIds`) and loyalty are
group-wide. `POST /properties` is limited by `max_properties` (Pro: 3).
Stay lifecycle hooks (`src/common/stay-hooks.ts`) let the inbox and loyalty
react to check-in, check-out, cancellations and folio voids without the
reservations module depending on them.

### Point of sale

Outlets (restaurant, bar, room service, minibar...), categories with a kitchen
or bar station, items with modifiers, stock links and happy-hour price rules.
Orders are sent to the kitchen display as one ticket per station
(NEW -> PREPARING -> READY -> SERVED, polled with `?since=`). Settlement uses
the M2 ledger: cash, transfer or card need the waiter's open shift and post to
a POS folio with receipts; a room charge posts the sale to the guest's folio
after a surname check (a manager override raises `ROOM_CHARGE_NO_GUEST`); a
city-ledger charge goes to a corporate account. Totals are computed exactly as
the ledger posts them (`orderTotals`). Voids after sending raise
`POS_VOID_AFTER_SEND` (second key above the property's limit), sending deducts
linked stock, counts compute variance (`STOCK_VARIANCE`), and a shift that
closes with open tabs raises `POS_OPEN_TABS_AT_SHIFT_CLOSE`.

### Channel manager

Two providers behind one interface (`src/modules/channels/channel-provider.ts`):

- **iCal** for Airbnb, VRBO and similar: signed export URLs per room and room
  type (`/public/ical/:token.ics`, blocked nights only, rotatable) and import
  feeds polled every `ICAL_POLL_MINUTES`. Events that vanish from a feed cancel
  their reservation.
  Feed URLs are user input, so they are fetched under an SSRF guard
  (`src/common/net/safe-fetch.ts`), checked when the feed is added and again on
  every fetch: https only in production; the hostname is resolved and every
  address must be public (loopback, private, link-local including
  169.254.169.254, CGNAT, multicast, reserved and documentation ranges are
  refused for IPv4 and IPv6, and IPv4 inside mapped, NAT64 and 6to4 IPv6
  addresses is checked too); the socket is pinned to the vetted address so a
  second DNS answer cannot rebind it; each redirect is re-checked (at most 3);
  responses are capped at 2 MB and 10 s and must be `text/calendar` or
  `text/plain`. It is the only server-side fetch of a user-supplied URL (image
  and logo URLs are stored and served to browsers, never fetched by the API;
  payment, messaging and Channex calls go to configured hosts).
- **Channex** (Booking.com, Expedia, Agoda...): room types and rate plans are
  mapped to Channex; availability, the price from `resolveNightlyRates` and
  restrictions are pushed. Anything that changes availability or rates (the
  audit trail knows every such write) marks the connection dirty; a job pushes
  after 30 s of quiet, and only values that changed since the last push (a
  hash per room type, rate plan and night). Bookings arrive on
  `POST /webhooks/channex` (HMAC-SHA256 signature over the raw body); the API
  fetches and acknowledges the revision. Without `CHANNEX_API_KEY` a mock
  provider stands in (development only), with a dev endpoint that delivers a
  signed booking webhook.

OTA reservations keep `otaChannel`, `otaRef` and the commission. A booking for
a night with no free room is still accepted, unassigned, and raises a HIGH
`OVERBOOKED` flag with relocation options (other room types, then other
properties of the group). `GET /channels/cost` compares what each channel cost
against the booking site.

### Dynamic pricing

`src/modules/pricing/engine.ts` is a pure function: for a room type and night
it forecasts occupancy (on the books plus the pickup the same weekday got in the
last four weeks), reads pace, lead time, weekends, the strongest event (the
Nigerian calendar in `events.ts`: Easter, Workers' Day, Democracy Day,
Independence Day weekend, Christmas, Detty December in Lagos, Eid dates flagged
as moon dependent; plus custom events) and competitor prices, then applies the
guardrails (floor, ceiling, maximum change per run, minimum change) and rounds
to ₦500. Every suggestion explains itself ("78% booked 12 days out, 20 points
ahead of usual pace; Independence Day weekend: +18%"). SUGGEST mode leaves
suggestions to accept or reject; AUTOPILOT applies them at 03:00 and after a
booking pace spike. Applied prices are rate overrides with source `PRICING`
(manual overrides are never touched, frozen dates are skipped), logged as price
changes with revert, and `GET /pricing/report` estimates what the engine
earned against the earlier prices.

### Guest WhatsApp inbox

Guest messages on the M4 webhook (from a number that is not staff) are routed
to the property of the guest's most relevant stay (in house, then arriving,
then recently departed; or the business number's property) and threaded per
phone. Staff reply in the 24-hour window; after it only approved templates go
out (`WHATSAPP_WINDOW_CLOSED`); the new templates `guest_message`,
`pre_arrival_confirm` and `in_stay_welcome` are in `docs/whatsapp-templates.md`.
Quick replies fill placeholders (Wi-Fi, directions, check-out time...).
In-house requests containing keywords (towels, AC, shower, Wi-Fi...) become
housekeeping or maintenance suggestions to accept with one tap. The
pre-arrival message asks the guest to reply 1, then for a time, which is saved
as `expectedArrivalTime`. Delivery statuses update each message; an SLA marks
unanswered conversations overdue. `POST /inbox/dev/inbound` runs the same
pipeline in development.

### Loyalty

One programme per group. Points are earned once per stay at check-out, on
pre-tax spend net of discounts (room, day use and extras, POS charges
included), with the tier bonus; tiers follow nights in the last 12 months
across properties and are recomputed on each earn and nightly. At the desk a
member redeems as a folio discount after a one-time code sent to their phone,
or with a manager's PIN; voiding the line returns the points. Online, a
signed-in member can redeem in the quote (spread over the nights like a promo);
the booking holds the points and returns them if the hold expires or the
booking is cancelled. Adjustments are audited and large ones raise
`LOYALTY_ADJUSTMENT`. Earned lots expire first-in, first-out at 04:00.

### Custom domains and TLS

A property connects a subdomain (apex domains are refused): a TXT record
`_<app>-verify.<domain>` proves ownership and a CNAME points it at
`CUSTOM_DOMAIN_TARGET`. Pending domains are re-checked every 10 minutes (FAILED
after 72 hours), verified ones daily (FAILED after 3 days of missing records).
Only verified domains resolve through `GET /public/resolve-host`, which is also
the `ask` endpoint for on-demand TLS: with Caddy,

```
{
  on_demand_tls {
    ask https://api.hotelos.ng/api/v1/public/resolve-host
  }
}
https:// {
  tls { on_demand }
  reverse_proxy web:3000
}
```

issues a certificate only for hosts the API answers 200 for (Cloudflare for
SaaS custom hostnames works the same way). In development `DNS_PROVIDER=mock`
keeps records in memory; `POST /domains/:id/dev/publish` writes the expected
ones.

---

## Enterprise tier and the platform console (M6)

The full contract is `API-M6.md` (shared with the frontend repositories).
Enterprise adds `white_label`, `api_access`, `dedicated_database`, `sso` and
`data_export` on top of Pro.

### Architecture: control plane and data plane

Tables with a `tenant_id` are either **control plane** (subscriptions,
invoices, feature overrides, API keys and their usage, white-label, SSO,
support desk, impersonation sessions, exports, offboarding, the dedicated
database registry, the public listing projection) or **data plane**
(everything a hotel operates on: properties, rooms, reservations, folios,
guests, POS, audit trail, webhook endpoints and deliveries, ...). The list is
`CONTROL_TABLES` in `src/modules/dedicated-db/engine.ts`.

- Control-plane rows always live in the shared database. They are read with
  `db.control(tenantId, fn)` (hotel side, signed tenant context) or
  `db.system(fn)` (console).
- Data-plane rows live wherever the tenant is served: the shared database, or
  its own dedicated database. `db.tenant(tenantId, fn)` asks the
  `TenantDbRouter` and opens the transaction on the right database; every
  hotel service already goes through it, so nothing else changes.
- A dedicated database also holds a read-only **mirror** of the control rows
  that operational queries join (the tenant row, plans, features,
  subscription, feature overrides), kept in step by `ControlMirrorService`
  after each console / billing change and every 5 minutes.
- Cross-tenant reads (marketplace search, resolve-host, guest trips, platform
  metrics, sweeps) fan out with `db.publicAll` / `db.systemAll`; each target
  carries a `tenants` filter so the stale shared copy of a moved tenant is
  never read twice. `public_listings` projects every listed property (slug,
  custom domain, city) so a slug or host resolves to its database in one
  lookup.
- Each tenant transaction first calls `app_tenant_gate(tenant)` in the
  database: it takes a shared advisory lock and answers `ok`, `read_only`
  (cutover window: writes answer 409 `TENANT_MIGRATING { retryAfterSec }`) or
  `moved` (another instance switched routing: reload and retry).

### Dedicated database runbook

Provision (console, `dedicated_db.manage` + step-up):
`POST /platform/tenants/:id/database/provision { source: "AUTO" }` creates
`<DEDICATED_DB_PREFIX><slug>` through `DATABASE_ADMIN_URL` (development: the
owner role `hotel`), or `{ source: "URL", url }` uses an empty database an
operator created. Steps, all visible in `GET /platform/provisionings/:id`:

1. `CREATE_DATABASE`, `MIGRATE` (`prisma migrate deploy` on the new database,
   installs the context key), roles `hotel_app` / `hotel_platform` connect with
   their usual credentials.
2. `COPY`: every data-plane table of the tenant in foreign-key order, batches
   of 500 (the shared copy stays live meanwhile), plus the control mirror.
3. `READ_ONLY_DELTA`: the gate turns read-only (a few seconds); rows inserted,
   changed or deleted since the copy are applied.
4. `VERIFY`: row counts and checksums per table, source vs target.
5. `CUTOVER`: the registry flips to `ACTIVE`, every instance is told over
   Redis (`hotel:tenant-db-routing`) and refreshes within 10 s at the latest.
   A verification failure drops the target and ends `ROLLED_BACK` with the
   failing tables; the tenant never left the shared database.

After the cutover the shared copy is kept `DEDICATED_SHARED_RETENTION_DAYS`
(7) days, then purged by the `dedicated-purge` job (or
`POST .../database/purge-shared`). Until then
`POST .../database/rollback` copies back rows changed since the cutover and
routes the tenant to the shared database again.

Migrations: run `pnpm db:migrate:all` on every deploy (shared first, then
each dedicated database; exit code 1 if any failed). The console has the same
action (`POST /platform/databases/migrate-all`, SUPER_ADMIN, step-up).
Backups: a dedicated database is an ordinary Postgres database; include it
in the backup schedule by its name (`GET /platform/dedicated-databases`).

### Platform console security

- **Roles**: SUPER_ADMIN, OPERATIONS, SUPPORT, FINANCE, SALES_READONLY with
  permission sets (`GET /platform/permissions`, `platform-permissions.ts`);
  a missing permission is 403 `PLATFORM_FORBIDDEN`.
- **Mandatory TOTP** (RFC 6238, in-house, SHA-1, 6 digits, +-1 step, each code
  once): the password step returns `MFA_REQUIRED` or
  `MFA_ENROLMENT_REQUIRED`; enrolment shows a QR code and ten recovery codes
  (stored hashed). Tokens carry a session id; each request re-checks the
  session (revocable, 12 h absolute, 60 min idle) and the user's IP allowlist.
  Refresh tokens rotate with reuse detection.
- **Lockout**: 5 wrong passwords or codes in a row lock the account for 15
  minutes (423 `ACCOUNT_LOCKED`); admins can unlock.
- **Step-up**: sensitive routes (impersonation, write mode, offboarding,
  provisioning, queue retries, MFA reset, recovery codes, password, IP
  allowlist) need a code re-entered in the last 10 minutes.
- **Origins**: `PLATFORM_ORIGINS` only on `/api/v1/platform/*`; the hotel
  apps' origins are refused there (and the console's on hotel routes) with
  403 `ORIGIN_NOT_ALLOWED` before any handler runs.
- **Audit**: every non-GET platform request, sign-in event and sensitive read
  lands in `platform_audit_logs` (append-only by trigger, bodies redacted);
  `GET /platform/audit`, CSV/JSON export.
- **Impersonation**: time-boxed (max 60 min), mandatory reason, read-only by
  default (non-GET hotel requests answer 403 `IMPERSONATION_READ_ONLY`), write
  mode needs a second reason and step-up; owners are impersonated only by
  SUPER_ADMIN. The admin gets a one-time handoff code; the staff token carries
  `imp` and dies with the session. Every write is in the tenant trail as
  "<staff> (Devstrike support: <platform user>)" and mirrored in the platform
  log; owners see and can end sessions (`/support-sessions`).

### Partner API and API keys

`/api/partner/v1` (outside the app prefix; no CORS), documented by
`GET /api/partner/v1/openapi.json` (OpenAPI 3.1, hand-written in
`src/modules/enterprise/partner/openapi.ts`).

- Keys `hk_live_<prefix>_<secret>` / `hk_test_...`: the prefix is the lookup
  key, only SHA-256 of the secret is stored. Scopes, optional property
  restriction, IP allowlist and expiry; rotation keeps the old secret valid
  for 24 hours; revocation is immediate.
- `PartnerGuard` authenticates the key, checks the allowlist, the tenant's
  `api_access`, the scope and the rate limits (Redis, per key: per minute and
  per second, `RateLimit-*` headers, 429 with `Retry-After`), requires
  `Idempotency-Key` on writes, and meters usage (buffered, flushed every 5 s
  into `api_usage_daily`). Writes reuse the hotel services as a synthetic
  staff principal with the scopes' permissions; the audit trail names
  "API key <name>".
- **Test keys** run writes inside `dryRunContext`: every tenant transaction
  that wrote is rolled back (`DryRunRollback` carries the result), so
  validation, availability and database constraints are real and nothing is
  kept. Responses carry `dryRun: true`.
- Lists are cursor-paginated over `(createdAt, id)`; errors carry the
  `requestId`.

### Outbound webhooks

Events come from audit entries and domain events inside the business
transaction (`registerAuditHook`, `onDomainEvent`): the delivery rows commit
with the change (transactional outbox). A sweep (every minute, and right
after a change on this instance) delivers them through `safeRequest` (the
SSRF guard: https only in production, private / loopback / link-local /
metadata addresses refused, DNS pinned, no redirects, 10 s timeout). Each
request is signed `X-Signature: t=<unix>,v1=<HMAC-SHA256(secret,
"<t>.<body>")>` (a second `v1` during a secret rotation). Retries after 1 min,
5 min, 30 min, 2 h, 5 h, 10 h and 24 h; an endpoint failing for 24 hours with
at least 10 failures is disabled and the owners are emailed. Deliveries keep
request / response / attempt logs; replay and a test ping are one call away.

### White-label

Brand kit (logo, colours, curated Google fonts, footer links, "powered by"
off) shown on the booking site only when the request host is the property's
verified custom domain (`?host=` on `GET /public/hotels/:slug`). Guest email
goes from the hotel's verified sending domain (Resend Domains API, or a mock
without `RESEND_API_KEY`), SMS with the approved sender ID (request to
Termii, or mock; the console approves), documents and emails drop the
platform branding. The staff portal on the hotel's own domain is verified
like custom domains (TXT + CNAME to `STAFF_PORTAL_TARGET`) and described by
`GET /public/staff-portal?host=`.

### Single sign-on (OIDC)

Per tenant: issuer discovery through the SSRF guard, Authorization Code +
PKCE (S256), `state` and `nonce` in Redis for 10 minutes, ID token verified
against the JWKS (RS256, `iss`, `aud`, `exp`, `nonce`, `email_verified`,
allowed domains), existing staff or just-in-time creation within `max_staff`.
"SSO only" refuses password sign-in (403 `SSO_REQUIRED`) except for the
break-glass owner and needs a successful test in the last 24 hours. The
development provider at `/api/v1/dev/oidc` (client `dev-client`, secret
`dev-secret`) is served in-process and refused in production.

### Data export and offboarding (NDPA)

`POST /exports` builds a zip (in-house writer) with JSON and CSV of every
tenant entity (ID numbers decrypted and marked sensitive, no password
hashes), a manifest and a README; the signed link lives 24 hours, files 7
days, downloads are audited. Offboarding suspends the tenant (writes answer
409 `TENANT_OFFBOARDING`, public pages disappear), makes that export and,
after `OFFBOARDING_GRACE_DAYS` (30), deletes every row in the shared and
dedicated database (the dedicated database is dropped), files and exports;
the tenant row stays as a tombstone for the platform's own invoices.

### Scheduled platform jobs (queue `platform`)

`webhooks-deliver` and `announcements-email` every minute,
`api-usage-flush` and `mirror-sync` every 5 minutes, `white-label-checks`
every 10, `public-listings` every 15, `dedicated-purge` and
`exports-cleanup` hourly, `offboarding` at 04:30. Every scheduled job records
its last run in `job_runs` (the console's cron table flags overdue ones);
`POST /platform/jobs/:name/run` runs one now.

---

## Brand Studio, booking forms, extras and pickups (M7)

M7 adds five modules: `site` (themes, templates, assets, preview tokens),
`booking-form`, `extras` (paid extras, pickup points, transfers), `setup`
(the wizard) and their public endpoints under `/public`. The contract is in
`docs`-style form in the API notes; this section is the operator view.

### Plans

| feature | Starter | Growth | Pro | Enterprise |
|---|---|---|---|---|
| `brand_kit` (logo, favicon, colours) | yes | yes | yes | yes |
| `site_templates_all` (all six templates; Starter: Editorial, Essentials) | | yes | yes | yes |
| `site_sections` (show / hide / reorder sections, colour mode) | | yes | yes | yes |
| `site_fonts` (curated font pairings) | | | yes | yes |
| `form_fields_unlimited` (limit `max_custom_form_fields`: Starter 3) | | yes | yes | yes |
| `form_conditional_logic` | | yes | yes | yes |
| `paid_extras` (extras, pickup points, transfers) | | yes | yes | yes |
| `form_file_uploads` | | | yes | yes |

`booking_site_branding` is kept as an alias of `brand_kit`: a plan, add-on or
removal under either name applies to both, and gates on the old code keep
working (the migration copies overrides across). The platform console's
plans editor lists limits from a hard-coded list; add
`max_custom_form_fields` there to edit it (the API already accepts it).

### Themes and templates

Each property has a theme (and a group has an optional root theme,
`scope=GROUP`) with a working draft and immutable published versions (last
20 kept; a database trigger refuses updates). Publishing, discarding and
reverting are audited; revert publishes a copy of the old version as a new
one. The server derives the colours the web app uses: from the hotel's
primary and optional secondary it computes light and dark sets that keep
text at 4.5:1 and buttons and focus rings at 3:1 (WCAG 2.1), moving only HSL
lightness, and reports every adjustment (`POST /site/theme/contrast` for live
feedback). Publishing also updates the property's accent colour and logo, so
emails and invoices follow. Logos, favicons and section images are uploaded
to `/site/assets` (type sniffed from the bytes, images re-encoded without
metadata) and served from `/public/site-assets/...`. `POST
/site/preview-token` signs a short-lived link (`?preview=`) that shows the
draft theme and draft form on the real site (`X-Robots-Tag: noindex`).

### Booking form

The form is a list of fields: seven compulsory SYSTEM fields (name, phone,
email, dates, guests, policy consent), two recommended ones, a library
(nationality, purpose of visit, company name and TIN, vehicle plate, dietary
needs, next of kin, pickup block, extras picker ...) and custom fields
(`c_*`). Each field has a channel list (marketplace, booking site, front
desk), required / optional / hidden, an optional condition on an earlier
answer, validation (length, number range, date offset, safe patterns, file
size and type) and a purpose note. Seven presets match hotel types. Rules:

- BVN questions are refused (`BVN_BLOCKED`); NIN, passport and other ID
  numbers only warn (collect them at check-in, on the register card).
- Publishing creates an immutable version with a diff; every booking stores
  the version id, the channel and the cleaned answers, so old bookings keep
  the labels they were asked with.
- Answers are validated strictly on the server for the channel: unknown keys,
  system keys, hidden fields and fields whose condition does not hold are
  refused or dropped; email is required when paying online (or when the
  hotel makes it required).
- File answers (Pro): uploaded first (`/public/hotels/:slug/booking-form/uploads`),
  sniffed (PDF, JPEG, PNG, WebP), images re-encoded, scanned through the
  `FileScanner` interface (a no-op that refuses the EICAR test string by
  default), stored through the storage abstraction, attached at booking and
  deleted after 24 hours when unused (job `form-uploads-cleanup`). Staff get
  10-minute signed links.
- Mapped answers pre-fill empty guest fields (nationality, address, company,
  vehicle), the register card and the invoice (`billTo`: company and TIN).
- `GET /booking-form/answers/export` downloads answers per date range (JSON or
  CSV with a BOM for Excel; sensitive columns need `guests.export`).

### Paid extras, pickups and transfers

Extras are priced per stay, night, person, person per night or unit, with
maximum units, channels, availability windows, weekdays, minimum nights,
early check-in / late check-out kinds, daily caps and lead times; they are
taxed with the property's tax settings like room charges. Pickup points
(airport, motor park, train station, jetty, other) have a pickup and a
drop-off price, vehicle options with capacities and prices, a lead time and
optional operating hours. The quote prices everything and the signed quote
token freezes each amount, the form version and the tax components; the
booking re-checks daily caps (under a lock) and pickup lead times inside its
transaction. Folio posting:

- online payment: posted when the payment is applied;
- pay at hotel and front-desk bookings: posted at check-in;
- extras added later: at once when the guest is in house or paid online,
  otherwise at check-in; removing a posted line voids it (VOID entries);
- cancellations and expired holds cancel the lines and void posted ones.

Commission (M3 rule): marketplace bookings pay the plan commission on the
whole online total, add-ons included; booking-site bookings pay none; extras
added at the desk pay none.

Transfers move `REQUESTED -> CONFIRMED -> DRIVER_ASSIGNED -> EN_ROUTE ->
PICKED_UP -> COMPLETED` (or `NO_SHOW` / `CANCELLED`); every step is kept in
the transfer's history and audited. Assigning a driver sends the guest the
driver's name, phone, plate and the meeting point by WhatsApp (template
`transfer_driver_assigned`), SMS and email; `transfer_update` covers "on the
way", delays and cancellations. In development these land in the dev outbox
(`GET /api/v1/public/dev/outbox`). The WhatsApp templates and their
parameters are listed in `docs/whatsapp-templates.md`. Motor-park pickups
ask for the transport company (a platform list plus the hotel's own) and the
departure city; train stations ask for the route (Lagos - Ibadan, Abuja -
Kaduna, Warri - Itakpe, the Lagos Red and Blue lines, Abuja light rail).

Booking re-checks every extra's rules against the current settings and the
clock (active, channel, validity window, weekdays, minimum nights, lead time,
daily cap), not only at quote time: a signed quote cannot carry an extra
whose lead time has passed since.

### Setup wizard

New hotels get a server-side checklist (hotel type, brand, rooms, booking
form, extras, payments, policies, go live). Steps are detected from the data,
so work done elsewhere counts; `POST /setup/go-live` publishes what is
unpublished and needs rooms (`409 SETUP_INCOMPLETE`). Hotels that existed
before M7 are marked complete by the migration. The dashboard and the front
desk "Today" card show the progress (`setup`) and today's transfers.

### NDPA, partner API and webhooks

The guest export (`GET /guests/:id/export`) includes each stay's answers
(sensitive ones too, files as short-lived links), extras and transfers;
anonymising wipes the answers, deletes uploaded files and clears transfer
contact details and flight numbers. The partner API returns `bookingForm`,
`extras` and `transfers` on reservations (sensitive answers need the
`guests:read` scope), adds `GET /transfers`, `/extras`, `/pickup-points`,
and webhooks gain `transfer.created` and `transfer.updated`.

### M7 seed data

The Palmwine House (Lekki) publishes Editorial with a Boutique draft, a
Boutique-preset form with a second version (airport pickup block, an
occasion question with a conditional follow-up), six extras (Breakfast for
two, Early check-in from 10:00, Late check-out until 16:00, Birthday cake &
decoration, Bottle of wine on arrival, Laundry bundle), seven pickup points
(MMIA, MMA2, Jibowu, Ojota New Garage, Mobolaji Johnson Station Ebute Metta,
Maza-Maza, Marina jetty) and today's arrivals with transfers in every live
state; Palmwine House Ikoyi uses Business, Eko Tides Resort, Bodija Heights
(Starter) Essentials with one custom question, and Harmattan Heritage on
every property and on the group root, with Abuja pickup points (Nnamdi
Azikiwe airport, Utako, Jabi, Idu and Kubwa stations) seeded into its
dedicated database. Wuse Garden Suites is part-way through the setup wizard.

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
  not interchangeable. Since M6 the password step returns an MFA challenge
  only; see "Platform console security" below.
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
- **Hotel operations** (M2): `/reservations` (+ `check-in`, `check-out`,
  `registration`, `move-room`, `convert-to-nightly`, `confirm`, `cancel`,
  `no-show`, `folio`), `/availability`, `/availability/rooms`, `/tape-chart`,
  `/front-desk/today`, `/guests` (+ `lookup`, `id-document`, `id-image`,
  `export`, `anonymise`), `/guest-register`, `/folios` (+ `charges`,
  `discounts`, `payments`, `refunds`, `entries/:id/void`, `close`,
  `invoices`), `/tax-settings`, `/invoices`, `/receipts` (+ `share`),
  `/shifts` (+ `current`, `open`, `close`, `approve`), `/guard` (`flags`,
  `rules`, `summary`, `sweep`), `/digests` (+ `settings`, `preview`, `send`),
  `/night-audit` (`runs`, `run`), `/reports` (`daily`, `range`, `payments`,
  `shifts`), `/housekeeping/tasks`, `/me/approval-pin`, `/staff/approvers`
- **Public**: `GET /public/documents/:token` (guest share link),
  `GET /files/:token` (signed file URL)
- **Guest side** (M3, public): `GET /public/booking-config`,
  `/public/hotels` (with `checkIn`, `checkOut`, `sort`),
  `/public/hotels/:slug/availability`, `/public/hotels/:slug/reviews`,
  `POST /public/quotes`, `POST /public/bookings`,
  `GET /public/payments/:reference/verify`, `POST .../retry`,
  `/public/trips/:code` (+ `cancel-preview`, `cancel`, `calendar.ics`,
  `documents/:kind/:id`, `invoice`), `/public/reviews/request`,
  `POST /public/reviews`, `/public/auth/otp/start|verify`,
  `/public/auth/email/start|verify`, `/public/auth/refresh|logout`;
  development only: `/public/dev/outbox`, `/public/dev/payments/:ref/confirm`
- **Guest** (Bearer guest token): `GET|PATCH /guest/me`, `GET /guest/trips`
- **Hotel** (M3): `/booking-settings`, `/payouts` (`banks`,
  `resolve-account`, `account`, `summary`, `transactions`, `commission`),
  `/online-bookings/feed`, `/reservations/:id/notifications`,
  `/notifications` (+ `:id/preview`), `/reviews` (+ `summary`, `:id/reply`,
  `:id/flag`)
- **Webhook**: `POST /billing/webhooks/paystack` (subscriptions and bookings;
  `charge.success`, `charge.failed`, `refund.*`)
- **Platform** (Bearer platform token):
  - `POST /platform/auth/login`, `GET /platform/auth/me`
  - `GET /platform/metrics`
  - `GET /platform/tenants`, `GET /platform/tenants/:id`,
    `PATCH /platform/tenants/:id/subscription`
  - `PUT /platform/tenants/:id/features`,
    `DELETE /platform/tenants/:id/features/:featureCode`
  - `GET /platform/plans`, `PATCH /platform/plans/:code`
  - `POST /platform/jobs/dunning/run`
  - M3: `GET /platform/marketplace/summary`,
    `GET /platform/commission/receivables`, `POST .../settle`,
    `GET /platform/payments/orphaned`, `POST /platform/payments/:id/retry-refund`,
    `GET|PATCH /platform/reviews`, `GET /platform/notifications`,
    `POST /platform/jobs/holds/sweep`, `POST /platform/jobs/guest-notifications/run`
- **Growth tier** (M4, hotel): `/permissions`, `/roles` (CRUD);
  `/housekeeping` (`tasks` + `start`, `checklist`, `finish`, `skip`,
  `inspect`, `photos`, `issue`; `my-tasks`, `board`, `inspections`, `assign`,
  `assignments/suggest|apply`, `settings`, `checklists`,
  `jobs/stayover/run`), `/lost-found`; `/maintenance/tickets` (+ `status`,
  `comments`, `photos`), `/room-blocks`, `/maintenance/schedules` (+
  `calendar`, `run`), `/maintenance/fuel-logs` (+ `summary`),
  `/maintenance/reports`; `/rate-plans`, `/rate-rules`, `/rate-overrides`,
  `/rate-restrictions`, `/rates/calendar`, `/rates/quote`, `/promo-codes` (+
  `check`); `/corporate-accounts`, `/city-ledger` (`summary`, `charges`,
  `invoices` + `payments`, `remind`, `void`, `share`; `payments`);
  `/whatsapp/templates`, `/notification-settings`, `/guard/alerts` (+ `test`),
  `/audit-logs/export`
- **Growth tier** (M4, public): `GET /public/hotels/:slug/price-calendar`,
  `GET|POST /webhooks/whatsapp`

Conventions:

- Money is always integer kobo, in fields named `...Kobo`.
- Dates are ISO 8601 strings in UTC. Business logic uses Africa/Lagos
  (UTC+1) where days matter.
- `DELETE` routes return `{ "success": true }`.

---

## Testing

Database connections: a transaction runs all its queries on one pg
connection. `src/common/pg-concurrency-guard.ts` (installed by `main.ts`,
the seed and the e2e setup) chains queries per connection, because Prisma
loads `include` relations in parallel and pg 9 refuses overlapping queries;
application code uses `inSeries` / `mapInSeries` instead of `Promise.all`
over a `tx` (a unit test scans for it), and the e2e run fails on pg's
"already executing a query" warning. `PG_CONCURRENCY_GUARD=throw` makes any
overlap fail with `PG_CONCURRENT_QUERY` to find its caller; `off` disables it.

```bash
pnpm test        # unit (Vitest): tax maths, availability, guard rules, shift variance,
                 # folio totals, encryption, tokens, phone numbers, codes, reports,
                 # quotes, commission, cancellation fees, OTP, reviews, .ics, templates,
                 # rate resolution, restrictions, promo discounts, permissions,
                 # trusted IP, auto-balance, SLA, aging, quiet hours, webhook signatures,
                 # M5: pricing engine and events calendar, POS totals and happy hour,
                 # iCal, inbox rules, loyalty rules, custom domain checks,
                 # M7: colour contrast, template gates, form validation and presets,
                 # extras and pickup pricing, transfer flow, feature aliases
pnpm test:e2e    # needs local Postgres (roles hotel, hotel_app, hotel_platform) and Redis
```

The e2e global setup drops and recreates the `hotel_test` database (override
with `E2E_DB_NAME`). It runs `prisma migrate deploy` as `hotel` and then the
seed. The suites run the real Nest app through supertest, with the API
connected as `hotel_app` (and `hotel_platform` for cross-tenant work). A small
local HTTP stub stands in for `api.paystack.co`.

M2 suites:

- `m2-security`: `hotel_app` cannot read another tenant whatever `app.*`
  settings it sets, cannot read or replace the signing key, and has lost
  catalogue writes and platform tables; `hotel_platform` works without
  `BYPASSRLS`.
- `m2-reservations`: double booking refused under concurrency, through the API
  and with two raw concurrent transactions; room-type capacity for unassigned
  stays; day use gated by `hourly_bookings`; clean-room and register rules at
  check-in; tape chart; re-validation on moves.
- `m2-folio`: taxes, `SHIFT_REQUIRED`, Idempotency-Key replay and conflict,
  blind close with a variance flag, voids and `VOIDED_PAYMENT`, immutable
  entries, second-key discounts, gapless invoice and receipt numbers under
  concurrency, city-ledger check-out, share links, night audit idempotency.
- `m2-guests`: phone dedupe, ID encryption at rest, ID images, register CSV,
  NDPA export and anonymisation, housekeeping status rule, room-status guard
  rules.

M3 suites (with a stateful Paystack stub for initialize, verify, refund,
banks, account resolution and subaccounts):

- `m3-booking`: availability-aware search, a hold blocking a double sale
  under concurrency, hold expiry freeing the room, idempotent booking
  retries, the split initialisation, webhook success (confirmation, receipt,
  commission, notifications), duplicate and badly signed webhooks,
  verification on callback, zero commission on the booking site,
  pay-at-hotel receivables and no-show reversal, orphaned late and
  mismatched payments with refunds, late payments that revive a booking,
  guest (free and late) and hotel cancellations with refunds and commission
  reversal, the hotel feed, and a 429 from the quote rate limit.
- `m3-guests`: OTP sign-in with hashed codes, resend limit, lockout after
  five wrong codes, refresh-token reuse, token audiences kept apart, magic
  links, trips visible only to their guest, reviews only for checked-out
  stays and only once (with hotel reply and moderation), flagged review
  text, seeded aggregates matching review rows, and RLS on the M3 tables
  (no `hotel_app` access to guest identity, tenant isolation, the public
  availability function answering only in the public context).

M4 suite (`m4-growth`):

- rate resolution: override over rule, higher priority wins, days of the
  week; per-night snapshots that later rule changes do not touch; the night
  audit posting each night at its own price; structured plan terms;
  `rates.manage` for custom prices.
- promo codes: percent discount with tax on the net, minimum nights, expiry,
  channel, unknown codes, uses counted on booking and given back on
  cancellation.
- room blocks: blocked nights in availability, a booking into a blocked room
  refused, sold out when the rest is taken, `BLOCK_CONFLICT` and forced
  blocks, front desk cannot block.
- permissions: `/me` permissions, a custom role granting exactly its codes and
  edits applying on the next request, no privilege escalation (roles, staff,
  owners), system roles read-only, audit export locked below Pro.
- housekeeping: check-out creating the cleaning task (with the room type
  checklist, deep clean every N stays, a damaged template), inspection
  pass / fail with the room staying dirty, stayover generation and DND skip.
- city ledger: credit limit on check-out, statement numbering, aging, part
  payments.
- WhatsApp webhook: verify token, signatures (missing, wrong secret, tampered
  body), duplicates.
- trusted client IP: a spoofed `X-Client-IP` without the secret is ignored;
  with it, visitors behind one web server are limited separately.

M5 suite (`m5-pro`):

- properties: Growth locked, rooms, types and reservations never crossing
  properties (404 across, 403 `PROPERTY_ACCESS_DENIED` for staff without
  access, malformed ids refused), `max_properties`.
- point of sale: kitchen and bar tickets, the KDS status flow, stock deducted on
  send, `SHIFT_REQUIRED` and `PAYMENT_MISMATCH` for cash, receipts, room charges
  on the guest folio with the surname check, `POS_VOID_AFTER_SEND`.
- channel manager: iCal export of booked nights, import from a local feed and
  cancellation when the event disappears; Channex webhook signatures, mapping,
  the 30-second push debounce and diffed pushes (mock provider), the
  overbooking flag and a cancellation through the webhook.
- dynamic pricing: guardrails, preview explanations, manual overrides blocking
  the engine, autopilot changes logged and audited, the rates calendar source,
  revert.
- inbox: routing to the stay, threading, keyword suggestions, accepting one as
  a housekeeping task, the 24-hour window and templates, unknown senders.
- loyalty: enrolment at check-in, flagged adjustment, OTP redemption (wrong
  code, used code), void returning points, PIN redemption and its limit, earn
  at check-out moving the member up a tier, expiry.
- custom domains: apex refused, verification with the mock DNS, resolve-host
  only once verified, `DOMAIN_TAKEN`, removal.

M7 suite (`m7-site-forms`):

- themes: publish, versions, revert, the public theme following; server-side
  contrast variants; Starter template, section and font gates.
- booking form: BVN blocked, NIN warning, Starter limit of 3 custom fields
  (`LIMIT_REACHED`), conditional questions gated; versioning (a booking keeps
  the version and labels it was made with); conditions, channels, hidden and
  unknown keys; email required only for online payment; file uploads (Pro
  only, sniffed type, size cap, one booking per upload).
- extras and pickups: per-person-per-night pricing with VAT in the quote, a
  tampered add-on token refused, pickup lead time, operating hours, vehicle
  size and motor-park details, posting at check-in, the transfer status flow
  with the driver message in the dev outbox, Starter gate.
- NDPA: export with answers, profile answers without sensitive ones,
  anonymise wiping answers; seed data and the setup wizard.

## Run everything with Docker

One command brings up the whole product (database, Redis, migrations, demo
data, API, worker and the three Next.js apps as production builds).

**Prerequisites.** Docker Engine 24+ or Docker Desktop with Compose v2.24+
(`docker compose version`), about 4 GB of free memory for the first build and
8 GB of disk. The four repos cloned side by side:

```bash
git clone <...>/hotel-management-backend
git clone <...>/hotel-management-web
git clone <...>/hotel-management-admin
git clone <...>/hotel-management-platform
cd hotel-management-backend
cp .env.example .env
docker compose -f docker-compose.full.yml up --build
```

The first build takes several minutes. Services start in order: `postgres`
and `redis` (healthy) > `migrate` (`pnpm db:migrate:all`, exits) > `seed`
(`pnpm db:seed`, idempotent, exits) > `api` and `worker` (healthy) > `web`,
`admin`, `platform`. Add `-d` to run in the background and
`docker compose -f docker-compose.full.yml ps` to watch the health column.

| App | URL |
|---|---|
| Guest web (marketplace, hotel sites) | http://localhost:3000 (a hotel: http://localhost:3000/h/palmwine-house) |
| Hotel staff app | http://localhost:3001 |
| Platform console | http://localhost:3002 (use `localhost`, not `127.0.0.1`) |
| API | http://localhost:4000/api/v1 (Swagger at http://localhost:4000/docs) |
| Dev outbox (emails, SMS and OTP codes) | http://localhost:4000/api/v1/public/dev/outbox |

**Demo logins** (full list under "Seed accounts" above):

| App | Email | Password |
|---|---|---|
| Staff app, hotel owner (The Palmwine House) | `demo@palmwine.ng` | `Demo1234!` |
| Staff app, Enterprise group | `owner@harmattanhotels.com` | `Demo1234!` |
| Platform console, SUPER_ADMIN | `admin@devstrike.ng` | `Admin1234!` |

The console asks for a TOTP code: add the secret
`DEVSTRIKEADMINTOTPSECRET234567AB` to an authenticator app, run
`oathtool --totp -b DEVSTRIKEADMINTOTPSECRET234567AB`, or open
http://localhost:4000/api/v1/platform/auth/dev/totp?email=admin@devstrike.ng
(the stack runs the API with `NODE_ENV=development`, so the dev helpers and
mocks are on). The console's session cookies are `Secure`: Chrome, Edge and
Firefox accept them on `http://localhost`; Safari does not.

**What runs where.** One backend image serves four services: `api`
(`PROCESS_ROLE=api`: HTTP, enqueues jobs, no BullMQ processors), `worker`
(`PROCESS_ROLE=worker`: the processors; health on its own port 4000, not
published), `migrate` and `seed`. `PROCESS_ROLE` defaults to `all` (one
process, as in `pnpm start:dev`). Server-side calls go over the Compose
network (`http://api:4000`); the browser uses `http://localhost:<port>`,
which is baked into the Next.js builds. `TRUSTED_PROXY_SECRET` is shared by
the API, web and platform. Uploads live in the `uploads` volume
(`STORAGE_LOCAL_DIR=/app/storage`), with `pgdata` and `redisdata` beside it.

**Everyday commands** (all with `-f docker-compose.full.yml`):

```bash
docker compose -f docker-compose.full.yml up -d --build          # start / rebuild after pulling
docker compose -f docker-compose.full.yml logs -f api worker     # follow logs
docker compose -f docker-compose.full.yml run --rm seed          # refresh the demo "today"
docker compose -f docker-compose.full.yml exec postgres psql -U hotel hotel
docker compose -f docker-compose.full.yml down                   # stop, keep data
docker compose -f docker-compose.full.yml down -v                # stop and DELETE all data
SEED=false docker compose -f docker-compose.full.yml up -d       # start without demo data
docker compose -f docker-compose.full.yml --profile clamav up -d # also run ClamAV (clamd on clamav:3310)
```

**Settings.** `.env` supplies every backend variable (provider keys and
secrets; the Compose file overrides the addresses so containers find each
other, and gives defaults to the required secrets and to the variables
`.env.example` leaves empty). Compose-only knobs, from the shell or `.env`:

| Variable | Default | |
|---|---|---|
| `WEB_PORT`, `ADMIN_PORT`, `PLATFORM_PORT`, `API_PORT` | 3000, 3001, 3002, 4000 | host ports (the Next.js containers listen on the same port) |
| `PUBLIC_WEB_URL`, `PUBLIC_ADMIN_URL`, `PUBLIC_PLATFORM_URL`, `PUBLIC_API_URL` | `http://localhost:<port>` | what the browser uses (CORS, links, bundles) |
| `SEED` | `true` | `false` skips the demo data |
| `TRUSTED_PROXY_SECRET` | a local value | shared by api, web and platform |
| `WEB_CONTEXT`, `ADMIN_CONTEXT`, `PLATFORM_CONTEXT` | `../hotel-management-<app>` | where the frontend repos are |

**Common problems.**

- *Port already in use* (a local dev server, Postgres or another stack):
  stop it, or move the whole stack, e.g.
  `API_PORT=14000 WEB_PORT=13000 ADMIN_PORT=13001 PLATFORM_PORT=13002 docker compose -f docker-compose.full.yml up -d --build`.
  Keep `--build`: the browser URLs are compiled into the frontends. Postgres
  and Redis are not published, so they never clash.
- *The marketplace home is empty right after start*: it was pre-rendered
  during the build, when no API was running, and refreshes itself within a
  minute (reload twice). Hotel pages are rendered on request.
- *`api` stays unhealthy*: `docker compose -f docker-compose.full.yml logs api`.
  "Invalid environment configuration" names the variable; a secret shorter
  than 32 characters in `.env` is the usual cause.
- *Console sign-in says "Cross-site request refused"*: open it at
  `http://localhost:<PLATFORM_PORT>` exactly (not `127.0.0.1` or a LAN IP).
- *Old data or schema after switching branches*: `down -v` and `up --build`.
- *Building behind a TLS-inspecting corporate proxy*: builds fail with
  certificate errors. Every Dockerfile accepts the proxy's CA as an optional
  BuildKit secret `extra_ca` (add `build.secrets: [extra_ca]` to the services
  in a Compose override with `secrets: { extra_ca: { file: /path/ca.pem } }`).
- *Docker Hub "429 Too Many Requests"*: `docker login`, then retry.

### Databases only

For running the API with Node on your machine:

```bash
docker compose up -d                    # postgres + redis only (ports 5432, 6379)
docker compose --profile api up --build # also build and run the API (runs migrate deploy first)
```

The `Dockerfile` is a multi-stage build on `node:22-alpine`. The final image
holds production dependencies (including the Prisma CLI), the compiled
`dist/`, and `src/`, `scripts/` and `prisma/` with a global `tsx` for
`pnpm db:migrate:all` and `pnpm db:seed`; it runs as the `node` user.

## Deploy

Railway (api + worker, Postgres, Redis) and Vercel (web, admin, platform):
step by step, with every variable and third-party account, in
[`docs/deploy.md`](docs/deploy.md). Config: `railway.json` (api: pre-deploy
`pnpm db:migrate:all`, health check `/api/v1/health`) and
`railway.worker.json` (worker).

---

## Seed images

Hotel and room images are Unsplash CDN URLs
(`https://images.unsplash.com/photo-...?w=1600&q=80`), listed in one place:
`PHOTOS` in `prisma/seed-data/hotels.ts`. Run `pnpm images:verify` to check
that each one returns HTTP 200. Replace any failing id in `PHOTOS` and re-run
`pnpm db:seed`.
