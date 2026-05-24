# Idempotency, Replay & Concurrency — engine

Captures the design decisions and open questions around retry safety, idempotency, and concurrent access in the orchestration layer. Concrete reference is `src/use-cases/checkout/finalizar-pagamento-aprovado.ts` (the Phase 3 + Phase 4 process manager).

This is a **discussion doc**, not a settled spec — several deferred items below are real concerns that need their own plan eventually.

---

## Principle: idempotency is a domain invariant

> "Calling `finalizarPagamentoAprovado(idPagamento)` twice produces exactly one set of Financeiro effects — no matter how many times the caller retries."

Notice what this is NOT:
- ❌ "We dedup at the HTTP layer using an `Idempotency-Key` header"
- ❌ "The client must send the same request body to dedup"
- ❌ "We store the request hash and short-circuit duplicates"

What it IS:
- ✅ The **natural identifier of the operation** (`idPagamento`) IS the dedup key.
- ✅ The invariant lives in the **use case**, not in middleware.
- ✅ Any layer (HTTP, queue consumer, retry handler, manual operator) calling the use case twice gets the same outcome by construction.

**Why this matters in DDD:** if you push idempotency to HTTP middleware, the domain still has the bug — it's just hidden one layer up. The first caller to bypass HTTP (worker, batch job, admin REPL) re-introduces the bug. Putting it in the use case means *no caller anywhere* can violate the invariant.

---

## The current model: two replay paths in `finalizarPagamentoAprovado`

The process manager has **two crash points** between which a retry could land. Each gets an explicit replay branch:

```
┌──────────────────────────────────────────────────────────┐
│  finalizarPagamentoAprovado(idPagamento)                 │
│                                                          │
│   ① find Pagamento                                       │
│      ├── status === 'aprovado'  → REPLAY-1 (skip provider)│
│      ├── status === 'pendente'  → call aprovarPagamento  │
│      └── other (rejeitado/…)    → throw typed error      │
│                                                          │
│   ② fetch Contribuicao → Campanha (cross-BC join)        │
│                                                          │
│   ③ find existing lancamentos                            │
│      ├── exists → REPLAY-2 (return them as-is)           │
│      └── none   → call registrarEfeitos…                 │
└──────────────────────────────────────────────────────────┘
```

**Each replay path emits a distinct log event** (`checkout.pagamento.replay_aprovacao`, `checkout.pagamento.replay_financeiro`) so ops can tell which "leg" of the orchestrator a retry exercised. Useful for spotting unexpected retry patterns in production.

### Crash scenarios this handles

| When the crash happened | What the retry sees | What happens |
|---|---|---|
| Before any work | Pagamento `pendente`, no lancamentos | Normal path — runs everything |
| After provider approval, before Financeiro | Pagamento `aprovado`, no lancamentos | REPLAY-1 + run Financeiro |
| After everything | Pagamento `aprovado`, lancamentos exist | REPLAY-1 + REPLAY-2 (full no-op, same result) |

---

## "Look before you leap" vs "Try and react"

Two valid designs for idempotent operations:

### Design A — Check + branch (what we chose)

```ts
const existing = await pagamentoRepository.findById(idPagamento);
if (existing?.status === 'aprovado') {
  // skip the provider call entirely
} else if (existing?.status === 'pendente') {
  await aprovarPagamento(...);
}
```

**Pros:**
- Reads like a state machine — every branch is named.
- No exception-driven control flow.
- Each replay path can have its own log event without parsing error types.

**Cons:**
- Extra round-trip on the happy path (an extra `findById`).
- Race window between `findById` and the action (see below).

### Design B — Try and react

```ts
try {
  await aprovarPagamento(...);
} catch (err) {
  if (err instanceof PagamentoTransicaoStatusInvalidaError && err.statusAtual === 'aprovado') {
    // recover: load the existing pagamento, continue
  } else {
    throw err;
  }
}
```

**Pros:**
- Smaller race window (the database-level lock during the operation IS the synchronization).
- No extra round-trip on the happy path.

**Cons:**
- Exception-driven control flow (some teams find this harder to read).
- Recovery branch couples to the *exact* error shape (`statusAtual === 'aprovado'`), brittle to refactors.

### When each is right

- **Design A** is what we used because in-memory is single-threaded — no race, the only payoff of "try and react" wouldn't materialize. Also Francisco is learning, and explicit state-machine code is easier to teach from.
- **Design B** is what we'd lean toward once we have a real database where the action itself takes a lock and the race window narrows to "between connection acquisition and transaction commit." There, the exception is signal, not noise.

---

## The race window — concurrency safety is deferred

The chosen Design A has a subtle race:

```
Thread 1:               Thread 2:
findById → pendente
                        findById → pendente
aprovarPagamento (ok)
                        aprovarPagamento (FAILS — status now aprovado)
```

In a single in-memory process this **cannot happen** (no parallelism inside one `node` process for awaited code, modulo cooperative scheduling within `await` points — and even there, both readers see the same map state until a writer runs).

In **Postgres + multiple workers**, it absolutely can. The fix is one of:

