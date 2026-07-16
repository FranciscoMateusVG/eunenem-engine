# Repasses Automáticos via Banco Inter PIX — Design

- **Date**: 2026-07-16
- **Status**: Approved in brainstorm (operator, 2026-07-16); spec pending operator review
- **BEADS epic**: `aperture-8mivl`
- **Base branch**: `staging`

## 1. Problem

EuNeném 2.0 has a complete money-in story (Stripe checkout, PIX + cartão, double-entry ledger, computed `saldoDisponivel`, settlement maturity via `balance_transaction.available_on`) and a complete repasse *workflow* (recebedores, `solicitado → aprovado` FSM, admin approval queue, one-pending-per-campanha lock) — but **no mechanism that actually moves money**. Today the operator approves a repasse, opens their bank app, sends the PIX by hand, and records a free-text `bankTransferRef`.

The legacy 1.0 system (repo `eunenem`, Mac Mini) *does* call Banco Inter's Banking API, but its implementation is disqualifying and must not be ported:

| 1.0 defect | Location | Consequence |
|---|---|---|
| `rejectUnauthorized: false` on the TLS agent | `src/lib/inter/getHttpsAgentWithCertificate.ts:25` | Cert validation disabled against a banking payment endpoint |
| Errors swallowed (`console.error` → return `undefined`) | `src/lib/inter/requestInterPayment.ts:153-155` | Failed PIX silently no-ops |
| Fresh idempotency UUID per invocation | `requestInterPayment.ts:76` | Clicking twice pays twice |
| Full recipient bank data logged | `generate-transfer-request-button.tsx:20` | PII in logs |
| Inter-side `APROVACAO` response treated as success | caller checks `tipoRetorno === 'APROVACAO'` | A payment *parked awaiting approval inside Inter* is recorded as transferred |
| Hand-maintained 2,156-line bank→ISPB table | `src/lib/inter/getBankIsbp.ts` | Only needed for bank-coordinate transfers |

This design replaces the manual step in 2.0 with a programmatic PIX-out that is correct where 1.0 was not.

## 2. Decisions (operator-locked, 2026-07-16)

1. **Rail**: Banco Inter Banking API (PIX payment), rewritten properly. Existing Inter account, OAuth2 client credentials, and mTLS certificate are reused.
2. **Trigger**: **approve = pay**. The admin's single `Aprovar` action in the existing queue fires the transfer (asynchronously). No second click.
3. **Queue**: **pg-boss**, riding the existing Postgres (`pg` driver already a dependency; no Redis, no new infra). Worker runs in-process in the Hono server.
4. **Recipient scope**: **PIX-key recebedores only** (`metodo = 'pix'`). Bank-coordinate (`metodo = 'conta'`) recebedores stay on the existing manual `bankTransferRef` path. The ISPB table is not ported.
5. **Fees**: **no withdraw fee.** The platform cut is already booked at money-in (`credito_receita_plataforma`); the recipient receives their full `saldoDisponivelCents`. No new fee lancamento type.

## 3. Architecture

Follows the existing ports-and-adapters shape (mirror of the Stripe `PagamentoProvider` pattern in `src/adapters/pagamentos/`).

### 3.1 New port — `TransferenciaProvider`

Domain: `pagamentos/financeiro`.

```ts
interface TransferenciaProvider {
  // Fires a PIX to a chave. `referencia` is the caller-supplied stable
  // reference (derived from repasse id) used for reconciliation/search.
  pagarPix(input: {
    chave: string;                     // chave PIX (cpf/cnpj/email/telefone/aleatoria)
    valorCents: number;
    descricao: string;                 // e.g. "EuNeném — repasse <shortid>"
    referencia: string;                // stable per repasse; NEVER regenerated on retry
  }): Promise<
    | { outcome: 'pago'; codigoSolicitacao: string }
    | { outcome: 'agendado_aprovacao'; codigoSolicitacao: string }  // Inter-side approval workflow
    | { outcome: 'rejeitado'; codigoSolicitacao?: string; erro: string }
  >;

  consultarPagamento(codigoSolicitacao: string): Promise<
    { status: 'pago' | 'em_processamento' | 'aguardando_aprovacao' | 'cancelado' | 'rejeitado'; raw: unknown }
  >;

  // Reconciliation fallback when we crashed before capturing codigoSolicitacao:
  // search Inter's payment history in a date window and match by valor + chave + referencia.
  buscarPagamentos(input: { dataInicio: string; dataFim: string }): Promise<
    Array<{ codigoSolicitacao: string; valorCents: number; chave?: string; status: string }>
  >;
}
```

