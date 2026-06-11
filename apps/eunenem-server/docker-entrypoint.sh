#!/bin/sh
# eunenem-server container entrypoint.
#
# Runs Kysely migrations BEFORE handing off to the app process so the
# running schema is always at-or-ahead of the code's expectations. Without
# this, a redeploy that ships new migrations alongside code referencing
# them produces "column does not exist" 500s on the very first request
# that touches the new schema — banked precedent 2026-06-11, eunenem-staging
# had 7 migrations stack up over 8 days because rebuilds skipped migrate.
#
# Why a subshell for `pnpm db:migrate`:
#   The db:migrate script is declared in the REPO ROOT package.json
#   (`tsx scripts/migrate.ts`), not in apps/eunenem-server/package.json.
#   The Dockerfile's WORKDIR is /app/apps/eunenem-server, so a direct
#   `pnpm db:migrate` would fail with "missing script". Subshelling to
#   /app runs migrate in the right pnpm context, then exits — leaving
#   the parent shell's CWD (and the subsequent `exec "$@"`) untouched.
#
# Why `exec "$@"`:
#   Preserves PID 1 semantics for the CMD (`pnpm start`), so SIGTERM from
#   Docker reaches the app cleanly on container stop / redeploy.
#
# Idempotency:
#   Kysely's migrator skips already-applied migrations via the
#   kysely_migration table, so re-running on every boot is cheap and safe.
#
# Failure mode:
#   `set -e` + migrate.ts's `process.exit(1)` on error means the container
#   fails to start if a migration fails. This is the CORRECT failure mode
#   — better to refuse to boot than to silently run stale-schema code.
#   Dokploy surfaces the failed migration logs in the deployment view.
set -e

echo "[entrypoint] running pending migrations..."
( cd /app && pnpm db:migrate )
echo "[entrypoint] migrations done. starting app..."

exec "$@"
