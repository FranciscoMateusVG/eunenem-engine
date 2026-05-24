# Plan 0005 — Durable event log + worker queue

> **Status**: drafted 2026-05-24, awaiting confirmation.
> **Depends on**: plan `0004-async-confirmation-and-webhooks.md` (specifically Phase 2 `processarEventoProvedor` and Phase 5 reconciliação — both are wrapped, not rewritten).
> **Unblocks**: plan `0006-lancamento-maturation-rule.md` (maturation cron rides on the same scheduler), and any future "react to event X" use case.

## Goal

Today (after 0004 lands) the webhook handler does:

```
HTTP POST → processarEventoProvedor → finalize* → ACK provider
```

That's synchronous. If our DB blips for 2 seconds, the provider sees a slow webhook, retries it (we handle the retry idempotently, good), but the user-perceived path is fragile. Reconciliação is a manual button. Maturation has no scheduler.

This plan introduces:

1. **Outbox pattern** — domain events are written into a Postgres table inside the same transaction as the state change that produced them. A worker drains the outbox.
2. **Worker loop** — a long-running process that polls the outbox, dispatches events to handlers, and marks them processed.
3. **Inbox for webhooks** — webhook handler shrinks to "record raw event, return 200 fast." A worker drains the inbox into `processarEventoProvedor`.
4. **Scheduled jobs** — reconciliação and maturation become recurring jobs the worker runs on a schedule.
5. **Retries with backoff** + **dead-letter** — failed processing is retried with exponential backoff; permanent failures land in a DLQ for human review.

## Locked decisions

1. **Postgres-as-queue, not Kafka/SQS.** We already have Postgres; the throughput needs are tiny (hundreds of events/min, not millions/sec). Single-DB transactional guarantees beat external queue complexity. `SELECT ... FOR UPDATE SKIP LOCKED` is the workhorse pattern.

2. **Outbox is per-BC.** Each BC that produces events gets its own outbox table: `arrecadacao_eventos_outbox`, `pagamentos_eventos_outbox`, `financeiro_eventos_outbox`. Shared table couples BCs at the schema level — we won't.

3. **Inbox is per-source.** Webhooks live in `pagamentos_webhooks_inbox`. A future "imported CSV" inbox would be `arrecadacao_imports_inbox`. Same reasoning as outbox.