### 3.2 Adapters

- **`provider.inter.ts`** — real adapter.
  - OAuth2 `client_credentials` against Inter's token endpoint, scopes: `pagamento-pix.write` + the read scope required for consult/search. Token cached until expiry.
  - mTLS via client certificate + key. **Default TLS verification — `rejectUnauthorized` is never touched.**
  - Endpoint: `POST /banking/v2/pix` with `destinatario` of type **CHAVE** (no bank-data variant, no ISPB lookup).
  - Response mapping: Inter's `tipoRetorno` of `PAGAMENTO` → `pago`; `APROVACAO` → `agendado_aprovacao` (explicitly NOT success — see §6).
  - Every error path throws or returns a typed outcome. Nothing is swallowed.
  - Logs carry repasse id + codigoSolicitacao only. **No chave PIX, no CPF, no recipient name in logs.**
- **`provider.fake.ts`** — test/staging adapter, mirroring `pagamentos/provider.fake.ts`. Supports forced outcomes per call: `pago`, `agendado_aprovacao`, `rejeitado`, thrown network error, timeout (hang), and scripted consult sequences (`em_processamento → pago`, etc.).

### 3.3 pg-boss

- Added as a dependency of `apps/eunenem-server`; `boss.start()` in the Hono server boot; pg-boss keeps its own schema in the same Postgres.
- **Transactional enqueue**: the `repasse.executar` job row is inserted **inside the same DB transaction** as `aprovarRepasseTransaction` (pg-boss `send` with the transaction's client / `db` option). The FSM transition to `aprovado` and the job's existence are atomic — no approved-but-lost, no fired-but-rolled-back.
- Job types:
  - **`repasse.executar`** — performs the transfer (see §5). Retry policy: `retryLimit: 4`, exponential backoff, but **retries apply only to safe-to-retry failures** (see §6); ambiguous outcomes divert to `verificando` instead of retrying.
  - **`repasse.confirmar`** — polls `consultarPagamento` until terminal status. Scheduled with increasing delay (30s, 2m, 10m, 1h, then every 6h up to 48h); escalates to `falhou` + operator alert if still non-terminal after the window.
- Worker concurrency 1 for `repasse.executar` (payout volume is tiny; serialization removes a whole class of races).

## 4. Data model

### 4.1 Repasse FSM extension

Current: `solicitado → aprovado`. New:

```
solicitado → aprovado → transferindo → pago
                             ├→ verificando → pago | falhou
                             └→ falhou ──(admin retry)──→ transferindo
                                   └──(admin cancel)──→ cancelado
```

- `cancelado` (terminal, admin-only, reachable only from `falhou`): the escape hatch for **permanent** failure causes (invalid/typo'd chave). Inside a `FOR UPDATE` transaction: clear `id_repasse` on the linked lancamentos (they return to the `disponivel` bucket naturally — the bucket derivation keys on `id_repasse IS NULL`) + FSM → `cancelado`. The user fixes their recebedor and re-solicitars fresh. This is the only claim-release path in the system; it carries an audit line with the acting admin. A cancelled repasse can never be retried.

- `aprovado` becomes transient: the admin action commits `aprovado` + enqueues the job; the worker moves it to `transferindo` when it picks up.
- `verificando` = "a payment may exist at Inter and we don't know its outcome." Only the confirm/reconcile path may leave this state. **No new `pagarPix` call is ever made from `verificando`.**
- `falhou` = confirmed no-money-moved. Re-approvable by admin (retry button) → back to `transferindo` with a **new attempt** (see idempotency, §6).
- Terminal: `pago`. **Resolved at implementation (Rex, 2026-07-16, aperture-vvh2j):** the ledger is credit-only — the "debit" is a `transferido_em` stamp on the linked `credito_saldo_recebedor` rows, previously booked at approval. The stamp is **deferred to `pago`**: money is never marked as moved until the PIX actually succeeds, so `falhou` needs no compensating entry and retry cycles never stamp/clear/re-stamp. Consequence: the funds-claim mechanism (pending-repasse bucket + one-pending-per-campanha lock) must treat **all non-terminal post-`solicitado` states (`aprovado`, `transferindo`, `verificando`, `falhou`) as claiming the lancamentos** — `saldoDisponivel` must never re-expose funds mid-transfer or during a retry window, and a `falhou` repasse must still block a new `solicitar` for the same campanha.

### 4.2 New columns (migration)

On the repasse table:

| Column | Type | Purpose |
|---|---|---|
| `transfer_status` | text (FSM above) or fold into existing status column — implementer's call with Rex | operational transfer state |
| `inter_codigo_solicitacao` | text null | Inter's payment id, set as soon as known |
| `transfer_referencia` | text not null (for new rows) | stable reference, derived from repasse id (e.g. `uuidv5(repasseId, NAMESPACE)`), generated **once at approval** |
| `transfer_attempts` | int default 0 | attempt counter |
| `last_transfer_error` | text null | operator-facing error detail |

New table `repasse_transfer_attempts` (append-only audit): `id, repasse_id, attempt_no, referencia, started_at, request_summary (no PII), outcome, codigo_solicitacao, error, finished_at`. The **intent row is inserted and committed BEFORE the HTTP call** — if the process dies mid-call, the orphaned intent row is the signal that a payment may exist (reconciliation input).

`bankTransferRef` (free-text) survives unchanged as the manual path for `conta` recebedores.

## 5. End-to-end flow

1. User (list owner) requests resgate — existing `extrato.solicitar` → repasse `solicitado`. Unchanged.
2. Admin reviews in the existing queue (`admin-router.ts` `repasses.aprovar`). On approve:
   - If recebedor `metodo = 'pix'` → transaction: FSM → `aprovado`, generate `transfer_referencia`, enqueue `repasse.executar`. Commit.
   - If `metodo = 'conta'` → existing manual path (approve + type `bankTransferRef`). Unchanged.
3. Worker (`repasse.executar`):
   a. Load repasse `FOR UPDATE`; assert state ∈ {`aprovado`, `falhou`-being-retried}; FSM → `transferindo`.
   b. Insert + commit intent row in `repasse_transfer_attempts`.
   c. Call `pagarPix(chave, valorCents, descricao, referencia)`.
   d. Outcome:
      - `pago` → record codigoSolicitacao, FSM → `pago`. Done.
      - `agendado_aprovacao` → record codigoSolicitacao, FSM → `verificando`, enqueue `repasse.confirmar`.
      - `rejeitado` (clean, payment definitely not created) → FSM → `falhou`, record error. pg-boss retry only for transient classes (5xx/network-before-send); permanent rejections (invalid key, insufficient balance) do NOT auto-retry — they surface to the admin.
      - Timeout / crash / unknown → FSM → `verificando`, enqueue `repasse.confirmar`.
4. Worker (`repasse.confirmar`):
   - With `codigoSolicitacao`: poll `consultarPagamento` → terminal `pago`/`rejeitado`/`cancelado` resolves the FSM accordingly (`rejeitado`/`cancelado` → `falhou`, retryable by admin).
   - Without it (crash before response): `buscarPagamentos` over the attempt window, match by valor + chave + referencia. Found → adopt its codigoSolicitacao and resolve. Definitively absent after the search window → `falhou` (safe to retry).
   - Exhausted schedule without resolution → stay `verificando`, alert operator (this should be ~never).
5. Admin UI (`/admin/repasses`, currently stubbed): show the new states, error detail, attempt history, and — in `falhou` only — two actions: **Retry** (re-fires the transfer) and **Cancelar** (terminal; releases the claimed funds; confirm modal, irreversible). `cancelado` rows render terminal/muted, no actions. Extrato UI — **v1 ships the honest 5-state collapse** (decided 2026-07-16, aperture-voao0 scope flag): the extrato is lançamento-grain keyed on `liberacao` and does not surface the repasse FSM, so in-flight repasses (aprovado/transferindo/verificando/falhou) render as "solicitado", `pago` renders as "transferido", and `cancelado` visibly returns funds to "disponível". This is truthful (funds genuinely remain claimed while in flight) and unblocks the POC. The original granular copy (— "transferência em andamento" / "problema na transferência — nossa equipe foi notificada" —) requires extending the extrato row DTO to expose per-lançamento repasse transfer status and is deferred to fast-follow **aperture-dtda0** (Rex DTO extension + Vance copy mapping, post-epic).

## 6. Idempotency & double-pay prevention (the core invariant)

**Invariant: at most one successful PIX per repasse, ever.**

Enforcement layers:

1. **FSM + `SELECT FOR UPDATE`** — only `aprovado` or admin-retried `falhou` may enter `transferindo`; single-concurrency worker; the existing one-pending-repasse-per-campanha partial unique index stays.
2. **Stable `transfer_referencia`** — generated once at approval, reused across all attempts. Retries are the *same* payment identity, not a new one. (1.0's fresh-UUID-per-click is the named anti-pattern.)
3. **Intent-before-call** — an attempt row exists before any HTTP request, so no payment can exist that we have no record of.
4. **Ambiguity never auto-retries** — any outcome where a payment *might* exist (`timeout`, crash, `agendado_aprovacao`) goes to `verificando` and must be positively resolved via consult/search before any further attempt. Blind retry after unknown outcome is the double-pay door; it stays shut.
5. **Admin retry only from `falhou`** — which is only reachable when we have positive knowledge no money moved.

## 7. Security

- **Secrets in Infisical** (project `eunenem`): `INTER_CLIENT_ID`, `INTER_CLIENT_SECRET`, `INTER_CERT_B64`, `INTER_CERT_KEY_B64`. Injected via the existing `infisical run` entrypoint. Never in compose files, never in Dokploy env fields, never committed.
- mTLS with **default certificate verification**. Any code path touching `rejectUnauthorized`, `NODE_TLS_REJECT_UNAUTHORIZED`, or custom CA trust must be flagged in review (Cipher gate).
- OAuth scopes minimal: payment-write + the consult/search read scope. No other banking scopes.
- No PII (chave, CPF, recipient name) in logs, traces, or error strings persisted to `last_transfer_error` — error detail references Inter's error codes + codigoSolicitacao only.
- Staging **cannot** hold prod Inter credentials (fake adapter only, or a separate Inter sandbox credential if adopted later — ties into `aperture-68zbw` prod/staging secret differentiation).
- **Adapter selection is env-driven** (`TRANSFERENCIA_PROVIDER=fake|inter`) with a **boot guard**: the server refuses to start with the real adapter unless `NODE_ENV=production`. Staging structurally cannot fire real transfers.
- Cipher reviews the adapter + the aprovar path pre-merge (money movement = mandatory security gate).

## 8. Testing

- **Unit** (fake adapter): FSM transition matrix incl. every outcome branch of §5.3d; idempotency invariants of §6 (esp. referencia stability across retries, no-call-from-`verificando`); permanent vs transient error classification.
- **Integration** (real Postgres + pg-boss, fake adapter): transactional enqueue (approve rollback ⇒ no job; approve commit ⇒ exactly one job); crash-mid-call simulation → orphan intent row → reconciliation resolves; confirm-job polling sequences; double-approve race (two admins) yields one transfer.
- **Adversarial** (Izzy): try to make it double-pay — concurrent approves, retry storms, worker restarts mid-`transferindo`, poison consult responses.
- **E2E**: fake adapter; the resgate → approve → "transferido" walk on staging.
- **Prod smoke** (operator-gated): one real repasse of ~R$1 to the operator's own chave PIX; verify arrival, `pago` state, attempt audit row, and clean logs.

## 9. Out of scope

- Bank-coordinate (`conta`) automation — stays manual (`bankTransferRef`).
- Stripe Connect — remains "a future adapter" per the existing code comment.
- Payout scheduling, batching, or auto-approval below thresholds.
- The 1.0 system and its withdraw history — untouched; dies on its own timeline.
- Withdraw fees.
- Inter webhook ingestion (polling suffices at this volume; revisit if Inter's webhook for pix payments proves trivial during implementation).

## 10. Open questions (to resolve at implementation time, not blockers)

1. Where exactly the current `aprovarRepasse` books the `resgatado` debit — if at approval, `falhou` needs a compensating entry (§4.1 checkpoint, Rex).
2. Whether Inter's current Banking API version still shapes responses as `tipoRetorno: PAGAMENTO|APROVACAO` — verify against live docs before freezing the adapter mapping; the port's outcome union is the stable contract regardless.
3. Whether the Inter account has the "payment approval workflow" enabled (which forces every API payment into `APROVACAO`) — if so, operator should disable it for API payments or the confirm path becomes the common case.
4. pg-boss schema placement + migration ownership (its own schema vs app migrations dir) — Rex + Peppy call.

## 11. Implementation shape (for the plan that follows)

Suggested children (GLaDOS decomposes after spec approval):

1. **Rex** — migration (columns + attempts table), port + fake adapter, FSM extension, use-case changes (`aprovar` enqueue, executar/confirmar handlers), pg-boss bootstrap.
2. **Rex** — `provider.inter.ts` (OAuth + mTLS + endpoint mapping) behind the port.
3. **Vance** — `/admin/repasses` real UI (states, error detail, retry) + extrato user-facing copy.
4. **Izzy** — unit/integration/adversarial suites per §8.
5. **Cipher** — adapter + secrets + logging review (pre-merge gate).
6. **Peppy** — Infisical secrets provisioning, deploy wiring, staging fake-adapter default.
7. **Operator** — Inter credential export, R$1 prod smoke.
