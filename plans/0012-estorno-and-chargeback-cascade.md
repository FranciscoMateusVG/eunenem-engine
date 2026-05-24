# Plan 0012 — Estorno / chargeback cascade

> **Status**: drafted 2026-05-24, awaiting confirmation. **Many decisions deliberately left open** — see "Open questions to answer before phases start" below. Don't begin implementation until those are resolved.
> **Depends on**: plan `0004-async-confirmation-and-webhooks.md` (extends the webhook event tipo enum; mirrors the rejection process-manager pattern), plan `0006-lancamento-maturation-rule.md` (estorno interacts with `maturaEm` and the disponivel/repassado lifecycle).
> **Synergizes with**: plan `0005-durable-event-log-and-worker-queue.md` (estorno is a cross-BC cascade — outbox-routed events make this cleaner) and plan `0008-concurrency-safety-on-claim.md` (Pagamento state machine becomes hot).

## Goal

Today the engine knows two terminal Pagamento states: `aprovado` and `rejeitado`. Reality adds a third class: **estorno** — a *post-confirmation* reversal that cascades backward across Pagamentos → Financeiro → Arrecadação, possibly leaving the plataforma underwater if the original lancamento was already repassado.

Sources of estorno:
- **Chargeback** — bandeira/banco decides on the contribuinte's behalf (fraud claim, dispute). Up to **120 days** after the original pagamento for cartão de crédito in Brazil. Arrives as a provider webhook.
- **Reembolso solicitado** — lojista (or admin) voluntarily refunds. Initiated from our side via a use case.
- **Cancelamento pré-liquidação** — happens before D+30 settlement; provider just doesn't settle. Different from a true estorno but lands in the same cascade.

This plan adds the model + use cases + cascade logic to handle all three.

## What this plan does NOT cover (deferred)

- **Anti-fraud scoring** that would prevent suspicious pagamentos before they're approved. Out of scope; estorno is the *reaction*, not the prevention.
- **Insurance / chargeback guarantee products** that some PSPs sell. Pure financial product, not domain.
- **Dispute response workflow** (uploading evidence to contest a chargeback). That's a Salesforce-flavored ops UX, deferred.

## Locked decisions

These are the few choices that aren't worth debating; the real decisions are in "Open questions" below.

1. **Estorno is its own plan, not folded into 0004.** The cascade is materially different from rejection compensation — money math is involved, and aprovado → estornado is a different lifecycle stage than pendente → rejeitado.

2. **Webhook tipo enum gains `estornado`** in `EventoProvedorNormalizado` (defined by plan 0004). Same shape, new tipo value, dispatched to a new process manager.

3. **Process manager pattern mirrors `finalizarPagamentoRejeitado` from plan 0004.** New use case `finalizarPagamentoEstornado` lives in `src/use-cases/checkout/`, calls into Pagamentos, Financeiro, and Arrecadação BCs.

4. **Counter-lancamentos, never deletes.** Reversal creates *new* Financeiro rows (`debito_estorno_*`), the originals stay with their original status for audit. The saldo math is the algebraic sum. This is the standard double-entry approach and the only one that preserves history.

5. **Estorno can also be initiated by an admin / lojista** via a separate use case (not just via webhook). Both paths converge on the same process manager.

6. **Pagamento state machine learns a new terminal class.** Whether it's a single `estornado` state or a richer `parcialmente_estornado | totalmente_estornado` is an open question (see below). But aprovado → estornado is the new transition either way.

## DDD concepts this plan teaches

### Compensating action across more than two BCs

Plan 0004's `finalizarPagamentoRejeitado` cascades across Pagamentos + Arrecadação. Estorno adds **Financeiro** to the cascade — and Financeiro is where the *money math* lives. This is the first cross-BC flow with arithmetic implications (every prior cascade was status flips). The lesson: when a cascade carries numeric state, compensation must use double-entry math, not state reversal.

### "Terminal" states aren't always terminal

`aprovado` looked terminal until estorno showed up 90 days later. The lesson generalizes: any state labeled "terminal" should be re-examined when a new event class arrives. We don't make all states reversible by default — but we don't pretend they're frozen either. The aggregate's state machine has to model "what events can still arrive" honestly.

### The underwater problem is a real domain concept

