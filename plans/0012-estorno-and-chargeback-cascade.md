# Plan 0012 — Estorno / chargeback cascade

> 📌 **Heavy rewrite 2026-06-03 — rescoped by [0015](./0015-contribuicao-pagamento-financeiro-collapse.md).**
>
> The original 0012 spanned three estorno sources (chargeback, admin reembolso, pre-liquidation cancellation), modelled counter-lançamentos (`debito_estorno_*`) to express the cascade, and discussed mirroring Pagamento status back onto Contribuição. **0015 took over two of those three sources and removed the FSM-mirror pattern entirely.** What stays in 0012 is the genuinely-deferred remainder: **customer-initiated chargebacks** (the `charge.dispute.created` event class), explicitly out-of-scope per 0015 §Locked-decision 12.
>
> **What moved into 0015 and is no longer in 0012's scope:**
> - The admin/lojista reembolso path. Now lives as `estornar-pagamento` (0015 §Phase 2 — `src/use-cases/checkout/estornar-pagamento.ts`), a single use case that transitions `aprovado → estornado` and stamps `canceladoEm` on the pagamento's pre-transfer lançamentos in one DB transaction. No counter-lançamentos: the cascade is just two date columns.
> - The `aprovado → estornado` transition itself. Part of the canonical 5-state Pagamento FSM (0015 §Locked-decision 7).
> - Cross-BC cascade to Contribuição. Eliminated entirely: Contribuição has no status to mirror (0015 §Locked-decision 2). "Indisponivel" is a query (`EXISTS pagamento WHERE status='aprovado'`) — when a pagamento goes `estornado`, the predicate flips on its own with no separate write.
> - Lançamento counter-rows (`debito_estorno_recebedor`, etc.). Replaced by `canceladoEm` timestamps on pre-transfer lançamentos. The double-entry algebra collapses into "ignore rows where `canceladoEm IS NOT NULL`."
>
> **What stays in 0012 — the chargeback follow-up.** Customer-initiated disputes are categorically different from admin refunds: they arrive *post-transfer* (chargeback window is 120 days for Brazilian cartão; the operator may already have stamped `transferidoEm` on the lançamento), the 409 gate that protects admin refunds does NOT apply (Stripe processes the chargeback regardless of what the engine thinks), and recovering the money is an operational/ops problem, not a domain-write problem. This plan now covers:
>
> 1. Receiving `charge.dispute.created` (and `charge.dispute.updated`, `charge.dispute.closed`) from Stripe.
> 2. Recording the dispute against the pagamento without flipping its status (per 0015 §Locked-decision 12: dispute is an *unhandled audit event* in v1).
> 3. The **underwater scenario**: pagamento has `estornado`-equivalent effect (money clawed back by Stripe) but the lançamento already has `transferidoEm`. The engine can't undo the bank transfer; it has to either (a) book a `perda_chargeback_operacional` row, (b) mark the recebedor as owing, or (c) provide an ops escalation path. This is the *real* underwater problem 0015 punted on.
> 4. The provider-fee interaction with [plan 0013](./0013-provider-fee-passthrough.md): Stripe keeps their fee on chargebacks, so even when chargeback amount = pagamento amount, the plataforma is net-negative the original passthrough.
>
> The phase outline below is rewritten to reflect this narrower scope. Several old open questions (per-tipo Contribuição policy after estorno, partial-refund x receita-share) become **moot** because admin refund moved into 0015; the questions that remain are chargeback-specific.
>
> ---
>
> **Status**: drafted 2026-05-24, **rewritten 2026-06-03 post-0015**, awaiting confirmation. **Many decisions deliberately left open** — see "Open questions to answer before phases start" below. Don't begin implementation until those are resolved.
> **Depends on**: plan [`0015-contribuicao-pagamento-financeiro-collapse.md`](./0015-contribuicao-pagamento-financeiro-collapse.md) (canonical 5-state Pagamento FSM + `canceladoEm` lançamento model — chargeback handling layers on top of these), plan [`0004-async-confirmation-and-webhooks.md`](./0004-async-confirmation-and-webhooks.md) (webhook ingress + idempotency machinery — `charge.dispute.*` events route through the same `processarEventoProvedor` pipeline).
> **Synergizes with**: plan [`0013-provider-fee-passthrough.md`](./0013-provider-fee-passthrough.md) (Stripe keeps their fee on chargebacks — provider-fee passthrough now interacts with chargeback recovery), plan [`0014-banking-provider-and-repasse-execution.md`](./0014-banking-provider-and-repasse-execution.md) (when 0014's automated transfer model lands, "already transferred" becomes more common and underwater scenarios get hotter).

## Goal

After [0015](./0015-contribuicao-pagamento-financeiro-collapse.md) lands, the engine handles **admin/lojista-initiated refunds** cleanly: `aprovado → estornado` transition + `canceladoEm` stamped on pre-transfer lançamentos + 409 gate against post-transfer estornos. That leaves one source of reversal genuinely deferred: **customer-initiated chargebacks**.

Chargebacks differ from admin refunds in three operational ways that justify a separate plan:

1. **They arrive months later.** Brazilian cartão chargeback window is 120 days; PIX has its own dispute window. The pagamento has long since been `aprovado` and (often) the lançamento has long since been `transferidoEm`. The 409-gate that protects admin refunds does NOT apply — Stripe processes the chargeback regardless of engine state.
2. **The money is already gone.** Once Stripe accepts a chargeback, they debit the plataforma's Stripe balance. The engine learns about it after the fact via webhook. There is no "decide whether to chargeback" decision the engine can make.
3. **Recovery is operational, not algorithmic.** Once underwater, the only recovery paths are: collect from the recebedor (real-world coordination), absorb as a loss (book the row), or contest the chargeback (separate ops flow). The engine's job is to surface the situation accurately, not resolve it automatically.

This plan adds: webhook ingestion of dispute events, the underwater-state model on Pagamento, the `perda_chargeback_operacional` lançamento type for absorbed losses, and the read-side surfaces ops needs to act.

## What this plan does NOT cover (deferred)

- **Admin/lojista-initiated refund.** Implemented by 0015 §Phase 2.
- **The `aprovado → estornado` FSM transition.** Part of 0015's canonical 5-state FSM (0015 §Locked-decision 7); `charge.refunded` events still route to that transition. Disputes are tracked separately and do NOT transition pagamento status in v1 (per 0015 §Locked-decision 12 + this plan's locked decision 2 below).
- **Cross-BC cascade to Contribuição.** Eliminated by 0015 (Contribuição has no status; "indisponivel" is a query).
- **Anti-fraud scoring** that would prevent suspicious pagamentos before they're approved. Out of scope; chargeback is the *reaction*, not the prevention.
- **Insurance / chargeback guarantee products** that some PSPs sell. Pure financial product, not domain.
- **Dispute response workflow** (uploading evidence to contest a chargeback). That's a Salesforce-flavored ops UX, deferred to its own plan after this one ships the audit layer.

