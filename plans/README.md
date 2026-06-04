# Plans

This folder holds the engine's planning documents. Each plan follows the same shape: locked decisions → DDD concepts → phases → open questions → done definition. Completed plans get a `-done` suffix; in-flight plans don't.

Read plans in dependency order, not file order — see the graph below.

## Status snapshot

| #    | Plan                                                                          | Status       | Theme                                            |
| ---- | ----------------------------------------------------------------------------- | ------------ | ------------------------------------------------ |
| 0001 | [domain-vo-entity-split-done](./0001-domain-vo-entity-split-done.md)          | ✅ done      | Folder layout (entities/ + value-objects/)        |
| 0002 | [checkout-orchestration-layer-done](./0002-checkout-orchestration-layer-done.md) | ✅ done   | Saga + Process Manager + Read-DTO + Idempotency  |
| 0003 | [plataforma-multi-tenant-done](./0003-plataforma-multi-tenant-done.md)        | ✅ done      | Plataforma BC + per-tenant scoping                |
| 0004 | [async-confirmation-and-webhooks](./0004-async-confirmation-and-webhooks.md)  | 📝 drafted   | Webhook ingress + rejection compensation         |
| 0005 | [durable-event-log-and-worker-queue](./0005-durable-event-log-and-worker-queue.md) | 📝 drafted | Outbox + inbox + worker + scheduler + DLQ      |
| 0006 | [lancamento-maturation-rule-superseded](./0006-lancamento-maturation-rule-superseded.md) | ⛔ superseded by 0015 | D+30 / T+0 maturation as data (retired — replaced by observed `transferidoEm`) |
| 0007 | [webhook-authn-authz](./0007-webhook-authn-authz.md)                          | 📝 drafted   | Signature verification, IP allowlist, audit      |
| 0008 | [concurrency-safety-on-claim-superseded](./0008-concurrency-safety-on-claim-superseded.md) | ⛔ superseded by 0015 | Optimistic CC via `versao` column (retired — no claim step anymore) |
| 0009 | [plataforma-management-and-admin-ux](./0009-plataforma-management-and-admin-ux.md) | 📝 drafted | Lifecycle + versioned RegraTaxa + admin UI    |
| 0010 | [real-authentication-and-sessions](./0010-real-authentication-and-sessions.md) | 📝 drafted  | argon2id, opaque tokens, roles                    |
| 0011 | [postgres-conformance-sweep](./0011-postgres-conformance-sweep.md)            | 📝 drafted   | Adapter parity audit + CI lock-in                |
| 0012 | [estorno-and-chargeback-cascade](./0012-estorno-and-chargeback-cascade.md)    | 📝 drafted (rewritten by 0015) | Now scoped to customer-initiated chargebacks (`charge.dispute.created`) — admin/lojista refund path implemented by 0015 |
| 0013 | [provider-fee-passthrough](./0013-provider-fee-passthrough.md)                | 📝 drafted   | 3-part composition; surcharge for Stripe fees    |
| 0014 | [banking-provider-and-repasse-execution](./0014-banking-provider-and-repasse-execution.md) | 📝 drafted (deferred by 0015) | ⚠️ Real bank transfers (Inter/Nubank); HIGH-RISK — v1 uses manual `transferidoEm`, automated banking is post-0015 |
| 0015 | [contribuicao-pagamento-financeiro-collapse](./0015-contribuicao-pagamento-financeiro-collapse.md) | 📝 drafted | Single Pagamento FSM; Contribuição → slot; Financeiro → module of Pagamentos; supersedes parts of 0006/0008/0012 |

## Dependency graph

Arrows mean "needs to be done (or partially done) before." Plans without arrows in are free to start. Plans crossed-out are superseded by 0015.

```
0001 ──┐
       ├──> 0002 ──┐
       │           ├──> 0004 ──┬──> 0005 ──> ~~0006~~ (superseded by 0015)
       │           │           ├──> 0007
       ├──> 0003 ──┤           ├──> ~~0008~~ (superseded by 0015)
       │           │           │
       │           ├──> 0009 <─┤
       │           │           │ (admin UX needs
       │           │           │  auth to be safe)
       │           └───────────┤
       │                       │
       │                       └─── 0010
       │                            (auth/sessions)
       │
       │                       ┌──> 0013 (provider fee passthrough,
       │                       │         depends on 0002 + 0009)
       │                       │
       │                       └──> 0014 (deferred by 0015 — v1 is manual
       │                                  transferidoEm; banking integration
       │                                  becomes a follow-up plan)
       │
       │                       ┌──> 0015 ◄── 0002 + 0004 + 0013
       │                       │    (collapse: single Pagamento FSM,
       │                       │     Financeiro folds into Pagamentos,
       │                       │     Contribuição → slot only)
       │                       │
       │                       └──> 0012 ◄─── 0015
       │                            (now scoped to customer-initiated
       │                             chargebacks only — admin/lojista
       │                             refund path implemented in 0015)
       │
       └──> 0011 (hygiene — best run after 0005/0007/0010/0013/0014/0015 add their adapters)
```

