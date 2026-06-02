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
WORKDIR /app
COPY apps/eunenem-server ./apps/eunenem-server/
COPY src ./src/

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
EXPOSE 3001

# Hono server: serves SSR + static assets, /healthz health check.
# Runs from /app/apps/eunenem-server — server.tsx + relative imports
# resolve correctly from this WORKDIR.
CMD ["pnpm", "start"]
