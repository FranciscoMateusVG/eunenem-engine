# Plan 0008 — Concurrency safety on Contribuição claim

> ⚠️ **SUPERSEDED-BY** plan 0015 — 2026-06-03. Canonical phase: [0015 §Phase 2 (Use-case rewrites — saga loses the claim step)](./0015-contribuicao-pagamento-financeiro-collapse.md#phase-2--use-case-rewrites). Rationale: [0015 §Locked decisions #2 + #5 + #6 (Contribuição shape, indisponivel predicate, accept-double-pay)](./0015-contribuicao-pagamento-financeiro-collapse.md#locked-decisions) + [0015 §DDD concept #3 (Optimistic vs pessimistic reservation)](./0015-contribuicao-pagamento-financeiro-collapse.md#ddd-concepts-this-plan-teaches).
>
> There is no contribuição-claim step anymore. The `iniciarPagamentoContribuicao` saga from 0002 used to set the slot's status to `indisponivel` at session-create (pessimistic claim). 0015 removes `status` from Contribuição entirely — it becomes a pure slot definition with no transitions and no visitor-side writes. The "indisponivel" predicate is now a query: `EXISTS pagamento WHERE idContribuicao = X AND status='aprovado'`. With no shared status to race on, the optimistic-CC-via-`versao` pattern this plan proposed has nothing to protect.
>
> Concurrency on multi-write paths still matters — but it moves under the Pagamentos aggregate's own consistency boundary (the Pagamento FSM is event-driven and earns its lock semantics) rather than living as a cross-BC contribuição invariant. The double-pay scenario this plan was partly motivated by is now an **accepted edge case** (recebedor gets +money, no inventory to oversell).
>
> This file is preserved as historical context: the optimistic-vs-pessimistic-CC discussion and the "check-then-act is a smell" lesson remain useful general background, even though the specific Contribuição.versao implementation is no longer needed.
>
> ---
>
> **Status (historical)**: drafted 2026-05-24, never implemented.
> **Depended on**: plan `0002-checkout-orchestration-layer-done.md` (which defined `iniciarPagamentoContribuicao` and the claim step that 0015 removed). Would have synergized with `0005-durable-event-log-and-worker-queue.md` (DB transactions matter more once there's a worker).
> **Companion doc (historical)**: `docs/idempotency-and-concurrency.md` — question 1 (concurrency safety on claim, originally deferred from 0004; now retired by 0015).

## Goal

Today's `iniciarPagamentoContribuicao` saga does:

```
1. Read Contribuicao
2. Check status === 'disponivel'
3. Set status = 'indisponivel'
4. Save
```

That's a classic check-then-act race. Two contribuintes hitting "Comprar" within milliseconds both pass step 2, both write step 3, both think they bought the same item. In memory this is benign (single Node thread, no real concurrency). In Postgres with multiple connections (and especially after plan 0005's worker), the race is real.

This plan adds **optimistic concurrency control via a version column on Contribuicao** so that a second writer detects the conflict and fails cleanly. The user then sees "alguém comprou esse item primeiro, tente outro."

## Locked decisions

1. **Optimistic, not pessimistic.** `SELECT FOR UPDATE` works but holds row-level locks for the duration of the saga, which is bad once the saga calls external services (Pagamento provider). Optimistic = read with version, update with `WHERE version = expected` — second writer's UPDATE matches 0 rows and we raise. No long-held locks.

2. **Version column lives on the aggregate root.** `Contribuicao.versao: number`, starts at 1, increments on every save. Other aggregate roots (Pagamento, Lancamento, Repasse) get the same treatment in a future sweep if they show race symptoms; for now Contribuição is the hot path.

3. **Conflict surfaces as a typed error.** `ArrecadacaoContribuicaoConflitoConcorrenciaError` with `code = 'ARRECADACAO_CONTRIBUICAO_CONFLITO_CONCORRENCIA'`. Checkout layer catches it and returns a user-friendly "outro contribuinte foi mais rápido — atualize a página." HTTP 409.

4. **Retry policy: no automatic retry in 0008.** Surfacing the conflict to the user is the right behavior — the available items list has changed; they should re-decide. A future "smart retry on identical-collapsed-item" (pick a different slot of the same Fralda) is a UI concern, not a domain concern.

5. **Memory adapter mirrors the same semantics.** It doesn't have real concurrency, but the conformance test injects a "concurrent write" by mutating the underlying map between read and write inside a single test. Both adapters fail identically.

## DDD concepts this plan teaches

### Optimistic concurrency control as a domain invariant

The invariant "only one contribuinte can claim this Contribuição" is *domain truth*. Enforcing it at the DB layer with `WHERE version = X` is the implementation; the invariant itself belongs in the aggregate. Naming it (`Contribuicao.versao`, `ContribuicaoConflitoConcorrenciaError`) makes the invariant visible — anyone reading the code knows the rule exists.

### Aggregate root as the unit of concurrency

The version column lives on the *aggregate root*, not on individual fields or nested entities. Two updates that touch different fields of the same aggregate still conflict — by design, because they read from a consistent snapshot. This is the canonical DDD answer: the aggregate is the consistency boundary, and the version is its fingerprint.

### Check-then-act is a smell

Anywhere code reads state, decides based on it, then writes — without atomic protection — is a race waiting to happen. Sometimes the race is benign (single-writer system), sometimes catastrophic (double-spend). Optimistic CC makes the check-and-act atomic. The lesson: spot the pattern, name the risk, decide explicitly whether to protect it.

### Why not just transactions?

A SERIALIZABLE transaction would also fix this. Two reasons we choose optimistic CC instead:
- Postgres SERIALIZABLE has performance/conflict overhead at scale.
- Transactions don't help once the work crosses process boundaries (e.g. saga calls provider mid-flight).
- Version columns are explicit in the domain model; transaction isolation is implicit infrastructure. Explicit wins for understanding.

## Phases

### Phase 1 — Add `versao` to Contribuição domain + persistence

**Objective**: Contribuição gains `versao: number`. Save operations increment it. Reads return it. No conflict detection yet — purely additive.

**Files NEW**:
```
migrations/
└── 20260901_001_add_versao_to_contribuicoes.ts
```

**Files MODIFIED**:
- `src/domain/arrecadacao/entities/contribuicao.ts` — add `versao: number`; helper `proximaVersao(c)` returns `{ ...c, versao: c.versao + 1 }`; new Contribuição starts at versao=1.
- `src/adapters/arrecadacao/contribuicao-repository.{memory,postgres}.ts` — persist + return versao; save bumps it.
- `tests/helpers/contribuicao-repository.conformance.ts` — assert versao starts at 1 and increments.

**Verification**: `pnpm check` green; existing tests still pass; new contributions have versao=1.

**STOP for confirmation.**

---

### Phase 2 — Optimistic CC at save + conflict error

**Objective**: `save` becomes "save if versao matches expected; else raise conflict." Use cases pass through the expected versao.

**Files NEW**:
```
src/errors/arrecadacao/
└── contribuicao-conflito-concorrencia.error.ts
```

**Files MODIFIED**:
- `src/adapters/arrecadacao/contribuicao-repository.ts` — `save(c)` semantics: `UPDATE ... WHERE id = c.id AND versao = c.versao - 1` (since save increments). If 0 rows affected and row exists, raise `ContribuicaoConflitoConcorrenciaError`. If row doesn't exist (insert path), normal insert.
- Memory adapter — same semantics: read current versao, compare to `c.versao - 1`, raise if mismatch.
- `src/use-cases/arrecadacao/criar-contribuicao.ts` — already only INSERTs (versao=1), no change needed.
- `src/use-cases/checkout/iniciar-pagamento-contribuicao.ts` (the claim) — reads contribuicao (gets versao=N), modifies (versao=N+1), saves. On `ContribuicaoConflitoConcorrenciaError`, catch and rethrow as checkout-level error or let it bubble.

**Verification**:
- Conformance test: load contribuição, save twice with same input → second raises conflict.
- Concurrent claim test: simulate two parallel `iniciarPagamentoContribuicao` calls on same contribuição; assert exactly one succeeds, the other raises conflict.

**STOP for confirmation.**

---

### Phase 3 — Surface conflict in HTTP/demo

**Objective**: Web demo shows a clean error page when claim conflicts. HTTP 409.

**Files MODIFIED**:
- `examples/fluxo-completo.web.ts` — checkout POST catches `ContribuicaoConflitoConcorrenciaError`, returns 409 with "outro contribuinte foi mais rápido, esse item já foi reservado. Volte à loja e escolha outro."

**Out of scope**: smart retry across identical-collapsed-item slots (UI feature, separate plan).

**Verification**: manual test in browser using `pnpm tsx examples/fluxo-completo.web.ts` and two browser windows clicking simultaneously (eyeball test); plus a unit test for the catch path.

**STOP for confirmation.**

---

## Open questions

1. **Apply versao to other aggregates?** Pagamento, Lancamento, Repasse all have state transitions that could race. Pagamento is the next most likely (status transitions during webhook + reconciliação). Plan a sweep after 0008 lands and we see real conflict rates.

2. **How to test concurrent claims deterministically?** Postgres test can use two connections + intentional delay; memory test can mutate the underlying map mid-call. Both feel hacky. Worth investing in a small "race harness" test helper?

3. **User-facing copy.** "outro contribuinte foi mais rápido" is friendly but might confuse — they didn't even submit yet. Maybe "esse item acabou de ser reservado por outra pessoa" is clearer. UX call.

4. **Audit / metrics for conflicts.** Worth tracking conflict rate per Contribuição? If a single popular fralda has 50 conflicts/day, the collapse-UI's "Comprar 1" should probably pre-claim or batch differently.

5. **Should Pagamento.intencao.idIntencaoPagamento be enough to prevent double-claim?** Plan 0002's Phase 4 idempotency hardening already deduplicates by `idIntencaoPagamento` — so a single user clicking "Pagar" twice is idempotent. But *two different users* generate different idIntencaoPagamento and that's where versao saves us. Worth being explicit: idempotency key protects against retry; versao protects against concurrency. Different problems.

## Done definition

- All 3 phases land; `pnpm check` green.
- Two concurrent claim attempts deterministically produce exactly one success + one conflict.
- Demo handles 409 gracefully.
- `docs/idempotency-and-concurrency.md` question 1 marked answered, linked to this plan.
