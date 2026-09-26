# Deploying: Railway (API + worker) and Vercel (three Next.js apps)

This is the step-by-step for a first hosted environment on generated domains
(`*.up.railway.app`, `*.vercel.app`), then the custom-domain steps for later.
Nothing here is deployed automatically; the repos only carry the config
(`railway.json`, `railway.worker.json`, `vercel.json` in each Next.js repo).

```
browser ──> Vercel: web (guest)      ──┐  server-side calls, X-Proxy-Auth
        ──> Vercel: admin (staff)      │  (the browser also calls the API directly
        ──> Vercel: platform (console) ─┤   from web and admin; CORS allows them)
                                        v
             Railway: api  (PROCESS_ROLE=api, public domain, pre-deploy migrate:all)
             Railway: worker (PROCESS_ROLE=worker, no public domain)
             Railway: Postgres 16 ── roles hotel_app, hotel_platform
             Railway: Redis 7
             Cloudflare R2 (uploads)
```

Order of work: accounts (section 1), Railway (section 2), Vercel (section 3),
then go back to Railway to set the three Vercel URLs (section 2.6), then the
provider webhooks (section 4).

---

## 1. Accounts to open, and where each credential goes

Only the first two are needed to boot. Everything else has a development
fallback (mock or dev outbox) but in `NODE_ENV=production` a missing provider
means that feature fails or is refused, as noted.

| Service | What to create | Credential | Env var (Railway api + worker unless noted) |
|---|---|---|---|
| Railway | Project with Postgres, Redis, two services from the backend repo | - | - |
| Vercel | Three projects (web, admin, platform) | - | - |
| Paystack | Business account (test mode first); Settings > API Keys & Webhooks | Secret key `sk_test_...` / `sk_live_...` | `PAYSTACK_SECRET_KEY` (`PAYSTACK_BASE_URL` stays `https://api.paystack.co`) |
| | Webhook URL in the same screen | `https://<api>/api/v1/billing/webhooks/paystack` | - (signature uses the secret key) |
| Termii (SMS) | Account, fund wallet, register a sender ID (takes days) | API key, sender ID | `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_CHANNEL` (`generic`, or `dnd` for transactional), `TERMII_BASE_URL` |
| Meta WhatsApp Cloud API | Meta Business account, app with the WhatsApp product, a phone number, a System User with a permanent token | Permanent access token | `WHATSAPP_TOKEN` |
| | WhatsApp > API Setup | Phone number ID | `WHATSAPP_PHONE_ID` |
| | App settings > Basic | App secret | `WHATSAPP_APP_SECRET` |
| | WhatsApp > Configuration: callback `https://<api>/api/v1/webhooks/whatsapp`, a verify token you invent | Verify token | `WHATSAPP_VERIFY_TOKEN` |
| | Message templates (see `docs/whatsapp-templates.md`), once approved | Template names | `WHATSAPP_APPROVED_TEMPLATES` (comma-separated) |
| Resend (email) | Account, verify the sending domain (SPF/DKIM records) | API key | `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `HotelOS <bookings@hotelos.ng>`) |
| Cloudflare R2 (files) | Bucket (private), an R2 API token with Object Read & Write on it | Account ID, access key ID, secret | `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION=auto`, `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE=true` |
| Channex (channel manager) | Staging account at staging.channex.io first, production later | API key; a webhook secret you invent | `CHANNEX_API_KEY` (**required in production**: the API refuses to start without it), `CHANNEX_BASE_URL` (`https://staging.channex.io/api/v1` or `https://app.channex.io/api/v1`), `CHANNEX_WEBHOOK_SECRET`; webhook `https://<api>/api/v1/webhooks/channex` |
| Sentry | Organisation, one project per app | DSN | Not wired in the code yet (see "Open items"); suggested `SENTRY_DSN` (api) and `NEXT_PUBLIC_SENTRY_DSN` (Next.js apps) |
| Uptime monitor (Better Stack, UptimeRobot, ...) | HTTP monitors | - | No env var. Monitor `https://<api>/api/v1/health` (expects `{"status":"ok"}`), web `/`, admin `/login`, platform `/login` |
| Domain registrar + Cloudflare DNS (later) | The product domain | - | `APP_DOMAIN`, `CUSTOM_DOMAIN_TARGET`, `STAFF_PORTAL_TARGET`, `DNS_PROVIDER=system` |

---

## 2. Railway

### 2.1 Project, Postgres, Redis

1. New project > **Deploy PostgreSQL** (Postgres 16). Rename the service to
   `Postgres` (the variable references below use that name).
2. **+ New > Database > Redis**. Rename to `Redis`.
3. Pick one region for everything (EU West is closest to Lagos among Railway
   regions); keep the Vercel functions near it (`vercel.json` uses `lhr1`).

### 2.2 Create the two runtime roles (once)

