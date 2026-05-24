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
| 0006 | [lancamento-maturation-rule](./0006-lancamento-maturation-rule.md)            | 📝 drafted   | D+30 / T+0 maturation as data, not code           |
| 0007 | [webhook-authn-authz](./0007-webhook-authn-authz.md)                          | 📝 drafted   | Signature verification, IP allowlist, audit      |
| 0008 | [concurrency-safety-on-claim](./0008-concurrency-safety-on-claim.md)          | 📝 drafted   | Optimistic CC via `versao` column                |
| 0009 | [plataforma-management-and-admin-ux](./0009-plataforma-management-and-admin-ux.md) | 📝 drafted | Lifecycle + versioned RegraTaxa + admin UI    |
| 0010 | [real-authentication-and-sessions](./0010-real-authentication-and-sessions.md) | 📝 drafted  | argon2id, opaque tokens, roles                    |
| 0011 | [postgres-conformance-sweep](./0011-postgres-conformance-sweep.md)            | 📝 drafted   | Adapter parity audit + CI lock-in                |
| 0012 | [estorno-and-chargeback-cascade](./0012-estorno-and-chargeback-cascade.md)    | 📝 drafted   | Post-confirmation reversal across all BCs        |
| 0013 | [provider-fee-passthrough](./0013-provider-fee-passthrough.md)                | 📝 drafted   | 3-part composition; surcharge for Stripe fees    |
| 0014 | [banking-provider-and-repasse-execution](./0014-banking-provider-and-repasse-execution.md) | 📝 drafted | ⚠️ Real bank transfers (Inter/Nubank); HIGH-RISK |

## Dependency graph

Arrows mean "needs to be done (or partially done) before." Plans without arrows in are free to start.

```
0001 ──┐
       ├──> 0002 ──┐
       │           ├──> 0004 ──┬──> 0005 ──> 0006 ──┐
       │           │           ├──> 0007            │
       ├──> 0003 ──┤           ├──> 0008            ├──> 0012 ◄──┐
       │           │           │                    │  (estorno  │
       │           ├──> 0009 <─┤                    │   cascade) │
       │           │           │ (admin UX needs    │            │
       │           │           │  auth to be safe)  │            │
       │           └───────────┤                    │            │
       │                       │                    │            │  (0012 + 0013 interact:
       │                       └─── 0010 ───────────┘            │   chargeback × provider
       │                            (auth/sessions)              │   fee passthrough)
       │                                                         │
       │                       ┌──> 0013 (provider fee passthrough,
       │                       │         depends on 0002 + 0009)
       │                       │
       │                       └──> 0014 (banking provider / repasse execution
       │                                  — HIGH-RISK; reuses 0004/0005/0007 patterns,
       │                                  │ adds egress fee analog of 0013)
       │
       └──> 0011 (hygiene — best run after 0005/0007/0010/0012/0013/0014 add their adapters)
```

Notes:
- **0008** (concurrency) doesn't strictly depend on anything past 0002, but its value spikes once multiple writers exist (worker queue from 0005, multi-process deploys). You can land it any time.
- **0006** (maturation) is technically usable without 0005 — the use case stands alone — but the cron piece needs 0005's scheduler.
- **0009** (admin UX) and **0010** (auth) are deeply intertwined: 0010 unblocks "admin UX safe to expose." Run 0010 before 0009 Phase 4, or land 0009 Phases 1–3 (no UI) first and then do 0010 and finally 0009 Phase 4.
- **0011** is hygiene. Run it after any plan that introduces adapters, or run a small slice at the end of each plan.

## Suggested execution order

Two viable orderings depending on what you want to learn / unblock next:

### A. "Make the engine production-realistic" path

1. **0004** — async confirmation (most production-relevant gap)
2. **0008** — concurrency safety (cheap, foundational, unlocks confidence)
3. **0005** — durable event log + queue (turns 0004's manual flow into automatic)
4. **0007** — webhook auth (mandatory before any real provider, including bank)
5. **0006** — maturation (kills the demo hack, finalizes Financeiro story)
6. **0013** — provider fee passthrough (real margins; needed before onboarding Stripe seriously)
7. **0012** — estorno cascade (now informed by 0013's passthrough lancamentos)
8. **0014** — banking provider / repasse execution (replaces manual Inter web UI; HIGH-RISK)
9. **0010** — auth (unlocks safe admin)
10. **0009** — admin UX (uses 0010's auth)
11. **0011** — conformance sweep (catches everything in one pass)

### B. "Round out the model first, infra later" path

1. **0004** — async confirmation
2. **0009 Phases 1–3** — plataforma lifecycle + versioned RegraTaxa (no UI)
3. **0013** — provider fee passthrough (composition becomes 3-part — anchor the pricing story)
4. **0014 Phases 1–6** — banking provider port + use cases (no real Inter yet; fake adapter only)
5. **0006** — maturation use case (without scheduler, manual)
6. **0012** — estorno cascade (now informed by 0013's passthrough lancamentos)
7. **0008** — concurrency safety
8. **0010** — auth
9. **0005** — durable queue + workers (now there's plenty to schedule)
10. **0009 Phase 4 + 0007 + 0014 Phase 8 (Inter adapter)** — admin UI + webhook auth + real bank
11. **0011** — sweep

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
