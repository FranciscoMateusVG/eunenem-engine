# eunenem-server — Hono SSR React 19, esbuild-bundled hydration + Tailwind 4.
#
# Build context is the REPO ROOT (configured in docker-compose.yml as
# `build.context: ../../`), NOT apps/eunenem-server/, because the app
# imports from the repo-root `src/` via relative paths like
# `../../../../src/domain/...` (engine BCs + observability). The app is
# not workspace-packaged; the imports resolve via the actual filesystem
# layout. So the container must mirror the repo layout under /app.
FROM node:22-slim

WORKDIR /app

# Match the repo's pinned package manager (engine/package.json: pnpm@10.33.0).
RUN npm install -g pnpm@10.33.0

# Layer-cache the dep install: copy ONLY the app's package files first.
COPY apps/eunenem-server/package.json apps/eunenem-server/pnpm-lock.yaml ./apps/eunenem-server/
WORKDIR /app/apps/eunenem-server
RUN pnpm install --frozen-lockfile

# Now copy the actual source: the app + the engine root src/ (cross-app
# imports walk up to it via ../../../../src/...). node_modules + generated
# public/ excluded via .dockerignore.
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
