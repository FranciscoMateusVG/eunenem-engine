# Plan 0014 — Banking provider integration & repasse execution

> 📌 **Addendum 2026-06-03 — deferred by [0015](./0015-contribuicao-pagamento-financeiro-collapse.md).**
>
> 0015's v1 transfer model is **manual**: an admin (or operator) marks a lançamento's `transferidoEm` timestamp when the money actually reaches the recebedor (out-of-band, via the bank's web UI or an existing operations workflow). There is no automated Stripe Connect, no Inter PIX-out API call, no banking-provider port wired into the lançamento lifecycle. The implicit state of a lançamento ("pending / transferred / cancelado") becomes a query-time predicate over `transferidoEm` + `canceladoEm` — see 0015 §Locked-decisions 9.
>
> This plan's full scope — `BankingProvider` port, `executarRepasseRecebedor` use case, real Inter adapter, dual-approval workflow, reconciliação of bank webhooks — becomes a **separate future plan** that ships *after* 0015 has been running in production with the manual model long enough for the operator to confirm the automation is worth the irrevocable-money risk. The HIGH-RISK guardrails below remain non-negotiable for that follow-up plan.
>
> What stays useful from this plan today: the **DDD framing** (ingress vs egress money, asymmetric risk, per-plataforma egress configuration, idempotency at the bank boundary), the **operational guardrails section** (dry-run mode, idempotency-key audit log, per-day cap, production toggle), and **the open-questions list** (Q1–Q10) which still need answers before any automated transfer ships. Treat the rest of this document as the design draft for the follow-up plan, not as an in-flight implementation guide.
>
> ---
>
> **Status**: drafted 2026-05-24, awaiting confirmation. **Many decisions deliberately left open** — see "Open questions to answer before phases start" below. Don't begin implementation until those are resolved.
>
> ⚠️ **HIGH-RISK PLAN**: PIX-out transfers are **irrevocable real money** the moment the bank accepts them. A bug here pays the wrong recebedor and there is no chargeback. The Phase-1-decisions-before-code discipline matters double here. Required: written ops runbook before Phase 5 lands.
>
> **Depends on**: plan `0002-checkout-orchestration-layer-done.md` (defines current Repasse aggregate + `solicitarRepasseRecebedor` use case).
> **Interacts with**: plan `0004-async-confirmation-and-webhooks.md` (banking webhook flow mirrors pagamento webhook flow), plan `0005-durable-event-log-and-worker-queue.md` (transfer reconciliação rides on the scheduler), plan `0007-webhook-authn-authz.md` (bank webhooks need signature verification too), plan `0009-plataforma-management-and-admin-ux.md` (per-plataforma bank account config), plan `0012-estorno-and-chargeback-cascade.md` (egress-side reversal patterns), plan `0013-provider-fee-passthrough.md` (egress-side fee analog).

## Goal

Today `solicitarRepasseRecebedor` (src/use-cases/financeiro/solicitar-repasse-recebedor.ts:35) creates a `RepasseRecebedor` with status `solicitado` and stops there. **It never calls a bank.** The actual money movement happens outside this codebase — presumably via Inter's web UI or a manual ops process.

This plan introduces the missing infrastructure so the engine can:

1. Initiate real bank transfers (PIX-out via Inter, later Nubank or others) when a repasse is solicitado.
2. Track the transfer through its real lifecycle: `solicitado` → `processando` → `concluido` | `falhou` | `cancelado`.
3. Receive bank confirmations (webhook or poll) and update the repasse + Financeiro books idempotently.
4. Reconcile stuck transfers via a scheduled job.
5. Charge the bank's per-transfer fee back to the books (analogous to plan 0013's provider fee, but on the egress side).
6. **Be swappable** between Inter and Nubank (and any future bank) via the hexagonal port pattern, with zero domain code changes.

## What this plan does NOT cover (deferred)

- **TED / DOC support** unless Q2 decides to include them. PIX-out covers ~95% of Brazilian repasses today.
- **Foreign currency / international wires.** BRL-only, domestic-only.
- **Dual-approval workflow UI** for large transfers. The data model accommodates it (Q6) but the UX is plan 0009's admin surface (or its own).
- **Bank account opening / KYC** for plataformas. Out of scope; assumed already done.
- **Crédito / loans / advances against future repasses.** Different financial product.

