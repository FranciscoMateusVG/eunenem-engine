# Plan 0004 — Async confirmation, webhooks, and rejection compensation

> **Status**: drafted 2026-05-24, awaiting confirmation.
> **Depends on**: plans `0002-checkout-orchestration-layer-done.md` (saga + process manager + Phase 4 idempotency hardening) and `0003-plataforma-multi-tenant-done.md` (cross-tenant guards).
> **Companion docs**: `docs/idempotency-and-concurrency.md` (the 5 open questions). This plan answers questions 1–3; question 4 (queue/worker model) and question 5 (durable event store) are explicitly deferred.

## Goal

Close the gap between the *demo* checkout (synchronous, always-aprovado) and a *realistic* checkout where:

- The provider confirms asynchronously (PIX seconds later, cartão minutes/days later via webhook).
- Some pagamentos are rejected, and the engine must un-claim the Contribuição so someone else can try.
- The system can be inspected end-to-end ("for this Contribuição, what's the current Pagamento status, and is there a Lancamento yet?") without poking adapters' internal Maps.
- Lost webhooks don't strand money — a reconciliation loop catches stuck pendentes.

Concrete trigger: today `PagamentoProviderFake` returns `{ status: 'aprovado' }` synchronously and the demo route calls `finalizarPagamentoAprovado` in the same HTTP request. That hides the entire async confirmation story, and `rejeitarPagamento` is wired only at the Pagamentos BC level — it doesn't compensate cross-BC.

## What this plan does NOT cover (deferred threads)

To keep this plan honest about scope, here's what other plans will own:

- **0005 — Durable event log + worker queue**: today the webhook handler dispatches synchronously to `finalizarPagamentoAprovado`. A proper system records the event, ACKs the provider fast, and a worker processes it. That introduces queues, retries with backoff, dead-letter handling, and leader election for the reconciliation cron. Not here.
- **0006 — Lancamento maturation rule**: the demo has a "Maturar pendentes" button because there's no maturation rule (`D+30 after pagamento.criadoEm` is the canonical Stripe-ish rule). That's its own BC discussion (Financeiro).
- **0007 — Webhook authn/authz**: signature verification per provider (Stripe `whsec_*`, PIX certificate chain). This plan defines the **port** for it but leaves the real adapter to plan 0007.
- **Pagamento attempts / retry history**: open question, see "Open questions" below.

## Locked decisions

1. **Webhook idempotency key is the provider-supplied event id.** Stored as a unique constraint in a new `eventos_provedor_processados` table. Re-delivery of the same event id is a fast no-op (already-processed read path). Our internal `idIntencaoPagamento` remains the *checkout* idempotency key, used at `iniciarPagamento` time; the two are distinct concerns.

2. **Webhook → finalize is synchronous in 0004.** The handler looks up the pagamento, calls `finalizarPagamentoAprovado` or `finalizarPagamentoRejeitado` in-line, then ACKs the provider. Pros: simple, no queue, no eventual-consistency window. Cons: if our DB is slow, the provider sees a slow webhook and may retry — that's why the idempotency key matters. Async queue is plan 0005.

3. **Rejection compensation is a checkout-level process manager**, not a pagamentos-level concern. New use case `finalizarPagamentoRejeitado` lives in `src/use-cases/checkout/`, calls `rejeitarPagamento` (pagamentos BC) **and** `liberarContribuicao` (arrecadacao BC) so the Contribuição flips back to `disponivel`. Mirrors how `finalizarPagamentoAprovado` already orchestrates pagamentos + arrecadacao + financeiro.

4. **Pendente Pagamento has an `expiraEm` timestamp.** Set at `iniciarPagamento` time, configured per método (PIX = 30 min, cartão = 24h, default = 30 min). When the reconciler runs, expired pendentes that the provider can't confirm are auto-rejected. Releases the Contribuição back.

