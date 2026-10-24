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

## aj60v — decimal-string rejection / safe reprocessing (2026-10-24)

Diagnosis: one authorized read-only day (Peppy4758) returned44 rows,21 debit TARIFA with valid E2E;20 passed and1 failed the fixed-two-decimals regex. All21 had nonempty string identity and valid date equal to requested day. The rejected amount was a positive decimal string; its actual digits/precision were not retained or exposed. This proves the parser branch, not the exact representation or the cause of every one of the11 failed days.

The official OpenAPI `TransacaoCompleta.valor` is a string, not a requirement to print two decimals (https://developers.inter.co/redocusaurus/swagger-banking-yaml.yaml, checked2026-10-24). Operator-approved policy4762: integer,1 or2 decimal digits normalize exactly to cents; extra fractional digits must be zeros. No floats, exponent/comma/sign, rounding, fallback or invented zero. Existing10-integer-digit bound remains.

After complete pagination, valid fees can commit even if another candidate is invalid. The scan keeps `last_reason=invalid_fee`, does not advance `last_success_at`, preserves attempts/backoff and remains incomplete. There is no per-row error ledger/migration; the persistent marker is the existing day-level reason. API failure/incomplete pagination and identity conflicts still commit no fees for the day. Dedupe keys and amount/E2E conflict guards are unchanged.

Reprocessing after approved hotfix: existing non-exhausted days retry under current backoff. To accelerate or revive exhausted days, Peppy must have explicit authorization for the exact11 day/account rows, preserve a before-image, and requeue only those with `last_reason='invalid_fee'` and no unexpired claim. Set `attempts=0,next_attempt_at=now()` and clear expired claim fields; keep the reason until a successful scan. Do NOT delete fee events, reset successful days, bypass account-wide429 cooldown, or manually call financial operations. Existing worker imports by provider/account/environment/idTransacao; repeated observations cannot duplicate or replace the original amount/E2E.

Acceptance after rollout (RO aggregates): exact target-day count, reasons/success timestamps, event count/sums and duplicate-key count. This PR does not perform production requeue or assert all11 days are already fixed. Synthetic PG+HTTP tests cover decimal normalization, partial invalid→corrected retry→repeat with exactly2 rows, malformed precision rejection,429 atomicity and identity-conflict rollback.


## yr3fj — zero observado / franquia Inter (24/10/2026)

Decisão explícita do operador: há franquia mensal de PIX, sem fixar ou estimar
quantidade/valor. Na cobertura, um pagamento Inter com E2E válido, pelo menos
72 horas desde sua criação e scan completo bem-sucedido do seu dia (SP), na
conta ativa e sem erro atual, conta como confirmado sem tarifa quando não há
evento vinculado nem evento dessa conta com o mesmo E2E. Sem scan, outra conta,
erro, E2E ausente ou prazo insuficiente continuam pendentes/falhos.

A classificação é derivada em leitura, sem evento monetário fictício/migration.
Uma tarifa real vinculada tem precedência; sua chegada remove a classificação
de franquia automaticamente, sem duplicar pagamento ou somar um valor estimado.
A UI discrimina “N PIX sem tarifa – franquia” dentro dos confirmados. Não é
garantia contratual de gratuidade futura: descreve ausência observada com a
janela de tolerância decidida pelo operador.


## 7513q — coleta agendada 3x/dia (24/10/2026)

Escopo final aprovado: **sem webhook novo**, sem configuração na conta Stripe.
As duas filas existentes passam para cron `0 6,14,22 * * *` com timezone
`America/Sao_Paulo` (06:00/14:00/22:00 SP). O registro substitui o cron antigo;
flag OFF continua removendo os schedules e impedindo escrita.

Cada execução drena os elegíveis vencidos no instante de admissão, em lotes
sequenciais existentes (Stripe: até 20 admissões/5 claims; Inter: um dia por
claim). HTTP/paginação, leases, attempts/tetos, backoff e cooldown Inter por
conta são mantidos. Uma tentativa que ganha backoff não é repetida na mesma
execução, mesmo que a execução atravesse esse horário. Trabalho já claimed
por outra instância não é tomado. A expiração externa do job passa de 240s
para 6h (abaixo do intervalo de 8h), para caber a drenagem; retry pg-boss=0.
Não altera a franquia derivada de 72h nem inventa tarifas.

Gate operacional após deploy: conferir ambos os schedules persistidos
(cron/timezone), flag, saúde e resultado do próximo horário. Nenhum envio ou
transferência; somente coleta já autorizada. Não há migration/env nova.
