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

## PR2 — Inter (migration 064)

Existing mTLS banking credentials plus required INTER_CONTA_CORRENTE; separate token with extrato.read only. No payout operation. Same PROVIDER_FEES_ENABLED default OFF gate for scheduling and writes; OFF removes both persisted schedules. Registration is best-effort with finite log + OTel counter, never a webhook boot dependency.

Official source (2026-10-23): https://developers.inter.co/redocusaurus/swagger-banking-yaml.yaml — /banking/v2/extrato/completo, idTransacao, TARIFA, detalhes.endToEndId, traditional pagination. One day/tick, max5 pages of1000; incomplete/429 commits nothing for that day. Start Sep1/2026 SP. Complete days re-scan daily for delayed fees; errors back off1h→24h, stop after8 attempts (manual retry needs separate authorization).

Only debit TARIFA + exact E2E is a candidate PIX fee. Missing E2E increments unmatched_count (possibly another banking product). Identity=provider+SHA256(origin/account)+environment+idTransacao, NOT E2E. Exact E2E maps to one same-platform Inter PIX payment; absent/ambiguous matches retain payment_id=null and must NOT enter Engine expense totals. matching_ref stays internal, never UI/log. Re-scans cannot overwrite original amount/E2E.

provider_fee_inter_scans: account_ref/day PK; last_success_at, last_reason, attempts, unmatched_count and lease/schedule fields. last_success_at null OR last_reason non-null means pending; attempts>=8 means exhausted. Successful empty statement does NOT confirm zero for a payment. Disabled/missing credentials/unobserved fee remains unknown.

064 adds matching_ref + scans with down; no existing payment/ledger mutation. Real PG + HTTP loopback OAuth/statement tests; transport seam replaces TLS only. No external calls. Peppy authorized September sample67 TARIFA/67distinct idTransacao/exact E2E links/4485BRL cents; October429 pending, not replayed by tests.

429 cooldown is account-wide: every claim checks all persisted scan rows for that account for `last_reason=rate_limited` with a future retry timestamp. No OAuth or statement HTTP is allowed during that interval, including from a fresh worker or another due day. Exhausted days still enforce the cooldown until it expires. No schema/UI contract change.