The migrations run as the Railway `postgres` user (owner). The API itself
connects as two restricted roles so that row-level security applies. Open the
Postgres service > **Data > Query** (or `railway connect Postgres`) and run,
with two long random passwords
(`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`):

```sql
CREATE ROLE hotel_app LOGIN PASSWORD '<app-password>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE hotel_platform LOGIN PASSWORD '<platform-password>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
```

The migrations grant these roles what they need (tables, sequences, RLS
policies). Do not give them `BYPASSRLS` or ownership. Hex passwords need no
URL-encoding in the connection strings below.

### 2.3 The `api` service

1. **+ New > GitHub Repo > hotel-management-backend**. Rename to `api`.
2. Settings: branch to deploy; **Config-as-code** path `railway.json` (the
   default). It sets: Dockerfile build, `preDeployCommand` =
   `pnpm db:migrate:all` (shared database and every dedicated tenant
   database, before the new version takes traffic), start command
   `node dist/main.js`, health check `/api/v1/health`.
3. Networking > **Generate Domain** (e.g. `hotel-api-production.up.railway.app`).
   This is `<api>` below.
4. Variables: section 2.5. Set `PROCESS_ROLE=api`.

### 2.4 The `worker` service

1. **+ New > GitHub Repo > hotel-management-backend** again. Rename to `worker`.
2. Settings > **Config-as-code** path: `railway.worker.json` (same image, no
   pre-deploy step, restart always). No public domain.
3. Variables: the same as `api` (Railway: "Shared variables" at project level
   avoids typing them twice), with `PROCESS_ROLE=worker`.

`PROCESS_ROLE` (default `all`): `api` serves HTTP and enqueues jobs but runs
no BullMQ processors; `worker` runs the processors (dunning, sweeps,
notifications, channel sync, platform jobs) and still answers
`/api/v1/health` on `$PORT` for the health check. Both register the repeatable
schedules (idempotent). If one service runs with `all`, jobs are simply shared
between it and the worker.

**Deploy order.** The first time, deploy `api` first (its pre-deploy creates
the schema), then `worker`. Later deploys can go together; a worker that
starts before a migration finishes retries its jobs.

### 2.5 Variables for api and worker