Notes:
- **0015** is the **simplification pass** after the original event-driven design lessons were learned. It supersedes parts of 0006 (no maturation rule — `transferidoEm` is observed not predicted), 0008 (no claim step — no shared status to race on), and 0012 (admin/lojista refund collapses into a simple `canceladoEm` timestamp + 409 gate; only customer-initiated chargebacks remain in 0012's scope).
- **0006, 0008** are retained on disk with `-superseded` suffix as historical context. Don't implement them.
- **0009** (admin UX) and **0010** (auth) are deeply intertwined: 0010 unblocks "admin UX safe to expose." Run 0010 before 0009 Phase 4, or land 0009 Phases 1–3 (no UI) first and then do 0010 and finally 0009 Phase 4.
- **0011** is hygiene. Run it after any plan that introduces adapters, or run a small slice at the end of each plan.

## Suggested execution order

Two viable orderings depending on what you want to learn / unblock next.

> 📌 **2026-06-03 — 0015 reshuffle.** Both paths below now route through 0015 immediately after 0004. 0015 is the *simplification pass* — it locks in the lessons from the original event-driven design (Pagamento FSM, Contribuição-as-slot, Financeiro-as-module, observed-not-predicted lançamento state) before any infra plan layers on top. The retired plans (0006, 0008) drop off both paths; 0012 narrows to chargebacks only and is mostly post-0015.

### A. "Make the engine production-realistic" path

1. **0004** — async confirmation (most production-relevant gap)
2. **0015** — model collapse (locks in single Pagamento FSM + Financeiro-as-module before anything else builds on the model)
3. **0005** — durable event log + queue (turns 0004's manual flow into automatic)
4. **0007** — webhook auth (mandatory before any real provider, including bank)
5. **0013** — provider fee passthrough (real margins; needed before onboarding Stripe seriously)
6. **0012** — chargeback flow (now scoped to `charge.dispute.created`; admin/lojista refund already shipped via 0015)
7. **0014** — banking provider / repasse execution (replaces manual Inter web UI; HIGH-RISK; v1 of 0015 ships with manual `transferidoEm`)
8. **0010** — auth (unlocks safe admin)
9. **0009** — admin UX (uses 0010's auth)
10. **0011** — conformance sweep (catches everything in one pass)

### B. "Round out the model first, infra later" path

1. **0004** — async confirmation
2. **0015** — model collapse (foundational; gates everything model-shaped that follows)
3. **0009 Phases 1–3** — plataforma lifecycle + versioned RegraTaxa (no UI)
4. **0013** — provider fee passthrough (composition becomes 3-part — anchor the pricing story)
5. **0014 Phases 1–6** — banking provider port + use cases (no real Inter yet; fake adapter only)
6. **0012** — chargeback flow (the disputes-only remainder)
7. **0010** — auth
8. **0005** — durable queue + workers (now there's plenty to schedule)
9. **0009 Phase 4 + 0007 + 0014 Phase 8 (Inter adapter)** — admin UI + webhook auth + real bank
10. **0011** — sweep

Path A is closer to "ship-ready"; path B is closer to "domain-rich learning trajectory" since it front-loads BC modeling work and pushes infra (queues, workers, auth) later.

## Format conventions

Each plan should have:

1. **Status line** at the top: drafted date, dependencies, what it unblocks.
2. **Goal** in plain language — what changes after this lands.
3. **Locked decisions** — the choices that don't get revisited mid-implementation. Each numbered with rationale.
4. **DDD concepts this plan teaches** — the *why* in pedagogical terms. This is the engine's learning thread.
5. **Phases** — small, each ending with `STOP for confirmation`. Each phase has: Objective → Files NEW/MODIFIED → Behavior or Schema → Verification.
6. **Open questions** — things to discuss before or during execution. Better to write them down than carry them in heads.
7. **Done definition** — concrete acceptance criteria.

When a plan completes:
- Rename file with `-done` suffix.
- Update status line to ✅.
- Update any other plan that referenced the old filename.
- Update this README's table.

## Companion docs

- [`../docs/ddd-conventions.md`](../docs/ddd-conventions.md) — entity vs value object, aggregate root rules, mirror VOs, file layout.
- [`../docs/idempotency-and-concurrency.md`](../docs/idempotency-and-concurrency.md) — the 5 open questions on idempotency/concurrency, mapped to plans 0004/0005/0008.