If we estornated a pagamento *after* its lancamento was already repassado, the money has left our control. This isn't a bug — it's a category of business risk every PSP carries. Modeling it explicitly (an `estorno_pendente_recuperacao` state? a `saldo_negativo` allowed on recebedor? a `perda_operacional` lancamento type?) is the domain stepping up to call the problem by name. Hiding it under "just don't repasse for 120 days" is throwing money at it.

### Multi-source events converging on one process manager

Webhook says "chargeback." Admin clicks "estornar." Internal cron says "expired without confirmation." Three different entry points, same downstream cascade. The process manager pattern shines here: each entry point is a thin orchestrator that translates its specific trigger into a normalized event, then hands off. Adding a fourth source (e.g. CSV import from bandeira) becomes another thin entry point.

### Estorno parcial: nested entity inside aggregate

If we support partial estornos (open question), Pagamento gains a nested entity collection: `Pagamento.estornos: Estorno[]`. Each Estorno has its own id, amount, motivo, ocorridoEm. The Pagamento aggregate root enforces invariants (sum of estornos ≤ original amount, status derived from the collection). This is a textbook nested-entity example — the entities have identity but no life outside their root.

## Phases

> ⚠️ **Phase shape depends on the open-questions resolutions.** The phase outline below is a *plausible* sequence assuming the recommended defaults from each open question; revisit before execution.

### Phase 1 — Resolve the open questions (no code)

**Objective**: Hold a working session, walk through the open questions below, lock the decisions, and revise this plan's "Locked decisions" section in place. **No code lands in this phase.** This plan should not advance past Phase 1 until the decisions are written down.

**Deliverable**: this file's "Open questions" section becomes empty (or shrunk to genuinely-implementation-time questions), and "Locked decisions" gains the new entries.

**STOP for confirmation.**

---

### Phase 2 — Pagamento estornado state

