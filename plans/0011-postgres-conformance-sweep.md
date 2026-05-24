# Plan 0011 — Postgres conformance sweep

> **Status**: drafted 2026-05-24, awaiting confirmation.
> **Depends on**: nothing — this is hygiene/parity work. Best run after plans 0005–0010 land any new adapters they introduce.

## Goal

The codebase enforces a hexagonal pattern: every adapter has both a memory and a Postgres implementation, with a shared conformance test suite asserting parity. Plan 0003 left the Plataforma BC memory-only; plans 0004/0005/0007/0010 introduce new adapters that may also start memory-only and need Postgres parity later.

This plan is a one-pass audit + cleanup that ensures **every port has both implementations + conformance** with identical span emissions, identical error contracts, and identical edge-case handling.

## Locked decisions

1. **Audit first, fix second.** Don't start writing adapters before listing every port and its current state. The audit produces a checklist; phases work the checklist top to bottom.

2. **One BC at a time.** Don't touch all BCs in a single PR. One BC per phase keeps reviews small and rollback surgical.

3. **Conformance test suite is the spec, not the implementations.** When memory and Postgres disagree, the conformance test wins — both must produce the same outcome for the same input. The discussion at that point is "which behavior is right," not "which adapter has the bug."

4. **Spans are part of the conformance contract.** Every adapter method must emit the same span name, same operation attribute, same db.collection. Already true for most; the audit verifies.

5. **No new features in this plan.** If during the sweep we notice a missing capability (e.g. "Pagamento repo could use `findByDateRange`"), that's a separate task — file it, don't slip it in.

## DDD concepts this plan teaches

### Conformance suites as the *real* port specification

A TypeScript interface specifies *types*. It can't specify "save followed by findById returns the same entity" or "save emits a span called X." The conformance suite specifies *behavior*. That's the actual port contract. New adapter? Run the suite. Pass = it's a valid implementation. This is why hexagonal architecture is more than file-layout pedantry: the test suite *is* the architecture.

### Adapter parity as a hedge against premature commitment

We can't predict whether we'll keep Postgres forever. Maybe one day we want Mongo for Pagamento history, or SQLite for embedded deploys. Conformance suites mean swapping adapters is a coding task, not a redesign. The memory adapter pays the parity cost on every change but provides the freedom.

### Hygiene as a load-bearing investment

Parity drifts unless actively maintained. A small drift today is a 2-day archeology dig in 6 months. Sweeps like this are cheap when done regularly, expensive when deferred.

## Phases

### Phase 1 — Audit + checklist

**Objective**: Produce `plans/0011-checklist.md` (or extend this file) with every adapter listed, current state per implementation, gaps highlighted.

**Steps**:
1. List every `*.ts` file under `src/adapters/<bc>/` excluding `.memory.ts` / `.postgres.ts` (those are implementations; the bare name is the port).
2. For each port, confirm: memory exists? postgres exists? conformance suite exists? conformance covers all port methods? span assertions exist?
3. Build a table; identify gaps.

**Expected gaps after current state**:
- `PlataformaRepository` — Postgres adapter missing (plan 0003 deferred; plan 0009 Phase 1 may have already added it — verify).
- Any new adapter from plans 0004/0005/0007/0010 that didn't land Postgres in its own plan.

**Files NEW**:
```
plans/0011-checklist.md
```

**Verification**: checklist committed; subsequent phases reference it.

**STOP for confirmation.**

---

### Phase 2..N — Fill each gap

**Objective**: One BC per phase. Fill its missing implementations + conformance assertions.

**Repeatable template per gap**:
1. Add Postgres implementation (if missing).
2. Add to conformance suite (if missing port methods).
3. Add span assertions (if missing).
4. Run conformance against both impls — must pass identically.
5. Update db-types.generated.ts if any new tables.
6. `pnpm check` green.

**Out of scope per phase**: refactoring port shape, adding new methods. If the audit found a problem, file it separately.

**STOP for confirmation after each BC.**

---

### Phase Last — Lock the invariant

**Objective**: Add a script (or extend existing depcruise rules) that fails CI if a port exists without both implementations.

**Files NEW**:
```
scripts/check-adapter-parity.ts          # globs src/adapters/<bc>/*.ts, asserts every port has .memory.ts + .postgres.ts
```

**Files MODIFIED**: `package.json` — add to `check` script.

**Verification**: deleting a Postgres adapter fails `pnpm check`; restoring it passes.

**STOP for confirmation.**

---

## Open questions

1. **Should the conformance suite assert OTel SDK behavior?** Today it asserts span names + attributes via the test SDK. Worth asserting tracer hierarchy (child spans nest under parent)? Probably yes, but might be a separate plan if it gets large.

2. **In-memory persistence test mode.** Some tests want "persistent across restarts" semantics that the memory adapter doesn't give. SQLite-in-memory could fill the gap. Out of scope here; flag if it comes up.

3. **Mocking vs faking.** Some adapters (PagamentoProvider, WebhookSignatureVerifier) have "fake" implementations rather than memory/postgres pairs. Those are out of scope here — different category (external systems, not data persistence). Document the distinction in the audit.

4. **Migration parity.** Memory adapter ignores migrations; Postgres requires them. The conformance suite runs against migrated Postgres. Implicit. Worth documenting.

5. **Performance characteristics.** Conformance suites assert correctness, not latency. If we ever care about per-adapter perf SLAs, separate benchmark suite. Not here.

## Done definition

- Audit checklist committed.
- Every port has memory + postgres adapters, both passing conformance.
- Span assertions cover every adapter method.
- CI fails if a port loses an implementation.
