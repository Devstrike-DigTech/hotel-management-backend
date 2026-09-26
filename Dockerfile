# syntax=docker/dockerfile:1
#
# One image for every backend process: the API (PROCESS_ROLE=api), the BullMQ
# worker (PROCESS_ROLE=worker), and the one-shot `pnpm db:migrate:all` and
# `pnpm db:seed` jobs (which run TypeScript through tsx, so the image keeps
# src/, scripts/ and prisma/ next to the compiled dist/).
#
# Building behind a TLS-inspecting proxy: pass its CA certificate as a build
# secret, e.g. `docker build --secret id=extra_ca,src=/path/to/ca.pem .`
# (optional; ignored when absent).

# ---- base -------------------------------------------------------------------
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# The Alpine base already ships libssl 3 (the Prisma schema engine links it)
# and a CA bundle, so no system packages are installed.
# pnpm is pinned and prepared at build time (readable by the `node` user), so
# `pnpm db:migrate:all` / `pnpm db:seed` work at run time without a download.
RUN --mount=type=secret,id=extra_ca,required=false \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
  corepack enable && corepack prepare pnpm@10.33.0 --activate \
  && chmod -R a+rX "$COREPACK_HOME"
WORKDIR /app

# ---- build: full install, generate the Prisma client, compile ---------------
FROM base AS build
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN --mount=type=secret,id=extra_ca,required=false \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
  pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime: production dependencies + tsx for the migrate / seed scripts --
FROM base AS runtime
ENV NODE_ENV=production PORT=4000 STORAGE_LOCAL_DIR=/app/storage
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# `--prod` still runs postinstall (`prisma generate`), which writes the client
# to src/generated for the TypeScript scripts; tsx is installed globally at
# the lockfile's version because it is a dev dependency.
RUN --mount=type=secret,id=extra_ca,required=false \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
  pnpm install --frozen-lockfile --prod \
  && npm install -g tsx@4.23.15 \
  && npm cache clean --force
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY --from=build /app/dist ./dist
# Uploads (STORAGE_DRIVER=local); mount a volume here. Owned by `node` so a
# fresh named volume inherits the right owner.
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