5. **Reconciliação is a use case, not a daemon.** `reconciliarPagamentosPendentes(criterios)` is a pure orchestration call. *When* it runs (cron, webhook trigger, manual button) is an infrastructure concern. In 0004 we wire a manual button on the Financeiro page; a real scheduler is plan 0005.

6. **Provider stays the same port; we add modes to the fake.** `PagamentoProviderFake` gains a `modo: 'sincrono-aprovado' | 'pendente-ate-webhook' | 'sincrono-rejeitado'` config. The web demo lets you flip it per request via query/form, so you can drive every path manually without a real provider.

7. **Multi-attempt is allowed.** A rejected Pagamento releases the Contribuição back to `disponivel`. A new contribuinte (or the same one) can start a fresh Pagamento with a NEW `idIntencaoPagamento`. The old Pagamento row stays in `rejeitado` for audit. No retry-counter on the Contribuição.

## DDD concepts this plan teaches

### Eventual consistency at the BC boundary

Today everything happens in one HTTP request, so eventual consistency is hypothetical. Once the provider goes async, **Contribuição can be `indisponivel` while Pagamento is `pendente` for minutes or days**. That's not a bug — that's the model telling the truth. The state of the world is a *graph of statuses across BCs*, not a single boolean. The read-side projection (`consultarStatusContribuicao`) exists precisely because there's no single status to read.

### Process Manager vs Saga revisited

`iniciarPagamentoContribuicao` is a **saga** — single user-initiated transaction with compensating actions if a step fails *during the call*. `finalizarPagamentoAprovado` / `finalizarPagamentoRejeitado` are **process managers** — reactions to *external* events (provider confirmation), running outside any user request, orchestrating across BCs. The webhook ingress is the trigger; the process manager is the body. This distinction sharpens once both finalize-paths exist.

### Idempotency layers