1. **Optimistic concurrency** — add a `version` column to Pagamento; the `UPDATE` checks `WHERE version = $expected`; if 0 rows affected, retry the orchestrator from the top.
2. **Pessimistic locking** — `SELECT … FOR UPDATE` at the start of the orchestrator, holding the row lock until commit.
3. **Constraint-based** — make the relevant table use `INSERT … ON CONFLICT DO NOTHING` (works for Financeiro's "no two lancamento sets for the same idPagamento") and check the row count to distinguish first-write from retry.

**Recommendation when we get there:** mix #1 and #3. Pagamento gets a version column (rare contention, optimistic is enough). Financeiro's `saveLancamentos` becomes `INSERT … ON CONFLICT DO NOTHING` keyed on `(idPagamento, tipo)` — that makes duplicate inserts physically impossible regardless of orchestrator races.

**Why this is deferred:** there are no Postgres adapters for Pagamentos or Financeiro yet. Adding row locks against a non-existent table is yak-shaving. When those adapters are introduced (a future plan), this is the moment to harden.

---

## Compensation vs idempotency — different problems, different patterns

Easy to confuse. Two concepts, two patterns, two parts of the codebase:

| | Compensation (Saga) | Idempotency (Process Manager) |
|---|---|---|
| **When it applies** | Multi-step operation, one step fails mid-flow | Same operation called twice |
| **Direction** | Undo (reverse the writes that already happened) | Skip (don't redo the writes) |
| **Code pattern** | `try { stepB; stepC } catch { undo(stepA) }` | `if (alreadyDone) return existing; else doIt` |
| **Concrete example** | Phase 2: `iniciarPagamentoContribuicao` reverts the claim via `desassociarContribuinte` | Phase 4: `finalizarPagamentoAprovado` skips already-done steps |
| **Failure mode** | Partial state if compensation also fails (logged, ops investigates) | None — second call is structurally indistinguishable from first |

**The boundary in this engine:** Phase 2 (saga) lives BEFORE money moves. Phase 3 (process manager) lives AFTER money moves. After the provider returns "charged", you can't "uncharge" by compensation — you'd need a refund flow, which is a separate domain operation. That's why Phase 3 has no try/catch wrapping the writes: there's no compensation available, only retry-safety.

---

## Why we don't trust upstream not to retry

Networks fail. Queues redeliver. Users double-click. Workers crash and a supervisor restarts them mid-handler. The orchestrator must **absorb that reality** — it cannot demand the caller "be polite" about not retrying.

Concrete situations that produce a retry in this engine's projected future:
- HTTP client gets a timeout (server actually succeeded but response was lost) → client retries.
- A queue consumer processes a job, writes to the DB, then crashes before ACK → the queue redelivers.
- An operator runs the same admin command twice "to make sure it took."
- A scheduled job runs every minute checking for `pendente` pagamentos older than X seconds and finalizes them — could collide with the natural callback from the provider.

The orchestrator's job: make all of these safe.

---

## Open questions for future discussion

### 1. When do we need a real idempotency key (vs the natural one)?

`idPagamento` works as the dedup key for `finalizarPagamentoAprovado` because the operation is **about** that specific Pagamento. But what about operations whose "thing being done" isn't a single identifier?

Example: `iniciarPagamentoContribuicao` creates BOTH a contribuição-claim AND a new Pagamento. The caller-supplied `idPagamento` works — but what if the caller doesn't supply one? Then we'd want a client-supplied idempotency key.

**Open question:** do we adopt a `(idPlataforma, clientRequestId)` idempotency-key pattern for write orchestrators that mint server-side ids? Or keep "caller supplies all ids" as the convention?

### 2. How do we test concurrency once Postgres is in?

Today's "called twice" tests are sequential. Real concurrency tests need:
- Multiple processes/connections hitting the same row.
- Deterministic ordering (or property-based with many runs).
- A way to assert "exactly one winner; all others got the right idempotent response."

**Open question:** Testcontainers + multiple Kysely connection pools + `Promise.all`-driven contention? Worth its own helper library?

### 3. What about cross-aggregate idempotency?

`finalizarPagamentoAprovado` is idempotent per-pagamento. But what about a "process all pending pagamentos for today" batch job? If it runs twice, will it dedup correctly? (Yes today, because each individual call dedups. But there's an opportunity for the batch's *outer* loop to also be idempotent, e.g., recording "batch X already ran.")

**Open question:** do we adopt a batch-level idempotency log table once batch jobs exist?

### 4. Compensation's race window

The saga in Phase 2 calls `desassociarContribuinteContribuicao` on failure. What if a concurrent caller already grabbed the contribuição by the time compensation runs? Today the compensation throws `ArrecadacaoContribuicaoNaoDisponivelError` (because the contribuição is `indisponivel` from someone *else's* claim), the log records it as a compensation failure, and the original error bubbles up.

**Open question:** is "best-effort compensation with structured log" the right answer, or do we want stronger guarantees (compensation queue, scheduled retry)?

### 5. The `version` column convention

If we go optimistic (Design B above), every Pagamento, Contribuicao, etc. needs a `version: integer` column that the orchestrator reads and the UPDATE checks. Adopting this is **uniform across all aggregates** or none — partial adoption is worse than neither (because half your code does it and the other half pretends concurrency doesn't exist).

**Open question:** when we add the first Postgres-backed write that needs concurrency safety, do we retrofit `version` across all aggregates as a single migration? Or grow it incrementally?

---

## Cross-references

- `docs/ddd-conventions.md` — folder layout + entity/VO rules
- `plans/0002-checkout-orchestration-layer.md` — defines Phases 1-6 with deferred concerns explicitly listed
- `src/use-cases/checkout/finalizar-pagamento-aprovado.ts` — concrete reference implementation
- `src/use-cases/checkout/iniciar-pagamento-contribuicao.ts` — the saga example (compensation, not idempotency)