`${{Postgres.X}}` / `${{Redis.X}}` are Railway reference variables; type them
literally. "You" means you choose the value (generate long random secrets with
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`).

| Variable | Value | Where it comes from |
|---|---|---|
| `NODE_ENV` | `production` | you |
| `PROCESS_ROLE` | `api` (api service) / `worker` (worker service) | you |
| `APP_NAME`, `APP_DOMAIN`, `SUPPORT_EMAIL` | `HotelOS`, `hotelos.ng`, `support@hotelos.ng` (placeholders until the name is final) | you |
| `DATABASE_URL` | `postgresql://hotel_app:<app-password>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` | role from 2.2 + Railway |
| `DATABASE_PLATFORM_URL` | `postgresql://hotel_platform:<platform-password>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` | role from 2.2 + Railway |
| `DATABASE_MIGRATION_URL` | `${{Postgres.DATABASE_URL}}` | Railway (owner, runs migrations) |
| `DATABASE_ADMIN_URL` | `${{Postgres.DATABASE_URL}}` | Railway; needs `CREATEDB` for Enterprise dedicated databases. Leave empty to create those databases by hand |
| `DATABASE_POOL_MAX`, `DATABASE_PLATFORM_POOL_MAX` | `10`, `4` | you (keep api + worker total under the Postgres plan's connection limit) |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | Railway (see "Open items" if the private network is IPv6-only) |
| `DB_CONTEXT_SECRET` | 48+ random chars | you; identical on api and worker |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_PLATFORM_SECRET` | random, 32+ chars each | you |
| `GUEST_JWT_SECRET`, `GUEST_TOKEN_SECRET`, `SHARE_TOKEN_SECRET` | random, 32+ chars each | you |
| `GUEST_DATA_KEY` | random, 32+ chars; **never rotate** (encrypted guest IDs) | you |
| `PLATFORM_DATA_KEY` | random, 32+ chars; **never rotate**; must not be empty (see "Open items") | you |
| `API_PUBLIC_URL` | `https://<api>` | Railway generated domain |
| `WEB_URL` | `https://<web>.vercel.app` | Vercel (section 3) |
| `ADMIN_URL` | `https://<admin>.vercel.app` | Vercel |
| `CORS_ORIGINS` | `https://<web>.vercel.app,https://<admin>.vercel.app` | Vercel |
| `PLATFORM_ORIGINS`, `PLATFORM_APP_URL` | `https://<platform>.vercel.app` | Vercel |
| `TRUSTED_PROXY_SECRET` | random, 16+ chars; the same value on web and platform | you |
| `STORAGE_DRIVER` + `S3_*` | see R2 in section 1 | Cloudflare |
| `EMAIL_FROM`, `RESEND_API_KEY` | | Resend |
| `TERMII_*` | | Termii |
| `WHATSAPP_*` | | Meta |
| `PAYSTACK_SECRET_KEY` | `sk_test_...` for staging | Paystack |
| `CHANNEX_API_KEY`, `CHANNEX_BASE_URL`, `CHANNEX_WEBHOOK_SECRET` | required in production | Channex |
| `OIDC_MOCK_ENABLED` | `false` (the API refuses to start in production with it on) | you |
| `DNS_PROVIDER` | `system` | you |
| `CUSTOM_DOMAIN_TARGET`, `STAFF_PORTAL_TARGET` | `sites.<APP_DOMAIN>`, `portal.<APP_DOMAIN>` | you (DNS later) |
| `PLATFORM_ALERT_EMAIL` | the platform team's inbox | you |
| `SWAGGER_ENABLED` | `false` in production if the docs should not be public | you |
| `OUTBOUND_ALLOW_PRIVATE_HOSTS` | empty (refused in production otherwise) | - |

Railway sets `PORT` itself; the app reads it.

**Uploads.** Use R2 (`STORAGE_DRIVER=s3`): a Railway volume attaches to one
service only, so the api and the worker cannot share it. A volume works only
for a single service running `PROCESS_ROLE=all`: mount it at `/app/storage`,
set `STORAGE_LOCAL_DIR=/app/storage`, and set `RAILWAY_RUN_UID=0` (Railway
mounts volumes as root; the image runs as the `node` user).

### 2.6 First deploy and data

1. Deploy `api`. The pre-deploy log shows `ok shared (applied: ...)`.
   `https://<api>/api/v1/health` returns `{"status":"ok"}`.
2. Deploy `worker`; its logs show "Dunning scheduled" and "Guest queue ready".
3. Demo data (staging only, never on a real production database): open a
   shell on the api service (`railway ssh --service api`) and run
   `pnpm db:seed`. It is idempotent. It creates the platform admin
   `admin@devstrike.ng` with a known password and TOTP secret (README, "Seed
   accounts"): change the password and re-enrol TOTP straight away, or do
   not seed a public environment at all (see "Open items" for a production
   bootstrap).
4. After section 3, fill in `WEB_URL`, `ADMIN_URL`, `CORS_ORIGINS`,
   `PLATFORM_ORIGINS`, `PLATFORM_APP_URL` and redeploy both services.

---

## 3. Vercel (web, admin, platform)

Create three projects, each importing its own repo. Framework preset Next.js
is detected; each repo's `vercel.json` pins pnpm install / build and the
function region (`lhr1`, near the Railway EU region; change both together).
The `output: "standalone"` line in `next.config.ts` is for the Docker image
and does not affect Vercel.

`NEXT_PUBLIC_*` values are inlined at build time: set them for Production
(and Preview) **before** the first build, and redeploy after any change.
Vercel cannot reach Railway's private network, so the "internal" API URLs
below are the public `https://<api>` too.

### 3.1 web (guest marketplace and hotel sites)

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api>` |
| `API_URL` | `https://<api>` (server-side calls) |
| `NEXT_PUBLIC_SITE_URL` | `https://<web>.vercel.app` |
| `NEXT_PUBLIC_ADMIN_URL` | `https://<admin>.vercel.app` |
| `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_DOMAIN`, `NEXT_PUBLIC_SUPPORT_EMAIL` | same identity as the API |
| `MARKETPLACE_HOSTS` | `<web>.vercel.app` (otherwise the generated host is treated as a hotel's custom domain) |
| `TRUSTED_PROXY_SECRET` | same value as the API |
| `CLIENT_IP_HEADER` | `x-vercel-forwarded-for` |
| `NEXT_PUBLIC_PARTNER_API_URL` | optional; default `https://<api>/api/partner/v1` |

### 3.2 admin (hotel staff app)

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api>` |
| `NEXT_PUBLIC_WEB_URL` | `https://<web>.vercel.app` |
| `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_DOMAIN`, `NEXT_PUBLIC_SUPPORT_EMAIL` | same identity |

### 3.3 platform (Devstrike console)

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api>` |
| `API_INTERNAL_URL` | `https://<api>` |
| `TRUSTED_PROXY_SECRET` | same value as the API |
| `NEXT_PUBLIC_ADMIN_URL`, `NEXT_PUBLIC_WEB_URL` | the two Vercel URLs |
| `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_DOMAIN`, `NEXT_PUBLIC_SUPPORT_EMAIL` | same identity |
| `NEXT_PUBLIC_CONSOLE_ENV` | `staging` or `production` (top-bar chip) |
| `PLATFORM_PROXY_KEY` | optional (the API does not check it yet) |

Protect the console: Vercel **Deployment Protection** (Vercel Authentication or
password) on this project at least, or put it behind Cloudflare Access once it
has its own domain. Its sessions need HTTPS (`__Host-` cookies), which Vercel
provides.

### 3.4 Smoke test

- `https://<web>.vercel.app` lists the hotels; a hotel page opens.
- `https://<admin>.vercel.app/login`: sign in (seeded: `demo@palmwine.ng` / `Demo1234!`).
- `https://<platform>.vercel.app`: sign in with the platform admin and a TOTP code.
- Browser console free of CORS errors (if not: `CORS_ORIGINS` / `PLATFORM_ORIGINS`).

---

## 4. Webhooks (after the API has its URL)

| Provider | URL | Secret |
|---|---|---|
| Paystack | `https://<api>/api/v1/billing/webhooks/paystack` | the secret key (HMAC-SHA512) |
| Meta WhatsApp | `https://<api>/api/v1/webhooks/whatsapp` | `WHATSAPP_VERIFY_TOKEN` (subscribe) + `WHATSAPP_APP_SECRET` (signature) |
| Channex | `https://<api>/api/v1/webhooks/channex` | `CHANNEX_WEBHOOK_SECRET` |

---

## 5. Later: custom domains and wildcards

With the product domain (say `hotelos.ng`) on Cloudflare DNS:

| Host | Points to | Notes |
|---|---|---|
| `hotelos.ng`, `www.hotelos.ng` | Vercel web project | add both in Vercel > Domains; set `NEXT_PUBLIC_SITE_URL=https://hotelos.ng`, drop `MARKETPLACE_HOSTS` |
| `*.hotelos.ng` (hotel subdomains, `grandview.hotelos.ng`) | Vercel web project | Vercel issues wildcard certificates only when the domain uses **Vercel nameservers**; otherwise run web behind Cloudflare (orange cloud, wildcard edge certificate) or on Railway with a wildcard domain |
| `sites.hotelos.ng` (= `CUSTOM_DOMAIN_TARGET`) | Vercel web (CNAME `cname.vercel-dns.com`) | hotels CNAME their own domain here; each hotel domain must also be added to the Vercel web project (manually or via the Vercel Domains API, see "Open items") |
| `app.hotelos.ng` | Vercel admin project | set `ADMIN_URL`, `CORS_ORIGINS`, `NEXT_PUBLIC_ADMIN_URL` |
| `portal.hotelos.ng` (= `STAFF_PORTAL_TARGET`) | Vercel admin project | white-label staff portals CNAME here; same per-domain note |
| `console.hotelos.ng` | Vercel platform project | behind Cloudflare Access; set `PLATFORM_ORIGINS`, `PLATFORM_APP_URL` |
| `api.hotelos.ng` | Railway api (Custom Domain, CNAME it gives you) | set `API_PUBLIC_URL`, every `NEXT_PUBLIC_API_URL` / `API_URL`, and the three webhook URLs |

After a domain change: update the API variables, redeploy both Railway
services, update the Vercel variables and redeploy the three projects (the
`NEXT_PUBLIC_*` values are baked in at build).

---

## 6. Open items (code, not config)

- **Empty optional variables.** `.env.example` leaves `PLATFORM_DATA_KEY`
  (and a few others) empty. An empty variable reaches the app as `""` through
  the Nest `ConfigService` (the validated value is `undefined`, so it falls
  back to `process.env`), and `platformKeyMaterial()` uses `??`, so the API
  crashes at start ("GUEST_DATA_KEY must be at least 32 characters"). Set
  `PLATFORM_DATA_KEY` (and `PLATFORM_ALERT_EMAIL`, `CUSTOM_DOMAIN_TARGET`,
  `STAFF_PORTAL_TARGET`) explicitly until this is fixed.
- **Console CSRF check when self-hosted.** The platform gateway compares the
  browser's `Origin` with `req.nextUrl.origin`, which a self-hosted Next
  server derives from its own bind address, not the `Host` header. It is
  right on Vercel and on `localhost` (the Docker image), wrong behind any
  other reverse proxy (every console write is refused). Fix in the platform
  repo before hosting the console outside Vercel.
- **Redis over IPv6.** `redisConnection()` drops URL query parameters, so
  `?family=0` cannot be passed. If the Railway private network is IPv6-only,
  BullMQ cannot reach `redis.railway.internal`; use the Redis public URL
  meanwhile.
- **Sentry** is not integrated in any app.
- **Production bootstrap** of the first platform SUPER_ADMIN: only the demo
  seed creates one today.
- **Custom domains on Vercel**: verified hotel domains are not added to the
  Vercel project automatically.
- **ClamAV**: the upload `FileScanner` is a no-op; the Docker stack can run
  clamd (`--profile clamav`) but nothing calls it yet.