Two different idempotency keys, two different jobs:
- **`idIntencaoPagamento`** (our key, set at `iniciarPagamento`): guards *checkout retries* — user clicks "Pagar" twice, same pagamento.
- **`idEventoProvedor`** (provider's key, recorded at webhook): guards *callback re-delivery* — Stripe retries the same event 3×, we process it once.

They are not interchangeable, and conflating them creates subtle bugs (e.g. accepting a stale webhook because we matched on our id and ignored the provider's).

### Compensating action vs poisoned state

When a Pagamento rejects, the Contribuição must un-claim. That's a compensating action, not a rollback. The Pagamento row stays — `rejeitado` is a real state, not "as if it never happened." We add a log/event, never a delete. This shows up in the read-side projection too: a Contribuição might have one `rejeitado` pagamento *and* one `aprovado` pagamento in its history.

### Read-side projection as an explicit concept

Today the demo's status page joins data by reaching into adapter internals (`as unknown as { pagamentos: Map<...> }`). That's a code smell with a name: **the missing query**. The fix is a dedicated read-side use case that lives in `src/use-cases/checkout/` (read-side belongs to the orchestrator layer, since it spans BCs). It returns a DTO assembled from multiple BC reads — no joins inside any single BC, no shared tables.

## Phases

Each phase follows the brief's work mode: explain → list files → smallest piece → tests → `pnpm check` → plain-language summary → **STOP for confirmation**.

---

### Phase 1 — `finalizarPagamentoRejeitado` (cross-BC compensation)

**Objective**: When a Pagamento becomes `rejeitado`, the Contribuição it claimed flips back to `disponivel`. Build the missing twin of `finalizarPagamentoAprovado`.

**DDD concepts in play**:
- Process manager (reaction to external event)
- Compensating action across BCs
- Cross-BC orchestration in the checkout layer

**Files NEW**:
```
src/use-cases/arrecadacao/
└── liberar-contribuicao.ts                 # NEW: flips Contribuicao back to disponivel
src/use-cases/checkout/
└── finalizar-pagamento-rejeitado.ts        # NEW: process manager — rejeitar + liberar
src/errors/arrecadacao/
└── contribuicao-nao-claimable.error.ts     # NEW: liberar called on non-indisponivel contribuição
tests/unit/checkout/
└── finalizar-pagamento-rejeitado.test.ts   # NEW
tests/unit/arrecadacao/
└── liberar-contribuicao.test.ts            # NEW
```

**Files MODIFIED**: none in src/domain — `liberarContribuicao` already works with existing `Contribuicao` shape (just sets `status = 'disponivel'`, clears `contribuinte`).

**Behavior**:
```ts
// arrecadacao/liberar-contribuicao.ts
liberarContribuicao(deps, { idContribuicao })
  → fetch contribuicao
  → if status !== 'indisponivel' → ArrecadacaoContribuicaoNaoClaimableError
  → set status = 'disponivel', contribuinte = null
  → save
  → log 'arrecadacao.contribuicao.liberada'

// checkout/finalizar-pagamento-rejeitado.ts
finalizarPagamentoRejeitado(deps, { idPagamento })
  → idempotent: if pagamento.status === 'rejeitado' AND contribuicao.status === 'disponivel' → no-op replay
  → call rejeitarPagamento (pagamentos BC) — emits payment.rejected
  → call liberarContribuicao (arrecadacao BC)
  → log 'checkout.pagamento.rejeitado.finalizado'
```

**Out of scope**: webhook trigger (Phase 2 calls this), updating the demo (Phase 3 wires it visibly).

**Verification**: `pnpm check` green; tests cover happy path, already-rejected replay, already-liberada replay, ContribuiçãoNaoClaimable when the contribuicao is somehow back to `disponivel` already (defensive — shouldn't happen in normal flow).

**STOP for confirmation.**

---

### Phase 2 — Webhook ingress (`processarEventoProvedor`)

**Objective**: A use case that accepts a normalized provider event payload, idempotently records the event, looks up the affected pagamento, and dispatches to `finalizarPagamentoAprovado` or `finalizarPagamentoRejeitado`.

**DDD concepts in play**:
- Idempotency at the system boundary (idEventoProvedor)
- Anti-corruption layer (normalizing per-provider payload to a canonical event shape)
- Synchronous fan-out from event to process manager

**Files NEW**:
```
src/domain/pagamentos/
└── value-objects/evento-provedor.ts        # NEW: EventoProvedorNormalizado VO
                                            #   { idEventoProvedor, tipo: 'aprovado'|'rejeitado',
                                            #     idTransacaoExterna, idIntencaoPagamento,
                                            #     amountCents, ocorridoEm }
src/adapters/pagamentos/
├── eventos-processados-repository.ts          # NEW: port — has it been processed?
├── eventos-processados-repository.memory.ts   # NEW
└── eventos-processados-repository.postgres.ts # NEW
src/use-cases/pagamentos/
└── processar-evento-provedor.ts            # NEW: idempotent dispatch
src/errors/pagamentos/
├── evento-ja-processado.error.ts           # NEW (replay → OK; this is the signal, not an error)
└── evento-pagamento-nao-encontrado.error.ts # NEW
migrations/
└── 20260524_008_create_eventos_provedor_processados.ts  # NEW
tests/unit/pagamentos/
├── processar-evento-provedor.test.ts       # NEW
└── eventos-processados-repository.conformance.ts # NEW (memory + postgres parity)
tests/integration/
└── eventos-processados-repository.postgres.test.ts # NEW
```

**Files MODIFIED**:
- `src/adapters/db-types.generated.ts` (re-run codegen after migration)
- `src/index.ts` (export the new use case + types)

**Schema** (`eventos_provedor_processados`):
```sql
CREATE TABLE eventos_provedor_processados (
  id_evento_provedor TEXT PRIMARY KEY,    -- provider's event id (Stripe evt_xxx, PIX e2e id)
  id_pagamento       UUID NOT NULL,
  tipo               TEXT NOT NULL,        -- 'aprovado' | 'rejeitado'
  processado_em      TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON eventos_provedor_processados (id_pagamento);
```

**Behavior**:
```ts
processarEventoProvedor(deps, evento: EventoProvedorNormalizado)
  → eventosRepo.findById(evento.idEventoProvedor)
      → if found → return { status: 'replay', idPagamento, tipo }  // fast no-op
  → pagamentoRepo.findByIntencaoId(evento.idIntencaoPagamento)
      → if missing → EventoPagamentoNaoEncontradoError
  → validate evento.amountCents === pagamento.intencao.amountCents
      (mismatch → log + reject the event; do not mutate pagamento)
  → branch on evento.tipo:
       'aprovado'  → finalizarPagamentoAprovado(idPagamento)
       'rejeitado' → finalizarPagamentoRejeitado(idPagamento)
  → eventosRepo.record({ idEventoProvedor, idPagamento, tipo, processadoEm: clock() })
  → return { status: 'processed', idPagamento, tipo }
```

**Order matters**: we call the finalize use case *before* recording the event. Why: if finalize fails, the event isn't marked processed, and the provider's retry will re-attempt. If we recorded first and finalize threw, we'd skip the retry and lose the update. The finalize use cases are already idempotent (Phase 4 of 0002) so double-runs are safe.

**Anti-corruption layer**: `EventoProvedorNormalizado` is our shape. Real adapters (Stripe, PIX, MercadoPago) get tiny per-provider parsers that map their raw JSON into this VO. Those parsers live in adapters, not domain. For 0004 we only need the canonical shape — the parsers come with real provider integrations later.

**Out of scope**: HTTP endpoint (it's a use case; demo wires a route in Phase 3), signature verification (the port hook is there but the adapter is plan 0007), webhook delivery retries (plan 0005).

**Verification**: `pnpm check` green; tests cover first-delivery, re-delivery replay, amount mismatch, unknown pagamento, both `tipo` branches, pagamento already in terminal state.

**STOP for confirmation.**

---

### Phase 3 — Async provider mode + visible pendente state

**Objective**: Make the asynchrony visible. `PagamentoProviderFake` gets a "pendente até webhook" mode; the web demo stops calling `finalizarPagamentoAprovado` synchronously and instead shows an "aguardando confirmação" page with a manual "Simular webhook (aprovar | rejeitar)" form.

**DDD concepts in play**:
- The user-facing pendente state — visible eventual consistency
- The webhook endpoint as a thin HTTP wrapper over `processarEventoProvedor`

**Files MODIFIED**:
- `src/adapters/pagamentos/provider.fake.ts` — add `modo` config (default `'pendente-ate-webhook'` to push the realistic path; the existing `'sincrono-aprovado'` stays for back-compat with current tests).
- `examples/fluxo-completo.web.ts`:
  - Loja checkout POST no longer calls `finalizarPagamentoAprovado`. After `iniciarPagamentoContribuicao`, redirect to `/p/:slug/loja/:idCampanha/aguardando/:idPagamento`.
  - NEW route `/p/:slug/loja/:idCampanha/aguardando/:idPagamento` — shows pendente status + a "Simular webhook" form with `[aprovar] [rejeitar]` buttons.
  - NEW route `POST /webhook/provedor` — calls `processarEventoProvedor` with the simulated event; the form on `/aguardando/...` posts here.
  - Status page (`/p/:slug/status/:idCampanha`) gets a "pendente há Xs" column.

**Files NEW**: none (this is wiring).

**Demo flow becomes**:
```
1. Loja → click "Comprar 1"
2. Checkout form → submit
3. iniciarPagamentoContribuicao → Contribuição = indisponivel, Pagamento = pendente
4. Redirect → /aguardando/:idPagamento  (shows "aguardando confirmação do provedor")
5. User clicks "Simular webhook aprovar" → POST /webhook/provedor
6. processarEventoProvedor → finalizarPagamentoAprovado → Lancamentos created
7. Redirect → status page
```

The rejected variant is the same with "Simular webhook rejeitar" → Contribuição back to `disponivel`.

**Out of scope**: real provider integration, automatic webhook simulation (the user clicks a button).

**Verification**: `pnpm check` green; manual test of both branches in browser; no test changes needed in src (the demo isn't part of `pnpm check`).

**STOP for confirmation.**

---

### Phase 4 — Read-side projection (`consultarStatusContribuicao`)

**Objective**: One use case that returns the full picture of a Contribuição across BCs, replacing the demo's `as unknown as { pagamentos: Map<...> }` hack with a clean read-side query.

**DDD concepts in play**:
- Read-side projection as an orchestration concern (lives in `src/use-cases/checkout/`)
- DTO assembled from per-BC reads — no shared tables, no cross-BC joins inside any single repository
- The contrast: write-side enforces aggregate boundaries strictly; read-side is allowed to compose freely

**Files NEW**:
```
src/use-cases/checkout/
└── consultar-status-contribuicao.ts        # NEW: read-side DTO assembler
src/adapters/pagamentos/
└── repository.ts  (modified)               # NEW method: findByIdContribuicao(idContribuicao)
                                            #   returns readonly Pagamento[] (history, ordered by criadoEm)
tests/unit/checkout/
└── consultar-status-contribuicao.test.ts   # NEW
```

**Files MODIFIED**:
- `src/adapters/pagamentos/repository.memory.ts` + `.postgres.ts` — add `findByIdContribuicao`
- `tests/helpers/pagamento-repository.conformance.ts` — add conformance tests for new method
- `examples/fluxo-completo.web.ts` — status page uses the new use case instead of the Map hack

**DTO**:
```ts
interface StatusContribuicao {
  readonly contribuicao: ContribuicaoView;          // id, nome, valor, status, grupo
  readonly pagamentos: readonly PagamentoView[];    // full history (pendente, rejeitado, aprovado)
  readonly pagamentoAtivo: PagamentoView | undefined; // most recent non-terminal, or last aprovado
  readonly lancamentos: readonly LancamentoView[];   // financeiro lineage for aprovado pagamentos
  readonly resumo: {
    readonly totalPagoCents: number;       // sum of aprovado pagamentos
    readonly receitaPlataformaCents: number; // sum of receita lancamentos
    readonly saldoRecebedorCents: number;  // sum of recebedor lancamentos (pendente + disponivel)
  };
}
```

**Behavior**:
- Read Contribuição by id → fail if not found.
- Read all Pagamentos by `idContribuicao` (new repo method).
- For each aprovado Pagamento, read its Lancamentos.
- Compose the DTO. Pure read; no writes; no events.

**Out of scope**: cross-tenant guard on this read (it inherits trust from the calling route — plan 0003 already covers tenant scoping at the campanha level), pagination (the contribuição is the unit; pagamentos per contribuição are bounded by retry policy).

**Verification**: `pnpm check` green; tests cover no-pagamento, single-pendente, single-aprovado-with-lancamentos, history with rejeitado-then-aprovado.

**STOP for confirmation.**

---

### Phase 5 — Reconciliação de pagamentos pendentes

**Objective**: A use case that finds pagamentos stuck in `pendente` past their `expiraEm`, polls the provider to learn the real outcome, and finalizes accordingly. Wired to a manual "Reconciliar" button in the demo.

**DDD concepts in play**:
- Polling as the dual of webhooks — the safety net for lost events
- Use case as a unit of work, not a daemon (when it runs is infra)
- Expiry as a domain concept on Pagamento

**Files NEW**:
```
src/use-cases/pagamentos/
└── reconciliar-pagamentos-pendentes.ts     # NEW
src/adapters/pagamentos/
└── repository.ts (modified)                 # NEW method: findPendentesExpirados(antes: Date)
tests/unit/pagamentos/
└── reconciliar-pagamentos-pendentes.test.ts # NEW
```

**Files MODIFIED**:
- `src/domain/pagamentos/entities/pagamento.ts` — add `expiraEm: Date` field; helper `calcularExpiracaoPorMetodo(metodo, criadoEm)`.
- `src/use-cases/pagamentos/criar-intencao-pagamento.ts` (or wherever pendente is created) — set `expiraEm`.
- `src/adapters/pagamentos/repository.memory.ts` + `.postgres.ts` — add `findPendentesExpirados`.
- `migrations/20260524_009_add_expira_em_to_pagamentos.ts` — NEW column.
- `tests/helpers/pagamento-repository.conformance.ts` — conformance for new method.
- `tests/integration/migration.test.ts` — bump down-step count.
- `examples/fluxo-completo.web.ts` — "Reconciliar pendentes" button on home + financeiro pages.

**Behavior**:
```ts
reconciliarPagamentosPendentes(deps, { agora })
  → pagamentos = pagamentoRepo.findPendentesExpirados(antes: agora)
  → for each pagamento:
      → statusReal = pagamentoProvider.consultarStatus(idTransacaoExterna OR idIntencaoPagamento)
      → branch on statusReal:
          'aprovado'  → finalizarPagamentoAprovado(idPagamento)
          'rejeitado' → finalizarPagamentoRejeitado(idPagamento)
          'pendente'  → if expiraEm < agora - GRACE_PERIOD → auto-rejeitar (provider gave up)
                        else skip (still waiting)
  → return { processados: number, aprovados: number, rejeitados: number, ignorados: number }
```

**Default expiraEm per método**:
- `pix` → criadoEm + 30 min
- `cartao_credito` → criadoEm + 24h
- (configurable on Plataforma later — not in this plan)

**Grace period before auto-rejection**: 4× expiraEm (so a 30-min PIX has to be stuck for 2h before we give up). Tunable later.

**Out of scope**: scheduler/cron (infra, plan 0005), distributed leader election (multi-instance, plan 0005), partial-batch failure handling (we'll log + continue; production needs proper batching).

**Verification**: `pnpm check` green; tests cover all 3 statusReal branches + grace-period skip; provider's `consultarStatus` method gets added to the port + fake.

**STOP for confirmation.**

---

## Open questions (worth discussing before or during the plan)

1. **Pagamento attempts on the same Contribuição.** Today the Contribuição has no "tried-N-times" counter. After rejection it just flips back to `disponivel`. Should we cap retries (e.g. max 3 rejected pagamentos per Contribuição)? Or trust the user? Affects domain shape.

2. **Provider status query shape.** `pagamentoProvider.consultarStatus(...)` — does it take `idTransacaoExterna` (which we may not have if the pagamento never reached the provider) or `idIntencaoPagamento` (always present)? Probably both, with a discriminated union input. Locking this affects the port.

3. **Audit trail on `liberarContribuicao`.** Should we record *why* the contribuição was liberated (rejected pagamento id, expired, manual admin action)? Likely yes — emit a domain event `ContribuicaoLiberada { motivo, idPagamentoCausa }` and let a future BC consume it for analytics.

4. **Webhook → finalize ordering vs queue.** Locked to synchronous in this plan (decision 2). When 0005 introduces a queue, the webhook handler shrinks to "record event, return 200" and a worker drains. The seam: `processarEventoProvedor` already separates "record" from "finalize" internally — moving "finalize" behind a queue is a small wrap, not a rewrite.

5. **Multi-tenant scoping on webhooks.** The webhook payload contains an `idIntencaoPagamento` from which we derive `idPagamento` → `Pagamento` → `Contribuicao` → `Campanha` → `idPlataforma`. So tenancy emerges from the lookup chain. We do NOT trust an `idPlataforma` field on the webhook payload (a forged webhook could lie). This is implicit in Phase 2 but worth calling out.

## Done definition

- All 5 phases land, each gated by `pnpm check`.
- `docs/idempotency-and-concurrency.md` updated: questions 1–3 marked answered with links to this plan; questions 4–5 reaffirmed as deferred.
- The web demo demonstrates the full async flow end-to-end manually: approve path, reject path, reconcile path.
- No remaining `as unknown as { pagamentos: Map<...> }` hack in the demo.
- Coverage stays at current threshold.