## Locked decisions

These are the few choices that aren't worth debating; the real decisions are in "Open questions" below.

1. **Disputes are recorded but do NOT transition Pagamento status in v1.** Per 0015 §Locked-decision 12, `charge.dispute.created` arrives as an audit event; the pagamento stays `aprovado`. Plan 0012 adds a sibling `disputas: Disputa[]` collection (or equivalent persistence shape — TBD in Q3 below) on Pagamento that records dispute lifecycle separately from status. The reason: a dispute can be *won* (Stripe sides with the merchant); flipping to `estornado` prematurely would either need a reverse-transition (which the FSM doesn't allow) or accept a stale `estornado` row. Recording-without-transitioning lets the engine wait for the dispute resolution event before doing anything irreversible.

2. **Webhook tipo enum gains `disputa_aberta`, `disputa_atualizada`, `disputa_encerrada`** as audit-only events in `EventoProvedorNormalizado` (defined by plan 0004). They route through `processarEventoProvedor` for idempotent recording, but the dispatch is a no-op transition (records the dispute row, no FSM call).

3. **Underwater recovery is operational, not automatic.** When a dispute closes against the merchant *and* the affected pagamento's lançamento already has `transferidoEm IS NOT NULL`, the engine surfaces an "ops escalation" state on Pagamento. It does NOT automatically claw back from the recebedor, does NOT automatically book a loss row, does NOT take any irreversible action. An admin use case (added in this plan) lets the operator choose: book a `perda_chargeback_operacional` loss, or mark the recebedor as owing (deferred — needs a "saldo negativo permitido" decision in Q1 below).

4. **Per-pagamento, never delete.** Disputes and any resulting loss-rows are append-only. The Pagamento aggregate keeps its history forever — this matches the rest of the engine's audit discipline (see 0015's "we store what happened" framing).