## Locked decisions

These are the few choices that aren't worth debating; the real decisions are in "Open questions" below.

1. **Hexagonal port for BankingProvider, adapters per bank.** Same pattern as `PagamentoProvider`. The engine never imports Inter SDK directly; the adapter does. Swapping Inter for Nubank means writing a second adapter class.

2. **Repasse becomes an asynchronous lifecycle.** Even PIX-out, which is "instant," is *asynchronous from the engine's perspective* — we send the request, the bank queues/processes, returns "processando," confirms later via webhook or poll. Treat instant as a special case of async, not the default. (Mirror of plan 0004's lesson for pagamentos.)

3. **Repasse gains `processando` and `falhou` states + bank-side metadata.** The state machine extends from `solicitado | concluido` (today's apparent shape) to `solicitado | processando | concluido | falhou | cancelado`, with persisted fields `idTransferenciaBancaria`, `nomeBanco`, `iniciadaEm`, `confirmadaEm`, `motivoFalha`.

4. **Idempotency at the bank boundary is mandatory, not optional.** Every transfer initiation must carry an idempotency key derived from `idRepasse`. Retries (network errors, ambiguous timeouts) must NOT create duplicate transfers. The bank's idempotency contract is the contract — we adhere strictly.

5. **No transfer initiation in-line with `solicitarRepasse`.** Solicit + execute are separate use cases. Solicit creates the record (today's behavior, preserved). Execute (new) sends to bank. Reason: a human or scheduled job decides *when* to execute (e.g. batch at end of day, dual-approval workflow, ops circuit-breaker).

6. **Banking provider port stays minimal in v1.** PIX-out + status query + webhook parse + signature verify. No fancy features (scheduled transfers, batch transfers, balance queries). Add only as concrete need arises.

7. **`PagamentoProvider` and `BankingProvider` are separate ports.** They look similar but are *different domains* (ingress vs egress money). Coupling them forces unnatural API shape on both sides. Two ports, two adapter trees.

## DDD concepts this plan teaches

### Ports for ingress vs egress money

Pagamento providers (Stripe) bring money *in*. Banking providers (Inter) send money *out*. The temptation is one "PaymentProvider" port for both. Resist: the failure modes are inverted (declined card vs rejected transfer), the timing models differ (settlement vs irrevocable instant), and the risk model is asymmetric (incoming declined = no harm; outgoing wrong = real loss). Two ports, two domains, two adapter trees.

### Operationally dangerous = more guardrails

Most use cases are "create a row" or "update a status." This one *moves real money*. The lesson: when an operation has irrevocable real-world side effects, the engineering bar is higher — idempotency is non-negotiable, dry-run mode is mandatory, audit trail is comprehensive, confirmation steps are explicit. Not because we're paranoid, because the cost of getting it wrong is asymmetric.

### Asynchronous lifecycle even when "instant"

PIX-out is real-time *for the user*. From the engine's perspective it's still: send request → bank acknowledges → bank settles → bank confirms. Modeling that as four steps (even when they happen in 800ms) preserves correctness when the bank is slow or fails mid-flight. "Always asynchronous" is a useful default for anything crossing a process boundary, period.

### Per-plataforma egress configuration

Plataforma A uses Inter; plataforma B uses Nubank; both run on the same engine. The bank choice IS domain data (it determines fees, timing, failure modes). It belongs alongside `RegraTaxa` and (when 0013 lands) `RegraTaxaProvedor` — a per-plataforma configuration aggregate that the use case resolves at execution time.

### Provider fees on egress mirror plan 0013 on ingress

Plan 0013 added a 3rd lancamento for provider fees on incoming pagamentos. The bank charges per transfer too (e.g. R$0.50 per PIX-out for Inter business plans). The same modeling discipline applies: a distinct lancamento category (`debito_taxa_banco_repasse`), never blended into receita or saldo, separately reconcilable.

## Phases

> ⚠️ **Phase shape depends on the open-questions resolutions.** The phase outline below is a *plausible* sequence assuming sensible defaults; revisit before execution.

### Phase 1 — Resolve the open questions (no code) + ops runbook draft

**Objective**: Hold a working session, walk through the open questions below, lock the decisions, and revise this plan's "Locked decisions" section in place. **Additionally**: draft an `ops/repasse-runbook.md` covering rollback, ops escalation, and the "wrong recebedor" recovery scenario.

**Deliverable**: this file's "Open questions" section becomes empty (or shrunk to genuinely-implementation-time questions), "Locked decisions" gains the new entries, and `ops/repasse-runbook.md` exists.

**STOP for confirmation.**

---

### Phase 2 — Repasse aggregate lifecycle expansion

**Objective**: `RepasseRecebedor` learns the full state machine + bank-side fields. No bank integration yet — just the domain shape and persistence.

**Files NEW**:
```
src/errors/financeiro/
├── repasse-transicao-status-invalida.error.ts
└── repasse-falha-bancaria.error.ts
migrations/
└── 20280101_001_add_banking_fields_to_repasses.ts
```

**Files MODIFIED**:
- `src/domain/financeiro/entities/repasse-recebedor.ts` — add `status: 'solicitado' | 'processando' | 'concluido' | 'falhou' | 'cancelado'`, `idTransferenciaBancaria: string | null`, `nomeBanco: string | null`, `iniciadaEm: Date | null`, `confirmadaEm: Date | null`, `motivoFalha: string | null`. Add transition helpers (`podeIniciar`, `podeConcluir`, `podeMarcarFalha`, `podeCancelar`).
- `src/adapters/financeiro/livro-repository.{memory,postgres}.ts` — persist new fields; conformance covers round-trip.

**Verification**: `pnpm check` green; state-machine transitions tested exhaustively (legal + illegal transitions); existing solicitarRepasseRecebedor still works (creates with `solicitado`).

**STOP for confirmation.**

---

### Phase 3 — `BankingProvider` port + fake adapter

**Objective**: Define the port with minimum surface; fake adapter for tests + demo (configurable success / failure / delay).

**Files NEW**:
```
src/adapters/banking/
├── banking-provider.ts                     # port
├── banking-provider.fake.ts                # demo + tests (configurable response)
└── webhook-verifier.ts                     # port (mirrors plan 0007's pagamento verifier)
src/domain/banking/value-objects/
├── transferencia-bancaria.ts               # TransferenciaIniciada, StatusTransferencia
├── evento-bancario.ts                      # EventoBancarioNormalizado
└── ids.ts                                  # IdTransferenciaBancaria, etc.
tests/unit/banking/
└── banking-provider-fake.test.ts
```

**Port shape (v1)**:
```ts
interface BankingProvider {
  readonly nomeBanco: string;

  iniciarTransferenciaPix(input: {
    idRepasse: IdRepasse;
    chavePix: ChavePix;
    nomeTitular: string;
    amountCents: MoneyCents;
    idempotencyKey: string;  // derived from idRepasse
  }): Promise<TransferenciaIniciada>;

  consultarStatusTransferencia(
    idTransferenciaBancaria: string,
  ): Promise<StatusTransferencia>;

  parseWebhook(input: {
    rawBody: string;
    headers: Record<string, string>;
  }): EventoBancarioNormalizado;
}

interface BankingWebhookSignatureVerifier {
  readonly nomeBanco: string;
  verify(input: { rawBody: string; headers: Record<string, string>; agora: Date }):
    | { valido: true }
    | { valido: false; motivo: 'signature' | 'timestamp' | 'malformed' };
}
```

**Out of scope**: real Inter adapter (Phase 6), real Nubank adapter (later plan), batch transfers, scheduled transfers, balance queries.

**Verification**: fake adapter exercises all status paths (processando, concluido, falhou) deterministically; webhook parser round-trips.

**STOP for confirmation.**

---

### Phase 4 — `executarRepasseRecebedor` use case (initiates transfer)

**Objective**: A use case that takes a `solicitado` repasse and sends it to the bank. Idempotent on `idRepasse`.

**Files NEW**:
```
src/use-cases/financeiro/
└── executar-repasse-recebedor.ts
src/errors/financeiro/
└── repasse-nao-executavel.error.ts          # status != solicitado, or already processando
```

**Behavior**:
```ts
executarRepasseRecebedor(deps, { idRepasse })
  → fetch repasse
  → guard: status must be 'solicitado' (idempotent if already 'processando' with this idempotency key)
  → resolve bank provider for the plataforma (via per-plataforma config, see Q3)
  → resolve recebedor's chavePix (from Campanha.dadosRecebedor)
  → call bankingProvider.iniciarTransferenciaPix({ idempotencyKey: idRepasse })
  → on response:
      'processando' → repasse.status = 'processando', persist idTransferenciaBancaria + iniciadaEm
      'concluido' (instant pix sometimes confirms in same call) → repasse.status = 'concluido', persist
      throw / network ambiguous → DO NOT change repasse status; rely on idempotency to retry safely
  → log per outcome
```

**Out of scope**: webhook confirmation handler (Phase 5), reconciliação (Phase 7).

**Verification**: integration test with fake adapter for each response shape; ambiguous-network test asserts retry is safe.

**STOP for confirmation.**

---

### Phase 5 — Webhook ingress + confirmation handler

**Objective**: Bank sends webhook ("transferência X concluída/falhou"); engine confirms the repasse + creates the matching Financeiro lancamentos. Idempotent on the bank's event id.

**Files NEW**:
```
migrations/
└── 20280101_002_create_eventos_bancarios_processados.ts
src/adapters/banking/
└── eventos-processados-repository.{ts,memory.ts,postgres.ts}
src/use-cases/banking/
└── processar-evento-bancario.ts             # dispatch: confirmado / falhou
src/use-cases/financeiro/
├── confirmar-repasse-recebedor.ts           # processando → concluido + lancamentos
└── marcar-repasse-falho.ts                  # processando → falhou (no lancamento, repasse-money still in plataforma's books)
```

**Behavior**:
```ts
processarEventoBancario(deps, evento: EventoBancarioNormalizado)
  → idempotency check: events table
  → lookup repasse by idTransferenciaBancaria
  → branch:
      'confirmado' → confirmarRepasseRecebedor(idRepasse, confirmadaEm)
      'falhou'     → marcarRepasseFalho(idRepasse, motivo)
  → record event as processed
```

**Files MODIFIED**:
- `examples/fluxo-completo.web.ts` — POST `/webhook/banco` route (calls processarEventoBancario), plus a "simular webhook do banco" button on the Financeiro page (same demo pattern as plan 0004).

**Verification**: full happy + sad path tested; replay idempotency works; lancamento math correct on confirmation (subtracts from disponivel saldo).

**STOP for confirmation.**

---

### Phase 6 — Banking fee passthrough (lancamento type)

**Objective**: When repasse confirms, also create `debito_taxa_banco_repasse` lancamento for the bank's per-transfer fee. Mirrors plan 0013's provider-fee pattern but on the egress side.

**Files MODIFIED**:
- `src/domain/financeiro/value-objects/tipo-lancamento.ts` — add `debito_taxa_banco_repasse`.
- `confirmarRepasseRecebedor` (Phase 5) — creates 2 lancamentos: debit saldo (the repasse amount) + debit fee (the bank's cost).
- `BankingProvider` port — add `tarifaPorMetodo: Map<TipoTransferencia, TarifaBanco>` accessor (or fold into provider config).

**Out of scope**: variance reconciliation (Phase 8); plataforma-absorbed vs recebedor-deducted fee policy (see Q9 — decided in Phase 1).

**Verification**: confirmed repasse produces both lancamentos summing correctly; saldo math accounts for fee.

**STOP for confirmation.**

---

### Phase 7 — Reconciliação de transferências stuck em `processando`

**Objective**: A scheduled job (uses plan 0005's scheduler) finds repasses in `processando` past a threshold, polls the bank for status, and finalizes.

**Files NEW**:
```
src/use-cases/banking/
└── reconciliar-transferencias-pendentes.ts
src/workers/jobs/
└── reconciliar-transferencias.job.ts        # wires to scheduler
```

**Behavior**: mirrors plan 0004's `reconciliarPagamentosPendentes` — find stuck, poll, finalize.

**Verification**: stuck transferência that bank confirms in poll → repasse becomes `concluido`; bank says `falhou` → repasse becomes `falhou`; bank says `processando` past dead-window → human escalation flag (decided in Q5).

**STOP for confirmation.**

---

### Phase 8 — Real Inter adapter

**Objective**: First real BankingProvider implementation. Calls Inter's PIX-out API with mTLS + OAuth2. Parses Inter's webhooks. Verifies their signatures.

**Files NEW**:
```
src/adapters/banking/
├── banking-provider.inter.ts
└── webhook-verifier.inter.ts
```

**Files MODIFIED**: env-var loader (Inter cert paths, OAuth2 client id/secret); composition root (use Inter adapter when configured).

**Out of scope**: Nubank or other bank adapters (each is its own follow-up phase or plan).

**Verification**:
- Tests against Inter sandbox environment.
- Mandatory: dry-run / sandbox-only mode toggle. Production mode requires explicit env flag.
- Mandatory: ops runbook (from Phase 1) updated with Inter-specific failure codes + recovery procedures.

**STOP for confirmation. ⚠️ Do not enable production Inter mode without ops sign-off.**

---

## Open questions to answer before phases start

### Q1 — Multi-bank from day 1 or Inter-only?

Options:
- **A. Multi-bank port design from day 1.** Even if only Inter ships in v1, the port shape, ID strategy, fee model, and webhook flow are designed to accept Nubank/Itaú/etc. without refactoring.
- **B. Inter-only port (effectively coupled).** Faster to ship; harder to add second bank later.

**Recommend A** — your reason for asking this question (might switch to Nubank) is exactly why A wins. The cost is ~20% more design effort up front; the savings when bank #2 lands are 5–10×.

### Q2 — PIX-out only or also TED/DOC?

PIX-out covers ~95% of modern Brazilian B2C repasses. TED matters for older/corporate flows or amounts above PIX daily limits. DOC is essentially dead but still used by some legacy systems.

Options:
- **A. PIX-out only in v1.** Simplest. Documented gap if a recebedor needs TED.
- **B. PIX-out + TED.** Port becomes polymorphic on transfer type. Worth it if any current recebedor would actually need TED.
- **C. All three.** Overkill unless a real customer asks for DOC.

### Q3 — Per-plataforma banking config or single engine-wide bank?

Each plataforma (eunenem, eucasei) might use different banks for ops/regulatory/cost reasons. Options:
- **A. Single engine-wide bank** (config per deploy). Simpler. Bad for multi-tenant SaaS.
- **B. Per-plataforma bank config** (one bank per plataforma). Natural for multi-tenancy. Adds a `ContaBancariaPlataforma` aggregate-ish concept.
- **C. Per-plataforma + per-método/condition** (small repasses go bank X, large go bank Y, etc.). Premature unless a clear need.

If multi-tenant is real (it is, given plan 0003), B is right.

### Q4 — Failure retry policy

When `iniciarTransferenciaPix` returns a recoverable failure (network blip, rate limit, temporary bank-side error), what does the engine do?

- **A. Auto-retry with exponential backoff** (uses plan 0005 worker). Bounded attempts.
- **B. Ops-only retry** — falhou status, human reviews + decides.
- **C. Auto-retry for transient errors only** (rate limit, network), ops-only for terminal (recebedor rejected, daily limit hit).

C is the realistic answer; needs an error-classification taxonomy that's bank-specific.

### Q5 — Stuck-in-processando policy

When a repasse has been `processando` for "too long" (longer than the bank's normal SLA + grace), what's the policy?

- **A. Auto-mark `falhou` after N hours** — risky if it later confirms.
- **B. Stay `processando` forever, alert ops** — safe but creates noisy dashboards.
- **C. Reconciliação polls indefinitely; after N polls without resolution, escalate to ops** (no auto state change).

C is the typical answer; the dead-window threshold per bank.

### Q6 — Dual-approval workflow

Many corporate bank accounts require two-person approval for outgoing transfers above a threshold (e.g. R$10k). Options:

- **A. Out of scope; rely on bank's own dual-approval mechanism.** Simplest.
- **B. Engine models approvals**: repasse above threshold blocks at `solicitado`, requires N admin approvals before `executarRepasse` is allowed.
- **C. Bank-side only for v1, model in v2** if customer/regulation demands.

A or C are pragmatic. B is correct but adds a big domain piece.

### Q7 — Reconciliation source

How does the engine learn about confirmed/failed transfers?

- **A. Webhook only** — fastest, requires bank to support webhooks (Inter does; check Nubank).
- **B. Polling only** — slower, works for any bank, more load.
- **C. Webhook + polling fallback** — webhook is fast path, polling catches missed events.

C is realistic. Most banks miss webhooks occasionally.

### Q8 — Idempotency key mapping

Our `idRepasse` (UUID) → bank's `x-request-id` (or similar). Different banks use different header names + format requirements (some require ≤36 chars, some require UUID v4, some accept any string).

- **A. Use `idRepasse` verbatim** if bank accepts UUID. Recommend.
- **B. Wrap/prefix per-bank** if bank has format restrictions (e.g. `engine-<idRepasse>`).
- **C. Generate a separate idempotency key** stored on the repasse alongside idRepasse.

A if possible; B for banks that need format adjustments.

### Q9 — Banking fee passthrough (egress analog of plan 0013)

Bank charges X per PIX-out (Inter: ~R$0.50 for businesses). Three policy options:

- **A. Plataforma absorbs**: `debito_receita_plataforma` (subtracts from receita ledger). Cost of doing business.
- **B. Recebedor absorbs**: deduct from repasse amount. "You asked for R$1000, you got R$999.50."
- **C. Per-plataforma policy**, configurable.

A is generous (good UX for recebedor); B is cost-passed-through; C is right long-term.

This decision interacts directly with plan 0013's locked decision #1 (passthrough vs absorb on ingress).

### Q10 — `DadosRecebedor` scope expansion

Today `Campanha.dadosRecebedor` is PIX-only (`{ nomeTitular, tipoChavePix, chavePix }`). If Q2 says "PIX-only forever," no change needed. If Q2 adds TED/DOC, we need full bank account details (`agencia, conta, tipoConta, codigoBanco`).

- **A. Keep PIX-only** (mirrors Q2 = A).
- **B. Add optional `dadosBancarios` field** for TED/DOC support.
- **C. Replace `dadosRecebedor` with a polymorphic `MetodoRepasse: PixData | TedData | DocData`**.

Pick consistent with Q2.

## Operational guardrails (mandatory across phases)

Independent of which open questions resolve which way, these are non-negotiable:

1. **Dry-run mode**: every banking adapter must support a "log-but-don't-actually-call-bank" mode for local dev + CI. Enabled by env var. Default-on for non-prod.
2. **Idempotency-key audit log**: every `iniciarTransferencia` call logs the idempotency key sent and the response. Diagnosing "did this transfer get sent twice?" is a common 3am question; the answer must be findable in logs.
3. **Per-day per-plataforma transfer cap** (default R$50k, configurable). Above the cap → repasse rejected at execute time, ops alert. Prevents runaway-bug scenarios.
4. **Repasse history is never deleted, only superseded.** Even cancelled / failed transfers stay in the books with audit fields.
5. **Two clocks**: `iniciadaEm` (engine-side) vs `confirmadaEm` (bank-side). Both persisted; drift between them is a diagnostic signal.
6. **Production toggle gated by env var** (`BANKING_PROVIDER_MODE=production`) + visible warning in startup logs. Local dev defaults to fake adapter.

## Done definition

- Phase 1 decisions documented in this file's "Locked decisions" section + `ops/repasse-runbook.md` exists.
- Phases 2–8 land, each gated by `pnpm check`.
- End-to-end demo: contribuinte pays → recebedor accumulates saldo → admin clicks "executar repasse" → fake adapter "transfers" → simulated webhook confirms → repasse marked concluido → saldo + fee lancamentos correct.
- Real Inter adapter (Phase 8) passes against Inter sandbox.
- Inter → Nubank swap is a Phase 9 / future-plan affair: write `banking-provider.nubank.ts`, plug at composition root, zero domain changes.
- Operational guardrails (dry-run, idempotency log, cap, audit) all in place.
- `docs/idempotency-and-concurrency.md` gains a section on banking-side idempotency.
