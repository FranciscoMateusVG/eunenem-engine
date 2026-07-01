# eunenem-server — Hono SSR React 19, esbuild-bundled hydration + Tailwind 4.
#
# Build context is the REPO ROOT (configured in docker-compose.yml as
# `build.context: ../../`), NOT apps/eunenem-server/, because the app
# imports from the repo-root `src/` via relative paths like
# `../../../../src/domain/...` (engine BCs + observability). The app is
# not workspace-packaged; the imports resolve via the actual filesystem
# layout. So the container must mirror the repo layout under /app.
#
# Two dep installs needed because the engine repo does NOT use pnpm
# workspaces (no pnpm-workspace.yaml). Each level has its own
# package.json + lockfile:
#   1. Repo root package.json — runtime deps used by src/ (engine BCs):
#      @opentelemetry/api, better-auth, kysely, pg, stripe, zod
#   2. apps/eunenem-server/package.json — Hono SSR app deps + esbuild
#      + tsx + Tailwind
# Node module resolution from /app/src/foo.ts walks up to /app/node_modules
# for the root deps, then /app/apps/eunenem-server/node_modules for the
# app deps. Both must exist.
FROM node:22-slim

WORKDIR /app

# Match the repo's pinned package manager (engine/package.json: pnpm@10.33.0).
RUN npm install -g pnpm@10.33.0

# Layer 1: install ROOT deps (production-only) — used by src/ at runtime.
# Layer-cache friendly: only invalidates when root package.json/lockfile
# changes, not on app-side code changes.
# --ignore-scripts skips the husky prepare lifecycle (husky is a devDep,
# not installed in --prod, but the prepare hook would still try to run
# it and crash the install).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Layer 2: install APP deps — full set (devDeps include tsx + esbuild
# + Tailwind, needed at both build and runtime).
COPY apps/eunenem-server/package.json apps/eunenem-server/pnpm-lock.yaml ./apps/eunenem-server/
WORKDIR /app/apps/eunenem-server
RUN pnpm install --frozen-lockfile

# Layer 3: source. node_modules + generated public/ excluded via
# .dockerignore so the COPY doesn't blow away the installed deps.
# scripts/ + migrations/ are included so `pnpm db:migrate` can be
# executed inside the container post-deploy (kysely runner reads
# migrations/ at runtime — see scripts/migrate.ts).
WORKDIR /app
COPY apps/eunenem-server ./apps/eunenem-server/
COPY src ./src/
COPY scripts ./scripts/
COPY migrations ./migrations/

# STRIPE_PUBLISHABLE_KEY is consumed by esbuild's `define` at BUILD time
# and inlined into the client bundle (see build.mjs / setup.ts:167-169).
# Without it the client bundle ships with an empty value and the Stripe
# iframe never mounts. Pass via docker-compose build.args (or
# `docker build --build-arg`) so the value reaches `pnpm build` below.
ARG STRIPE_PUBLISHABLE_KEY=""
ENV STRIPE_PUBLISHABLE_KEY=$STRIPE_PUBLISHABLE_KEY

# Bundle public/client.js (esbuild) + public/styles.css (Tailwind) into ./public.
WORKDIR /app/apps/eunenem-server
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3001
# Expose apps/eunenem-server/node_modules/.bin on PATH so root-level
# scripts that shell out to tsx (e.g. `pnpm db:migrate` → `tsx
# scripts/migrate.ts` per root package.json) can find it. tsx is a root
# devDep and was excluded by --prod, but the eunenem-server's full
# install includes it.
ENV PATH=/app/apps/eunenem-server/node_modules/.bin:$PATH
EXPOSE 3001

# Install the entrypoint script into a stable absolute path. It runs
# Kysely migrations before handing off to CMD so the running DB schema
# is always at-or-ahead of the code's expectations. See the script's
# header comment for the full rationale.
COPY --chmod=755 apps/eunenem-server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Hono server: serves SSR + static assets, /healthz health check.
# Runs from /app/apps/eunenem-server — server.tsx + relative imports
# resolve correctly from this WORKDIR.
CMD ["pnpm", "start"]