5. **Dispute identity is the provider's dispute ID.** Stripe's `dp_xxx`. Used for idempotency across multiple webhook events on the same dispute (e.g. `dispute.created` followed by `dispute.updated` followed by `dispute.closed`). NOT our internal Pagamento ID — disputes have their own lifecycle that's narrower than Pagamento's.

6. **No automatic chargeback-prevention or contestation flow.** Engine receives, records, surfaces. Engine does not auto-contest, does not auto-approve, does not score risk. Those are separate ops surfaces (or future plans).

## DDD concepts this plan teaches

### Audit events vs FSM transitions

The pre-0015 instinct was "a chargeback is the dual of an approval; it must be a state transition." 0015 §Locked-decision 12 + this plan's locked decision 1 explicitly reject that: a dispute is **information about the world** the engine learns asynchronously, not a domain command. Recording it as an audit event (a row in a sibling collection) is honest about what we know. Flipping `aprovado → estornado` on `dispute.created` would imply *we decided to reverse*, which we did not — Stripe decided to investigate. The transition belongs at `dispute.closed-against-merchant`, not at `dispute.created`. v1 records all of it; the optional transition is a later decision.

### The underwater problem is a real domain concept

If a dispute closes against the merchant after the lançamento has already been `transferidoEm`-stamped, the money has left the engine's control. This isn't a bug — it's a category of business risk every PSP carries. Modeling it explicitly (a `perda_chargeback_operacional` lançamento type, an `ops_escalacao_pendente` flag on the affected pagamento, or a recebedor-owes pattern with `saldo_negativo` allowed) is the domain stepping up to call the problem by name. Hiding it under "just don't transfer for 120 days" is throwing cash-flow at it.

### Multi-event lifecycle inside one aggregate's audit collection

A single Stripe dispute fires `dispute.created` → optionally `dispute.updated` (evidence stages) → `dispute.closed` (with `closed_against_merchant` or `closed_in_favor_of_merchant`). All three events refer to the same `dp_xxx` dispute ID. The Pagamento aggregate's `disputas: Disputa[]` collection records each event idempotently, the `Disputa` entity carries its own internal state (`aberta | em_revisao | encerrada_favoravel | encerrada_desfavoravel`), and the Pagamento root enforces collection-level invariants (at most one open dispute per pagamento at a time, total disputed amount ≤ pagamento amount). This is a nested-entity-with-its-own-lifecycle example — the entity has identity (its provider dispute ID), its own state machine, but no life outside its parent Pagamento.

### Recording vs Acting