**Objective**: Pagamento learns `estornado` as a state (shape depends on Phase 1's decision on partial-vs-full). Aprovado → estornado transition + domain helpers.

**Files NEW**:
```
src/domain/pagamentos/value-objects/
└── estorno.ts                            # IF partial estornos chosen — nested entity shape
src/errors/pagamentos/
├── pagamento-ja-estornado.error.ts
└── pagamento-nao-estornavel.error.ts     # not aprovado, or already terminal in another way
migrations/
└── 20271101_001_add_estornos_to_pagamentos.ts   # column or new table depending on shape
```

**Files MODIFIED**:
- `src/domain/pagamentos/entities/pagamento.ts` — add transition helpers + status derivation.
- `src/adapters/pagamentos/repository.{memory,postgres}.ts` — persist new field/collection.
- Conformance suite — assert round-trip.

**Verification**: aprovado pagamento can be marked estornado; rejected pagamento cannot; double-estorno on same pagamento either is idempotent or accumulates (depends on Phase 1 decision).

**STOP for confirmation.**

---

### Phase 3 — Financeiro counter-lancamentos

**Objective**: New lancamento types for the reversal side. `criarLancamentosEstorno(idPagamento, amountCents)` creates the right debits.

**Files NEW**:
```
src/use-cases/financeiro/
└── criar-lancamentos-estorno.ts
src/errors/financeiro/
├── lancamento-original-nao-encontrado.error.ts
└── saldo-insuficiente-para-estorno.error.ts  # depends on underwater policy from Phase 1
```

**Files MODIFIED**:
- `src/domain/financeiro/value-objects/tipo-lancamento.ts` (or equivalent) — add `debito_estorno_recebedor`, `debito_estorno_receita_plataforma`, possibly `perda_estorno_operacional` (depends on Phase 1 underwater policy).
- `src/adapters/financeiro/livro-repository.{memory,postgres}.ts` — query helpers (`findLancamentosByIdPagamento`).
- Saldo calculation — counter-lancamentos subtract; verify algebra holds.

**Verification**: aprovado pagamento with 2 lancamentos (recebedor + receita) → after estorno, 4 lancamentos exist (originals + 2 debits) and saldo math returns to pre-pagamento state (or per the underwater policy).

**STOP for confirmation.**

---

### Phase 4 — Process manager `finalizarPagamentoEstornado`

**Objective**: Orchestrate the cascade across Pagamentos + Financeiro + Arrecadação. Idempotent on re-delivery.

**Files NEW**:
```
src/use-cases/checkout/
└── finalizar-pagamento-estornado.ts
src/use-cases/arrecadacao/
└── aplicar-politica-estorno-contribuicao.ts  # implements Phase 1's per-tipo policy
```

**Behavior**:
```ts
finalizarPagamentoEstornado(deps, { idPagamento, amountCents, motivo, origem })
  → idempotency: if pagamento already estornado for this amount → replay no-op
  → marcarPagamentoEstornado (pagamentos BC)
  → criarLancamentosEstorno (financeiro BC)
  → aplicarPoliticaEstornoContribuicao (arrecadacao BC)
       → branches on OpcaoContribuicao.tipo per Phase 1's locked policy
  → log + emit event (estorno.processado)
```

**Verification**: tests for chargeback-from-webhook path, admin-initiated-refund path, and replay idempotency.

**STOP for confirmation.**

---

### Phase 5 — Webhook + admin entry points

**Objective**: Wire estorno into the webhook handler (extends 0004) AND add an admin use case `solicitarReembolsoPagamento` for voluntary refunds.

**Files MODIFIED**:
- `src/use-cases/pagamentos/processar-evento-provedor.ts` (from 0004) — dispatch tipo `estornado` to `finalizarPagamentoEstornado`.
- Webhook event parser — recognize provider's chargeback/refund payloads.
- `src/use-cases/checkout/solicitar-reembolso-pagamento.ts` — NEW admin-initiated entry point. Calls provider's refund API (port), then calls finalizarPagamentoEstornado.

**Verification**: simulated chargeback webhook triggers cascade; admin "Estornar" button on demo Status page triggers same cascade.

**STOP for confirmation.**

---

### Phase 6 — Demo + read-side visibility

**Objective**: Status page (from 0004 Phase 4) shows estorno history. Admin gets an "Estornar pagamento" button. Underwater state (if Phase 1 chose to model it) shows up on Financeiro page.

**Files MODIFIED**:
- `src/use-cases/checkout/consultar-status-contribuicao.ts` (from 0004) — DTO includes `estornos: EstornoView[]`.
- `examples/fluxo-completo.web.ts` — admin button + status display + financeiro underwater badge.

**Verification**: manual end-to-end demo: aprovar → estornar (via button) → status page shows estornado → financeiro shows debit lancamentos → contribuição follows the per-tipo policy.

**STOP for confirmation.**

---

## Open questions to answer before phases start

### Q1 — Underwater policy

When `pagamento.estornado` arrives but the lancamento has already been `repassado` (money left to recebedor), what does the engine do?

Options:
- **A. Eat the loss**: create `perda_estorno_operacional` lancamento on the plataforma's books; recebedor keeps the money; plataforma absorbs.
- **B. Recover from future saldo**: mark recebedor's account as owing X; subtract from future lancamentos until paid back. Could go negative.
- **C. Block repasse during dispute window**: delay `maturaEm` (or repasse eligibility) until 120 days post-aprovado for cartão. Safe but cash-flow hostile.
- **D. Hybrid**: dispute-window block for cartão, normal maturation for pix (no chargeback risk), eat-loss as fallback when window expired.

Each has a different domain shape. **D is the realistic answer** but largest scope. **A is the minimum viable**. The choice here cascades into Phase 3's lancamento types and Phase 6's Financeiro UI.

### Q2 — Per-tipo policy for Contribuição after estorno

When pagamento is estornado, what happens to the Contribuição it claimed?

Per `OpcaoContribuicao.tipo`:
- **presente**: liberada (back to disponivel) — someone else can buy?
- **rifa**: terminal `estornada` (sorteio already used the number?) — or liberada (refund a rifa ticket should free the slot)?
- **convite**: liberada — invite slot is fungible until used?

Or **a unified policy** ("always liberada" / "always terminal `estornada`") regardless of tipo?

Real-world: presente = liberada makes sense (the gift is just data). Rifa = depends on whether the draw happened. Invites likely terminal because they were physically delivered.

Recommend writing the policy as a function of tipo + plataforma config, but commit to the per-tipo defaults in this plan.

### Q3 — Partial estorno: v1 yes/no?

Two model shapes:
- **Full-only**: Pagamento has single terminal state `estornado`. Whole amount reversed in one shot. Simple.
- **Partial allowed**: Pagamento has `estornos: Estorno[]` nested entities. Sum ≤ amountCents. Status derived: `aprovado` (no estornos) → `parcialmente_estornado` (some) → `totalmente_estornado` (sum == amount). Realistic but ~3× the complexity.

Brazilian PSPs all support partial. Whether *we* need to in v1 depends on the use cases this engine serves. If only gift-registry, partial is rare; if a marketplace, partial is daily.

### Q4 — Dispute window vs maturation timing

Plan 0006 sets cartão `maturaEm = aprovadoEm + 30d`. Real chargeback window is 120d. Options:
- **Honest model**: cartão maturaEm = 120d. Recebedor waits 4 months.
- **Optimistic model**: maturaEm = 30d, accept underwater risk per Q1.
- **Configurable per plataforma**: each plataforma picks its risk appetite.

This is the same conversation as Q1 viewed from a different angle. Locking Q1 likely locks Q4.

### Q5 — Estorno of receita_plataforma — proportional?

If pagamento R$100 had R$5 receita + R$95 recebedor, and we estornar R$60 (partial), how does the receita debit split?
- **Proportional**: debit R$3 from receita + R$57 from recebedor.
- **Receita first**: debit R$5 from receita + R$55 from recebedor (plataforma absorbs first).
- **Recebedor first**: debit R$60 from recebedor, receita untouched.

Real practice varies. Recommend proportional — fairest, easiest to explain. Only matters if Q3 = "partial yes."

### Q6 — Source / audit tracking

Each estorno should know its origem:
- `chargeback_provedor` (webhook-driven)
- `reembolso_lojista` (admin-initiated via UI)
- `cancelamento_pre_liquidacao` (provider didn't settle)
- `expiracao` (we gave up waiting)

Plus `motivo: string` (free text or enum). And `executor: idUsuario | 'sistema'`. Audit hygiene says yes to all; v1 scope says decide what's mandatory.

### Q7 — Notification policy

When a chargeback arrives, who gets notified?
- Recebedor (their saldo just got hit)?
- Admin of the plataforma?
- The original contribuinte (confirmation)?

This depends on email/notification infrastructure we don't have yet — out of scope for 0012's *implementation* but worth deciding the policy so we know what events the system needs to emit.

### Q8 — Per-plataforma policy or global?

Q1, Q2, Q4, Q5 above could all be either "the engine has one answer" or "each plataforma configures their own." The former is simpler now; the latter is the eventual reality. Likely answer: global defaults in v1, per-plataforma overrides as a future plan.

### Q9 — Idempotency across re-delivery sources

What if the webhook arrives AND admin clicks "estornar" within seconds? Both trigger `finalizarPagamentoEstornado`. The use case is idempotent on `(idPagamento, amountCents)` for full estornos — but for partial estornos, an external estorno id (from provider) is needed to dedupe properly. Affects schema in Phase 2.

### Q10 — Chargeback × provider fee passthrough (interaction with plan 0013)

Plan `0013-provider-fee-passthrough.md` introduces a third lancamento type: `credito_reembolso_taxa_provedor` (money collected from contribuinte specifically to cover Stripe's fee). On chargeback:

- Contribuinte gets full refund (R$87.50 back).
- Stripe **keeps** their R$3.50 fee (typical chargeback policy).
- Plataforma is out R$3.50 net per chargeback, *on top of* whatever recebedor/receita reversal happens.

So the cascade needs to handle a fourth lancamento: a *loss* (e.g. `perda_taxa_provedor_estorno`) representing the passthrough that the plataforma can't recover. The estorno process manager from this plan must know about this lancamento type and produce it when applicable.

Whether plan 0012 introduces the loss-lancamento or plan 0013 does — and how the two plans coordinate — is itself a decision worth taking in Phase 1.

## Done definition

- Phase 1 decisions documented in this file's "Locked decisions" section.
- Phases 2–6 land, each gated by `pnpm check`.
- End-to-end demo: aprovar → estornar via admin button → status page reflects estornado → financeiro shows counter-lancamentos → contribuição follows the per-tipo policy.
- Webhook path tested with a simulated chargeback event.
- Underwater scenario covered per Q1's chosen policy with at least one test case.