4. **Single worker process in 0005; leader election deferred.** We boot one Node process that runs the worker loop. Multi-instance + leader election (so a second worker doesn't race) is plan 0005.5 or folded into deploy infra. For dev/demo, single-worker is correct.

5. **Dispatch is in-process function calls, not HTTP.** The worker imports `processarEventoProvedor`, `reconciliarPagamentosPendentes`, `maturarLancamentos` directly. No internal HTTP fan-out. Simpler to reason about; OTel context propagates naturally.

6. **Retry policy**: exponential backoff, base 30s, max 5 attempts, then DLQ. Configurable per event type later. The DLQ is just `status = 'dlq'` on the same outbox/inbox row plus a last-error column.

7. **Idempotency at the consumer.** Handlers must be idempotent (already true for Phase 4 of 0002). The worker may dispatch the same event twice if it crashes between dispatch and mark-processed; handlers handle that.

## DDD concepts this plan teaches

### Outbox pattern as the answer to "dual-write" problem

Today's webhook handler writes to its own state AND triggers downstream side effects in the same transaction-ish block. If the DB commit succeeds but a downstream call fails (or vice versa), we get drift. The classical fix: write the state change AND an outbox row in the *same DB transaction*. A separate worker reads the outbox and triggers side effects. Now the dual-write problem becomes "did we commit the outbox row?" — a single decision.

### Inbox is the symmetric pattern for external inputs

Webhook payloads are external state changes we don't control. The inbox is the dual of the outbox: record raw input atomically (with the idempotency key), then process from there. Provider retries hit the DB, see the dup key, get a fast 200. Our processing is decoupled from the provider's timeouts.

### Process Manager vs Worker

A *process manager* (like `finalizarPagamentoAprovado`) is **what** runs when an event arrives. The *worker* is **the engine** that decides *when* to run it. Today they're conflated (the HTTP request triggers both). Separating them makes scheduling, retries, and observability much cleaner. The use cases stay pure functions; the worker is the only place that knows about time-based dispatch.

### Eventually consistent windows become observable

With outbox/inbox, "this event hasn't been processed yet" is a real DB state you can query, not an invisible in-flight RPC. Dashboards can show outbox lag; tests can assert "after N seconds, outbox is drained." Eventual consistency stops being hand-wavy.

## Phases

### Phase 1 — Outbox table per producer BC + transactional write

**Objective**: Producers write events into their outbox in the same transaction as the state change. No worker yet; outbox just accumulates.

**Files NEW**:
```
migrations/
├── 20260601_001_create_arrecadacao_eventos_outbox.ts
├── 20260601_002_create_pagamentos_eventos_outbox.ts
└── 20260601_003_create_financeiro_eventos_outbox.ts
src/adapters/<bc>/
└── outbox-repository.{ts,memory.ts,postgres.ts}     # one per BC
src/domain/<bc>/value-objects/
└── evento-dominio.ts                                  # base shape: { id, tipo, payload, ocorridoEm }
```

**Schema (one per BC, identical shape)**:
```sql
CREATE TABLE <bc>_eventos_outbox (
  id              UUID PRIMARY KEY,
  tipo            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  ocorrido_em     TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pendente',  -- pendente | processado | dlq
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  processado_em   TIMESTAMPTZ
);
CREATE INDEX ON <bc>_eventos_outbox (status, proxima_tentativa_em);
```

**Files MODIFIED**: each existing use case that currently calls `pagamentoEventPublisher.publish(...)` (or equivalent) now ALSO writes to the BC's outbox in the same transaction. The event publisher port stays (for in-process listeners during transition); the outbox is the durable copy.

**Verification**: outbox rows accumulate as use cases run; tests assert "after `finalizarPagamentoAprovado` runs, an `aprovado` row is in the pagamentos outbox."

**STOP for confirmation.**

---

### Phase 2 — Worker loop (drains outbox)

**Objective**: A long-running loop that reads pending outbox rows across BCs, dispatches them to handlers, marks processed (or backs off + retries).

**Files NEW**:
```
src/workers/
├── worker.ts                        # main loop
├── handler-registry.ts              # tipo → handler function map
└── handlers/
    ├── pagamento-aprovado.handler.ts
    ├── pagamento-rejeitado.handler.ts
    └── ...
src/index.ts (export worker boot)
examples/run-worker.ts               # standalone worker process
```

**Behavior**:
```ts
async function workerTick(deps) {
  for (const outbox of [arrecadacao, pagamentos, financeiro]) {
    const batch = await outbox.lockNextBatch(BATCH_SIZE);  // SELECT ... FOR UPDATE SKIP LOCKED
    for (const row of batch) {
      try {
        const handler = handlerRegistry.get(row.tipo);
        await handler(row.payload, { observability, clock });
        await outbox.markProcessed(row.id);
      } catch (err) {
        await outbox.recordFailure(row.id, err, computeNextRetry(row.attempts));
      }
    }
  }
}
// run workerTick every 1s in a loop; stop on SIGTERM
```

**Out of scope**: leader election (single worker); priority queues (FIFO is fine); per-handler concurrency limits.

**Verification**: integration test boots worker, writes outbox row, asserts handler ran and row marked processed; another test asserts retry on handler failure with backoff.

**STOP for confirmation.**

---

### Phase 3 — Webhook inbox

**Objective**: Webhook handler becomes "insert into `pagamentos_webhooks_inbox` (idempotent by `idEventoProvedor`), return 200." A worker handler drains the inbox and calls `processarEventoProvedor` from 0004.

**Files NEW**:
```
migrations/
└── 20260601_004_create_pagamentos_webhooks_inbox.ts
src/adapters/pagamentos/
└── webhooks-inbox-repository.{ts,memory.ts,postgres.ts}
src/use-cases/pagamentos/
└── ingerir-webhook-provedor.ts      # raw-payload-in, inbox-row-out
src/workers/handlers/
└── webhook-provedor.handler.ts      # drains inbox → processarEventoProvedor
```

**Files MODIFIED**: `examples/fluxo-completo.web.ts` POST `/webhook/provedor` route — calls `ingerirWebhookProvedor` instead of `processarEventoProvedor`.

**Verification**: webhook returns 200 even if `processarEventoProvedor` is slow; inbox replay (same `idEventoProvedor` twice) is a no-op.

**STOP for confirmation.**

---

### Phase 4 — Scheduled jobs (reconciliação + maturation hook)

**Objective**: The worker, in addition to draining outbox/inbox, runs recurring jobs on a schedule.

**Files NEW**:
```
src/workers/
├── scheduler.ts                       # cron-style tick table
└── jobs/
    ├── reconciliar-pagamentos.job.ts  # calls reconciliarPagamentosPendentes(0004 Phase 5)
    └── (maturar-lancamentos.job.ts comes with plan 0006)
```

**Behavior**: a job table records `(nome, ultimo_run_em, proxima_execucao_em, intervalo_segundos)`. Worker tick checks "is any job due?" and runs them. Single-worker so no leader election yet.

**Files MODIFIED**: `examples/fluxo-completo.web.ts` removes the "Reconciliar pendentes" manual button (now automatic). Optional: keep button as "Run now" for testing.

**Verification**: integration test runs worker for N ticks, asserts reconciliação ran on schedule.

**STOP for confirmation.**

---

### Phase 5 — Dead-letter queue + ops UX

**Objective**: After 5 failed attempts, outbox/inbox rows flip to `status = 'dlq'`. The web demo gets a `/ops/dlq` page that lists DLQ rows and lets an admin retry or discard.

**Files MODIFIED**: outbox/inbox repos gain `findDlq()` + `retryFromDlq(id)`; web demo adds the page.

**Verification**: induce a handler that always throws, assert row reaches DLQ after 5 attempts; manual retry from DLQ works.

**STOP for confirmation.**

---

## Open questions

1. **Outbox row ordering guarantees.** Per BC, should we preserve `ocorridoEm` order on dispatch (per-aggregate FIFO)? Worth it for some BCs (Pagamento state machine wants order); irrelevant for others (independent contribuições). Per-BC choice.

2. **Should event payload reference state or embed it?** Embedded payload is robust to later state mutations but fattens the table. Reference (just ids) requires re-reading state at dispatch time and risks "state changed since event" weirdness. Likely embed for now.

3. **Schema for cross-BC events.** When pagamentos publishes `payment.approved` and arrecadacao wants to react, does arrecadacao subscribe via its own handler in the worker, or does pagamentos call arrecadacao directly (today's pattern)? The outbox+worker model invites loose coupling, but the current "process manager calls cross-BC use case" pattern is also fine. This is a style question that affects how the codebase evolves.

4. **Worker process lifecycle.** Same Node process as the HTTP server (split via flag), or a separate process that imports the same code? For demo: same process. For production: usually separate, so HTTP doesn't compete with worker for CPU.

5. **Observability story.** Outbox lag metrics, per-handler success/failure counts, DLQ size — what's the minimum we wire here vs leave to a future plan?

## Done definition

- All 5 phases land; `pnpm check` green.
- Webhook returns 200 in <50ms regardless of downstream load.
- Reconciliação runs automatically on schedule, no manual button needed (button may remain as "run now").
- Failed events end up in DLQ with last error visible.
- `docs/idempotency-and-concurrency.md` updated: question 5 (durable event store) marked answered with link to this plan.