The strongest lesson from the 0015 simplification, applied recursively: when an event class is ambiguous about whether the engine should *act*, the safe v1 is to **record** and surface to operators. Adding action is reversible (write the use case later); removing premature action is not (you've already mutated state). Disputes in v1: record everything, surface clearly, no mutations on Pagamento status. Disputes in vN, after the operator has watched 6 months of dispute traffic: maybe a configurable auto-transition policy. The order matters.

## Phases

> ⚠️ **Phase shape depends on the open-questions resolutions.** The phase outline below is a *plausible* sequence assuming the recommended defaults from each open question; revisit before execution.

### Phase 1 — Resolve the open questions (no code)

**Objective**: Hold a working session, walk through the open questions below, lock the decisions, and revise this plan's "Locked decisions" section in place. **No code lands in this phase.** This plan should not advance past Phase 1 until the decisions are written down.

**Deliverable**: this file's "Open questions" section becomes empty (or shrunk to genuinely-implementation-time questions), and "Locked decisions" gains the new entries.

**STOP for confirmation.**

---

### Phase 2 — Disputa nested entity + persistence

**Objective**: Pagamento learns a `disputas: Disputa[]` collection. No status transition on Pagamento; the dispute is its own audit lifecycle. Conforms to 0015 §Locked-decision 12 (dispute does NOT flip pagamento status in v1).

**Files NEW**:
```
src/domain/pagamentos/value-objects/
├── disputa.ts                              # nested entity: { idDisputaProvedor, status, amountCents, motivo, abertaEm, atualizadaEm, encerradaEm, resultado }
└── status-disputa.ts                       # 'aberta' | 'em_revisao' | 'encerrada_favoravel' | 'encerrada_desfavoravel'
src/errors/pagamentos/
├── disputa-duplicada.error.ts              # same idDisputaProvedor recorded twice with conflicting amount/motivo
└── pagamento-com-disputa-em-aberto.error.ts # admin tries to estornar a pagamento with an open dispute (Q4 below decides if this is hard-block or warning)
migrations/
└── 20280301_001_add_disputas_to_pagamentos.ts   # shape decided in Q3 (nested JSON column vs separate disputas_pagamento table)
```

**Files MODIFIED**:
- `src/domain/pagamentos/entities/pagamento.ts` — add `disputas: Disputa[]` field + helpers: `adicionarDisputa`, `atualizarDisputa(idDisputaProvedor, ...)`, `encerrarDisputa(idDisputaProvedor, resultado)`. Aggregate-level invariants: dispute amounts sum ≤ pagamento amount; at most one `aberta` dispute per pagamento at a time (Q4 may relax this).
- `src/adapters/pagamentos/repository.{memory,postgres}.ts` — persist + round-trip; conformance covers all dispute-status combinations.

**Verification**: dispute round-trips through both adapters; double-record on same idDisputaProvedor is idempotent (no-op when payload identical, raises `DisputaDuplicadaError` when amount or motivo conflict); pagamento status stays `aprovado` throughout.

**STOP for confirmation.**

---

### Phase 3 — `registrarEventoDisputa` use case + webhook dispatch

**Objective**: Idempotent recording of `charge.dispute.created`, `charge.dispute.updated`, and `charge.dispute.closed` Stripe events. Routes through the existing `processarEventoProvedor` pipeline from 0004; the dispatch for dispute tipos is a no-op on Pagamento FSM and a write on the disputes collection.

**Files NEW**:
```
src/use-cases/pagamentos/
└── registrar-evento-disputa.ts             # the three-event dispatch
```

**Files MODIFIED**:
- `src/domain/pagamentos/value-objects/evento-provedor.ts` (from 0004) — extend tipo enum: add `disputa_aberta`, `disputa_atualizada`, `disputa_encerrada`. The shape carries `idDisputaProvedor` + per-event payload.
- `src/use-cases/pagamentos/processar-evento-provedor.ts` (from 0004) — dispatch dispute tipos to `registrarEventoDisputa` (NOT to a Pagamento FSM transition).
- Webhook event parser — recognize Stripe's `charge.dispute.created` / `charge.dispute.updated` / `charge.dispute.closed` payloads; normalize.

**Behavior**:
```ts
registrarEventoDisputa(deps, evento: EventoProvedorNormalizado)
  → idempotency: events table guards re-delivery on idEventoProvedor (already from 0004)
  → resolve pagamento via charge → idPagamento lookup chain (aperture-wif8s)
  → branch on tipo:
       'disputa_aberta'      → pagamento.adicionarDisputa(...)
       'disputa_atualizada'  → pagamento.atualizarDisputa(idDisputaProvedor, ...)
       'disputa_encerrada'   → pagamento.encerrarDisputa(idDisputaProvedor, resultado)
                               + IF resultado === 'desfavoravel' AND any lançamento has transferidoEm IS NOT NULL
                                 → flag underwater (Phase 4 handles the resolution)
  → save pagamento
  → log 'pagamentos.disputa.registrada'
```

**Verification**: simulated Stripe dispute lifecycle (created → updated → closed-against-merchant) round-trips into the disputes collection; pagamento status stays `aprovado`; replay-on-each-event is a no-op.

**STOP for confirmation.**

---

### Phase 4 — Underwater detection + admin resolution use cases

**Objective**: When `disputa_encerrada` arrives with `resultado: 'desfavoravel'` AND the affected pagamento's lançamentos include any with `transferidoEm IS NOT NULL`, surface "ops escalation needed." Admin chooses resolution: book the loss, or mark recebedor as owing (Q1 decides if owing is even allowed).

**Files NEW**:
```
src/use-cases/pagamentos/financeiro/
├── obter-pagamentos-underwater.ts          # read-side: dispute closed desfavoravel + any lançamento transferred
├── absorver-perda-chargeback.ts            # admin action: book perda_chargeback_operacional row
└── marcar-recebedor-devendo.ts             # admin action: open follow-up bead — needs Q1's "saldo negativo allowed" decision
src/errors/pagamentos/financeiro/
├── pagamento-nao-underwater.error.ts       # admin tries to resolve a pagamento that's not actually underwater
└── perda-ja-absorvida.error.ts             # double-absorb attempt
```

**Files MODIFIED**:
- `src/domain/pagamentos/financeiro/value-objects/tipo-lancamento.ts` — add `perda_chargeback_operacional`.
- `src/domain/pagamentos/financeiro/entities/lancamento-financeiro.ts` — the new tipo creates a row with `transferidoEm: null`, `canceladoEm: null`, just like any other lançamento; its semantic is "plataforma absorbed this much from receita to make recebedor whole."

**Behavior**:
```ts
absorverPerdaChargeback(deps, { idPagamento, motivo })
  → guard: pagamento has at least one disputa with status='encerrada_desfavoravel'
  → guard: pagamento has at least one lançamento with transferidoEm IS NOT NULL
  → guard: no existing perda_chargeback_operacional lançamento on this pagamento (idempotency)
  → create perda_chargeback_operacional lançamento with amount = transferred lançamento sum
  → log 'pagamentos.financeiro.perda_chargeback_absorvida'
```

**Verification**: full lifecycle test — pagamento aprovado → lançamentos transferred → dispute closed desfavoravel → ops list shows pagamento as underwater → admin calls absorverPerdaChargeback → loss row created, audit log emitted.

**STOP for confirmation.**

---

### Phase 5 — Read-side surfaces + demo wiring

**Objective**: Admin contribuição-detail screen (0015 §Phase 6) gains a "Disputas" sub-card per pagamento; underwater ops queue gets its own page.

**Files MODIFIED**:
- `consultarStatusContribuicao` (0004 Phase 4 / 0015 Phase 6) — DTO grows `pagamentos[i].disputas: DisputaView[]` and per-pagamento `underwaterAmount: MoneyCents | null`.
- Admin contribuição detail page — render the new sub-card; treat resolved-favoravel as info, encerrada_desfavoravel as warning, underwater as alert.
- NEW admin "underwater queue" page — lists all pagamentos with disputa_encerrada_desfavoravel + transferred lançamentos, with "absorver perda" buttons.
- `examples/fluxo-completo.web.ts` — simulator buttons for each dispute event (mirrors 0004's webhook simulator pattern).

**Verification**: end-to-end manual walk on staging: aprovar → marcar transferred → simulate dispute_created → simulate dispute_closed_desfavoravel → underwater queue lights up → admin absorbs loss → row created.

**STOP for confirmation.**

---

## Open questions to answer before phases start

> 📝 **Pruned 2026-06-03 post-0015.** The original Q2 (per-tipo Contribuição policy after estorno), Q4 (dispute window vs maturation timing), Q5 (receita proportional split on partial), and Q8 (per-plataforma vs global for the moot Qs) are all **retired by 0015**:
> - Q2 retired: Contribuição has no status, so "what happens to it on estorno" is moot — the indisponivel predicate flips on its own.
> - Q4 retired: there is no `maturaEm` to align with the dispute window. `transferidoEm` is operator-driven; the operator decides when to stamp it (and per Q1 below, may decide to wait out the dispute window for cartão pagamentos).
> - Q5 retired: partial *refund* is handled by 0015 §Locked-decision 7 (partial refunds stay `aprovado`; only full refunds trigger `estornado`). Partial-chargeback (a real Stripe event) is covered by the new Q3 below — the dispute's `amountCents` carries the partial amount on the dispute record without splitting receita.
> - Q8 retired: the moot Qs are gone; the surviving Qs are either inherently global or get resolved as engine-wide v1 defaults.

### Q1 — Underwater resolution policy

When a dispute closes `desfavoravel` against the merchant AND the affected pagamento's lançamento already has `transferidoEm IS NOT NULL`, what does the engine offer the operator?

Options:
- **A. Absorb the loss only.** One admin action: `absorverPerdaChargeback` creates a `perda_chargeback_operacional` lançamento. Recebedor keeps the money. Plataforma absorbs. Simplest, fits v1.
- **B. Absorb OR mark recebedor as owing.** Two admin actions: absorb (option A), or `marcarRecebedorDevendo` opens a "recebedor owes plataforma X" tab that subtracts from future repasses. Requires "saldo negativo permitido" semantics and a recebedor-debt tracking model.
- **C. Configurable per plataforma.** Each plataforma's admin chooses default behavior.

**Recommend A for v1.** B is correct long-term but adds a sub-domain (recebedor-debt) we don't have today. C is premature without a second plataforma actually disagreeing on the policy.

### Q2 — Pre-emptive transferidoEm hold for unaresolved disputes

When a dispute is `aberta` (or `em_revisao`) and the operator is about to mark the affected lançamento as transferred, should the engine:
- **A. Block the transfer entirely** via a 409-style gate on `marcar-lancamento-transferido` (mirror of 0015's estorno gate but in the other direction).
- **B. Warn but allow** — operator sees "this pagamento has an open dispute," confirms intent, proceeds.
- **C. Do nothing** — disputes don't block transfers; underwater is purely a post-fact problem.

**Recommend B for v1.** A is the strict version (matches 0015's symmetry instinct) but costs cash flow if disputes go long. C is the laissez-faire version that gambles. B preserves operator agency and audit.

### Q3 — Partial dispute representation

Stripe disputes carry an `amount` (Disputed Amount) which may be less than the original charge total. The `Disputa` entity from Phase 2 stores `amountCents`. Two model shapes:
- **A. amount-only**: Disputa carries `amountCents`; we don't break down "what portion" of the original charge is disputed. Aggregate-level invariant: sum of dispute amounts ≤ pagamento amount.
- **B. amount + which-lançamento**: Disputa carries a `lancamentosAfetados: IdLancamento[]` list when known (rarely is, from Stripe).

**Recommend A.** Stripe doesn't tell us which lançamento was "the disputed one"; that's our derived narrative. v1 just records the amount and surfaces it; the operator reasons about which lançamentos are at risk during resolution.

### Q4 — Multiple disputes per pagamento — concurrency model

The Phase 2 invariant "at most one `aberta` dispute at a time" is intuitive but not strictly Stripe-accurate (rare but possible for a contribuinte to dispute multiple charges on the same payment). Options:
- **A. Hard invariant**: at most one open dispute. Second `dispute.created` for same pagamento → reject + ops alert.
- **B. Soft invariant**: warn but allow. Multiple open disputes possible; the engine sums their amounts for underwater calc.
- **C. Per-charge invariant**: at most one open dispute per `chargeExternalRef` (a pagamento may have multiple charges, though today's flow doesn't).

**Recommend A for v1** with a pre-Q1-decided escape hatch — if it ever fires, operator unblocks via ops use case. We can soften to B if it fires more than once.

### Q5 — Notification policy

When a dispute opens or closes desfavoravel, who gets notified?
- Recebedor (their pending payout may be at risk)?
- Admin of the plataforma?
- The original contribuinte (already heard from their bank)?

Depends on email/notification infrastructure we don't have yet — out of scope for 0012's *implementation* but worth deciding the policy so we know what events the system needs to emit.

### Q6 — Idempotency across multi-source dispute events

What if Stripe redelivers `dispute.created` for the same `dp_xxx`? What if `dispute.updated` arrives before `dispute.created` (out-of-order)? Options:
- **A. idEventoProvedor + idDisputaProvedor double idempotency**: events table guards the webhook id, disputes collection guards the dispute id. Belt + suspenders.
- **B. idEventoProvedor only**: trust the webhook id; disputes collection is updated naively.

**Recommend A.** The Stripe webhook id catches re-delivery; the dispute id catches "two webhooks for different events on the same dispute" race + out-of-order delivery (the disputes-table state-machine logic decides which event "wins" via timestamp).

### Q7 — Chargeback × provider fee passthrough (interaction with plan 0013)

Plan [0013](./0013-provider-fee-passthrough.md) introduces `credito_reembolso_taxa_provedor` (money collected from contribuinte specifically to cover Stripe's fee). On chargeback:

- Contribuinte gets full refund (R$87.50 back, per Stripe policy).
- Stripe **keeps** their R$3.50 fee (typical chargeback policy).
- Plataforma is out R$3.50 net per chargeback, *on top of* whatever recebedor reversal happens.

So Phase 4's loss row may need to be **two rows**: `perda_chargeback_operacional` (for the underwater principal) + `perda_taxa_provedor_chargeback` (for the unrecovered Stripe fee). Or one combined row with a breakdown.

Whether 0012 introduces these tipos or 0013 does — and how the two plans coordinate — is itself a decision worth taking in Phase 1. Pragmatically: 0012 introduces both because it's the plan that actually fires the loss; 0013 just documents that the passthrough exists.

### Q8 — Stripe dispute close-state → domain `status-disputa` mapping

The Phase 2 skeleton sketches `status-disputa.ts` as `'aberta' | 'em_revisao' | 'encerrada_favoravel' | 'encerrada_desfavoravel'` — a **binary** closed outcome. Stripe's actual `Charge.Dispute.status` is richer:

- `warning_needs_response` / `warning_under_review` / `warning_closed` — Stripe's inquiry tier (pre-dispute warning, no funds withdrawn yet)
- `needs_response` / `under_review` — active dispute, evidence stage
- `won` — closed in merchant favor (funds restored, no loss)
- `lost` — closed against merchant (funds withdrawn permanently — the underwater case)
- `charge_refunded` — merchant accepted the dispute (effectively a voluntary loss)

The binary skeleton elides this granularity and conflates warning-tier signals (which don't withdraw funds) with active disputes (which do). It also doesn't carry the `charge_refunded` close-path, which is distinct from `lost` in audit terms.

Also relevant: Stripe fires **intermediate** events on the dispute lifecycle:

- `charge.dispute.funds_withdrawn` — Stripe debits the platform's Stripe balance pending resolution
- `charge.dispute.funds_reinstated` — withdrawal reversed (typically on `won`)

These don't fit the simple `created → updated → closed` triad assumed in Phase 3.

**Decide before Phase 2 implementation:**

1. The full set of dispute statuses the domain models. Recommend: keep them all, mapping 1:1 from Stripe's enum (lossy mappings invite bugs later).
2. Whether `funds_withdrawn` / `funds_reinstated` are audit-only events (recorded on `payment_webhook_events`, no domain state change) or domain transitions on the `Disputa` entity (e.g. an `funds_withdrawn: boolean` flag that affects the underwater predicate before the dispute closes).
3. How `warning_*` statuses are surfaced — they aren't disputes yet, but they're predictive signal worth showing to ops.

### Q9 — Cascade shape on a mixed-state pagamento (transferred + pending lançamentos)

Phase 4's `absorverPerdaChargeback` handles the case where **at least one** lançamento on the disputed pagamento has `transferidoEm IS NOT NULL`. The loss row covers the transferred portion. But what about pagamentos with **both** transferred AND pending lançamentos under the same `idPagamento`?

Concrete scenario:

- Pagamento P had 2 lançamentos at aprovação time:
  - L1 (recebedor's slice) — admin marked `transferidoEm` last week
  - L2 (some other receita / passthrough slice that the operator hasn't yet stamped) — `transferidoEm IS NULL`
- Dispute on P closes `lost` (`encerrada_desfavoravel`).
- The contribuinte's full amount is withdrawn from Stripe; the platform is underwater on L1 (already paid out to recebedor) AND L2 is now an invalid promise (the underlying pagamento has been clawed back; there's no money to back the future payout).

Phase 4 as currently spec'd:
- Creates ONE `perda_chargeback_operacional` row sized to the **transferred** portion (L1's amount).
- Says nothing about L2.

The right behaviour (probably): **also stamp `canceladoEm = now()` on the pending L2** because the chargeback voids the entire payout commitment, not just the already-paid-out portion. Different bookkeeping shape from pre-transfer estorno (which uses `canceladoEm` only) and from the simple post-transfer chargeback (which uses the loss row only) — this is a **hybrid cascade** that touches both columns on different rows of the same pagamento.

**Decide before Phase 4 implementation:**

1. Confirm the hybrid cascade shape: loss-row on transferred + `canceladoEm` on pending.
2. Whether this is a single atomic transaction (one `absorverPerdaChargeback` call does both) or two separate admin actions (operator chooses to absorb the loss AND separately confirms cancellation of pending lançamentos).
3. How the read-side surfaces the mixed state — does the underwater queue show "underwater R$X + cancelled R$Y" per pagamento, or two separate queue entries?

This case is rare today (most pagamentos have one or two lançamentos, all stamped together) but becomes more common once provider-fee-passthrough (0013) and any future per-tipo lançamento splits introduce more rows per pagamento. Decide the cascade shape now so the implementation has a clear contract.

## Done definition

- Phase 1 decisions documented in this file's "Locked decisions" section.
- Phases 2–5 land, each gated by `pnpm check`.
- End-to-end demo: aprovar → marcar transferred → simulate `dispute_created` → simulate `dispute_closed_desfavoravel` → ops underwater queue surfaces the pagamento → admin absorbs loss → `perda_chargeback_operacional` row created and audited.
- Webhook path tested with all three dispute event types (created, updated, closed) including out-of-order delivery.
- The original 0015-superseded scenarios (admin/lojista refund, pre-transfer estorno cascade) are NOT re-tested here — they live in 0015's verification.
