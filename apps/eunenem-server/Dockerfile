# eunenem-server — Hono SSR React 19, esbuild-bundled hydration + Tailwind 4.
# Self-contained app (own pnpm-lock.yaml, no engine workspace deps).
FROM node:22-slim

WORKDIR /app

# Match the repo's pinned package manager (engine/package.json: pnpm@10.33.0).
RUN npm install -g pnpm@10.33.0

# Install dependencies first for layer caching. devDeps are required at runtime
# because `pnpm start` runs the server via tsx (server.tsx is not pre-compiled),
# and at build time for esbuild + the Tailwind CLI.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# App source (node_modules + generated public assets excluded via .dockerignore).
COPY . .

# STRIPE_PUBLISHABLE_KEY is consumed by esbuild's `define` at BUILD time
# and inlined into the client bundle (see build.mjs / setup.ts:167-169).
# Without it the client bundle ships with an empty value and the Stripe
# iframe never mounts. Pass via docker-compose build.args (or `docker build
# --build-arg`) so the value reaches `pnpm build` below.
ARG STRIPE_PUBLISHABLE_KEY=""
ENV STRIPE_PUBLISHABLE_KEY=$STRIPE_PUBLISHABLE_KEY

# Bundle public/client.js (esbuild) + public/styles.css (Tailwind) into ./public.
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# Hono server: serves SSR + static assets, /healthz health check.
CMD ["pnpm", "start"]
