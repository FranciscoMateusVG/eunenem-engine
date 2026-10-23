# Provider processing expenses — PR1 foundation + Stripe

Operator scope: observed fees only; no contract estimate, no surcharge-as-cost.
Staging only. PR2 adds Inter TARIFA/E2E ingestion; PR3 adds the admin view.

## Runtime / rollout

Migration 063 adds `provider_fee_events` and `provider_fee_sync`; no payment or
ledger row is rewritten. Down removes only these new projections. The event payment FK intentionally RESTRICTs hard deletion of referenced payments to preserve financial audit history; no silent cascade. Back up before
applying per normal deploy practice. Generated types came from migrated throwaway PG.

The existing server composition constructs a read-only Stripe fee reader from the
same SDK used for checkout. No credentials/fake rail => no provider calls and no
invented fees. `PROVIDER_FEES_ENABLED=false` by default (no new secret): schedule AND service writes require explicit true. Promotion alone cannot start collection. Existing pg-boss owns the
worker, lifecycle shutdown and schedule. Before enabling, run `deps.providerFeeSync.run({dryRun:true})` in the authorized diagnostic context; this is count-only and works with the flag OFF. It is NOT in the boot path: failure cannot take down webhooks. Once enabled, every five minutes the worker
admits up to20 historical rows and reads up to5 due payments, earliest due first.
History starts 2026-09-01 00:00 São Paulo. No manual provider request or send endpoint.

Eligibility: EuNeném tenant, Stripe credit_card, approved OR refunded; no pending,
rejected, other tenant or pre-launch records. GET charge (or PI fallback) expands
balance_transaction. Captured+paid charge and well-formed observed fee are required.
Amount0 is confirmed evidence; missing/error remains pending with exponential backoff (5min doubling, cap24h) and at most8 attempts; then failed, never zero. Missing refs,404,auth and identity conflict fail immediately; timeout remains retryable. Failed rows need an explicit operator-approved retry after the underlying issue is corrected.
SDK calls:10s timeout, zero immediate retries. A180s lease/claim token plus unique
provider/account/environment/txn prevents concurrent duplicate observations. No
connection is held during HTTP. Account is read via GET/v1/account, never derived
from or logged with the secret. HTTP errors are stored only as finite reason codes.

Refund does not erase the original processing fee. Disputes, report-only/IC+
fees, standalone additional charges and explicit fee credits are not imported by
this first reader. They are not silently estimated. The first sample confirmed
ordinary balance_transaction.fee in all30 inspected Stripe payments; it does not
prove complete historical coverage. Rows without ch_/pi_ stay pending for later
resolution. Missing credentials are visible as no successful fee observations.

## Verification

Real Postgres + Stripe SDK against HTTP loopback: observed fee≠surcharge,
dry-run/no mutation/no calls, Sep cutoff, duplicate/concurrent runs, refund
preservation, null→pending and zero→confirmed, error-body non-persistence, tenant
and payment-status isolation. Real pg-boss invokes the production registration;
real server composition is tested without provider credentials.

Production sample (Peppy4447; read-only authorized,2026-10-23):30Stripe transactions
all expanded fee present. Inter September67TARIFA/67 exact E2E matches; October429
is pending, not zero. These are not a seed or permission for further production
writes. No automatic production deployment/promotion is authorized.
