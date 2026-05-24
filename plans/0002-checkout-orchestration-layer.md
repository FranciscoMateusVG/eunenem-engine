# Plan 0002 — Checkout / Orchestration Layer (6 phases)

**Status:** awaiting confirmation
**Decided:** 2026-05-24
**Depends on:** [0001](./0001-domain-vo-entity-split.md) (domain layout split) — ✅ done
**Scope:** Build the application/orchestration layer that the contribuinte and recebedor interact with end-to-end — Arrecadação → Taxas → Pagamentos → Financeiro → Repasse.

## Goal

Make the financial intermediation engine work end-to-end through composed use cases. Today each BC has working use cases in isolation; the orchestration that glues them — the *"Checkout (Camada de Aplicação / UX)"* box in the architecture diagram — has no code. This plan builds it across 6 small phases, each with its own DDD lesson, ending in a runnable `examples/fluxo-completo.ts` that demonstrates the canonical R$80 + R$4 → R$84 flow from campaign creation to receiver payout.

## Locked architectural decisions (carried from the earlier discussion)

1. **New folder `src/use-cases/checkout/`** is the application/orchestration layer. Not a BC. Won't have its own `domain/`, `errors/`, or `adapters/` directories — it composes the existing BCs via their ports.
2. **Phase 2 partial-failure → Saga / compensating transactions.** The orchestrator catches a downstream failure and explicitly compensates upstream via `desassociarContribuinte`. No new compensation framework — just explicit try/catch + reverse-operation.
3. **Phase 3 Pagamentos→Financeiro wiring → Process Manager pattern.** A Checkout-layer use case explicitly drives the post-aprovação flow into Financeiro. `PagamentoEventPublisher` stays in the codebase for non-load-bearing observers (audit, notifications) — but the load-bearing path is the process manager, not the event bus.
4. **Phase 1 scope = bulk only.** `obterOpcoesPrecalculadasCampanha` — single-item is a trivial derivative and not in scope.

## Cross-cutting rules (apply to every phase)

- Orchestrators depend only on **ports** (`CampanhaRepository`, `ContribuicaoRepository`, `ProvedorRegraTaxa`, `PagamentoRepository`, etc.) and **domain pure functions** — never on concrete adapter implementations.
- Cross-BC communication is by **IDs and DTOs** only. The orchestrator carries `idContribuicao` / `idCampanha` across boundaries that the BCs themselves don't share.
- Every orchestrator wraps in **exactly one span** named after the use case (`iniciarPagamentoContribuicao`, etc.). The downstream use cases keep their own spans, which nest automatically.
- Every orchestrator validates its input via Zod at the boundary. Domain types stay typed; no double-parse inside.
- Every orchestrator logs **meaningful business events** via `logger.info` (`checkout.pagamento.iniciado`, `checkout.pagamento.finalizado`, etc.).
- No new BCs. No new adapters except minor port additions where read-side queries require them.
- Tests are unit-level using memory adapters; integration tests via Testcontainers only where the test value justifies the cost.

## Cadence (per the brief)

For each phase: explain objective → name DDD concepts → list files → implement smallest piece → write tests → run `pnpm check` → explain plainly → **STOP for your confirmation** before the next phase. Max 6 phases; no scope expansion without a new plan document.

---

# Phase 1 — `obterOpcoesPrecalculadasCampanha` (read-only orchestration)

## Objective
The contribuinte lands on a campaign page. Show every option and contribution with its `ComposicaoValores` already calculated (R$80 + R$4 = R$84). Read-only; no writes, no provider, no transaction concerns.

## DDD concepts
- **Application Service** — a use case that doesn't belong to any single BC.
- **Cross-BC composition via ports + IDs only.**
- **Read-side projections** — the output is a UI-shaped DTO, not a domain entity.
- **Read-driven port additions** — adding `findByCampanhaId` to `ContribuicaoRepository` because the read-side needs it.

## Files
**NEW**
- `src/use-cases/checkout/obter-opcoes-precalculadas-campanha.ts`
- `tests/unit/checkout/obter-opcoes-precalculadas-campanha.test.ts`

**UPDATES**
- `folder-structure.mjs` — allow `checkout/` under `src/use-cases/` and `tests/unit/`
- `src/adapters/arrecadacao/contribuicao-repository.ts` — add `findByCampanhaId`
- `src/adapters/arrecadacao/contribuicao-repository.memory.ts` — implement
- `src/adapters/arrecadacao/contribuicao-repository.postgres.ts` — implement
- `tests/helpers/contribuicao-repository.conformance.ts` — add conformance test
- `src/index.ts` — export the new use case

## Use case shape
```ts
interface OpcoesPrecalculadasCampanha {
  readonly idCampanha: IdCampanha;
  readonly tituloCampanha: string;
  readonly opcoes: readonly OpcaoPrecalculada[];
}
interface OpcaoPrecalculada {
  readonly idOpcao: IdOpcaoContribuicao;
  readonly tipo: TipoOpcaoContribuicao;
  readonly contribuicoes: readonly ContribuicaoPrecalculada[];
}
interface ContribuicaoPrecalculada {
  readonly idContribuicao: IdContribuicao;
  readonly nome: string;
  readonly disponivel: boolean;
  readonly composicao: ComposicaoValores;
}
```

Algorithm: load Campanha → load all Contribuições for it → load active RegraTaxa → for each Contribuição call `calcularComposicaoValores(regra, {idContribuicao, contributionAmountCents})` → group by opção → return DTO.

## Out of scope
- Mutations.
- Pagamentos / Financeiro calls.
- Idempotency (read-only).
- New error classes (reuses `ArrecadacaoCampanhaNaoEncontradaError`).

---

# Phase 2 — `iniciarPagamentoContribuicao` + `desassociarContribuinte` (Saga)

## Objective
The contribuinte clicks "I want this item." Run the write-side checkout:
1. `associarContribuinteContribuicao` (Arrecadação) — flips status to `indisponivel`.
2. `calcularComposicaoValores` (Taxas) — get the price breakdown.
3. `criarIntencaoPagamento` (Pagamentos) — create a pending payment with the calculated total.

If step 3 fails, compensate step 1 by calling the new `desassociarContribuinte` use case. The contribuição reverts to `disponivel`. No payment record exists. No leak.

Stops at "intenção pendente created." Aprovação is Phase 3.

## DDD concepts
- **Saga / compensating transactions** — the orchestrator catches downstream failure and explicitly reverses upstream state. No saga framework, no event sourcing — just `try/catch` + explicit reverse operation.
- **Compensation operations as first-class domain ops** — `desassociarContribuinte` is added to Arrecadação as a real use case, not a private hack. It has its own invariants and its own error.
- **Orchestration boundary = compensation window** — the saga's correctness relies on the orchestrator catching failures within the same call; if a payment actually got created, we wouldn't compensate (Phase 3 hardens this).

## Files
**NEW**
- `src/use-cases/checkout/iniciar-pagamento-contribuicao.ts` — the saga orchestrator
- `src/use-cases/arrecadacao/desassociar-contribuinte-contribuicao.ts` — the compensation use case
- `src/errors/arrecadacao/contribuicao-ja-disponivel.error.ts` — invariant violation when trying to desassociar a disponivel item (idempotency guard)
- `tests/unit/checkout/iniciar-pagamento-contribuicao.test.ts`
- `tests/unit/arrecadacao/desassociar-contribuinte-contribuicao.test.ts` (extends the existing `casos-de-uso.test.ts`)

**UPDATES**
- `src/domain/arrecadacao/entities/contribuicao.ts` — add `contribuicaoSemContribuinte(c): Contribuicao` (pure domain factory: requires status='indisponivel', returns status='disponivel' with contribuinte=null)
- `src/index.ts` — export new use case + new error

## Saga shape
```ts
// iniciar-pagamento-contribuicao.ts (pseudocode)
async function iniciarPagamentoContribuicao(deps, input) {
  // step 1: claim the contribuição (Arrecadação write)
  const updated = await associarContribuinteContribuicao(deps, { idContribuicao, contribuinte });
  try {
    // step 2: calculate the values (Taxas read)
    const composicao = await calcularComposicaoValores(deps, { idContribuicao, contributionAmountCents: updated.valor });
    // step 3: create the payment intent (Pagamentos write)
    const pagamento = await criarIntencaoPagamento(deps, { idPagamento, idIntencaoPagamento, composicaoValores: composicao, valorACobrarCents: composicao.totalPaidCents, metodo });
    return { contribuicao: updated, pagamento };
  } catch (error) {
    // SAGA compensation: revert the claim
    await desassociarContribuinte(deps, { idContribuicao });
    throw error;
  }
}
```

## Out of scope
- Pagamentos→Financeiro wiring (Phase 3).
- Aprovação flow.
- The aprovação-safety check on `desassociar` (Phase 3 hardens — for Phase 2 the compensation window is before any payment can settle, so simple revert is safe).

---

# Phase 3 — `finalizarPagamentoAprovado` (Process Manager → Financeiro)

## Objective
After Pagamentos approves a pending payment (via the fake provider), Financeiro must register the financial effects (saldo credit + receita credit). Build the orchestrator that drives this transition explicitly — the Process Manager.

## DDD concepts
- **Process Manager pattern** — an orchestrator that observes the state of one aggregate and drives an operation on another. Distinct from a Saga in that it's not undoing things; it's *advancing* a workflow.
- **Why this instead of event subscribers** — `PagamentoEventPublisher` could fire an event and Financeiro could subscribe. We chose the process manager because (a) it makes the cross-BC dependency explicit and traceable, (b) it avoids inventing a quasi-event-bus we'd have to test, (c) the event publisher stays in the codebase for *non-load-bearing* observers (audit log, notifications) without being the load-bearing path. **Event-bus-as-coupling vs. process-manager-as-coupling — both are DDD-canonical, picking is the lesson.**
- **Carrying context across BCs** — Pagamentos doesn't know about `idCampanha` (per BC isolation). The process manager looks up the Contribuição to obtain it, then hands the assembled `EfeitosFinanceirosPagamentoAprovado` shape to Financeiro. The orchestrator IS the place where cross-BC identifiers come together.

## Files
**NEW**
- `src/use-cases/checkout/finalizar-pagamento-aprovado.ts` — the process manager
- `tests/unit/checkout/finalizar-pagamento-aprovado.test.ts`

**UPDATES**
- `src/index.ts` — export

## Shape
```ts
async function finalizarPagamentoAprovado(deps, { idPagamento }) {
  // step 1: approve (Pagamentos write — fake provider returns 'aprovado')
  const aprovado = await aprovarPagamento(deps, { idPagamento });

  // step 2: gather cross-BC context — lookup idCampanha via Contribuição
  const contribuicao = await deps.contribuicaoRepository.findById(aprovado.intencao.idContribuicao);
  if (!contribuicao) throw new ArrecadacaoContribuicaoNaoEncontradaError(...);

  // step 3: register Financeiro effects
  const lancamentos = await registrarEfeitosFinanceirosPagamentoAprovado(deps, {
    idPagamento: aprovado.id,
    idContribuicao: aprovado.intencao.idContribuicao,
    idCampanha: contribuicao.idCampanha,
    statusPagamento: 'aprovado',
    composicaoValores: { /* unwrap from aprovado.intencao.composicaoValores */ },
  });

  return { pagamento: aprovado, lancamentos };
}
```

## Out of scope
- Rejeitar flow (separate orchestrator if needed; not in this plan).
- Real event-bus subscription mechanism (PagamentoEventPublisher stays optional/observer-only).
- Retries / idempotency (Phase 4).

---

# Phase 4 — Idempotency contract test + orchestrator hardening

## Objective
Prove (with a test) that the process manager from Phase 3 is **idempotent**: calling `finalizarPagamentoAprovado(idPagamento)` twice produces exactly one set of Financeiro effects, not two. Harden the orchestrator if needed.

## DDD concepts
- **Idempotency as a domain invariant** — not "we'll just deduplicate at the HTTP layer." The invariant is encoded in the use case: registering effects twice for the same `idPagamento` is impossible *by construction* (Financeiro already enforces this via `FinanceiroPagamentoJaRegistradoError`).
- **Designing for retry safety** — the orchestrator catches `FinanceiroPagamentoJaRegistradoError` from the second call and treats it as "already done — fetch and return the existing lancamentos." Net effect: caller sees the same result both times, no side-effects on the second call.
- **Why we don't trust upstream not to retry** — networks fail, queues redeliver, users click twice. The orchestrator must absorb that reality.

## Files
**NEW**
- `tests/unit/checkout/finalizar-pagamento-aprovado.idempotency.test.ts`

**UPDATES (if needed)**
- `src/use-cases/checkout/finalizar-pagamento-aprovado.ts` — catch `FinanceiroPagamentoJaRegistradoError`, query existing lancamentos, return them
- Possibly add `findLancamentosByIdPagamento` is already on the port — confirm; if not, add it (it already exists per Phase 1 reading)

## Out of scope
- Concurrency safety (two parallel callers racing) — that's a Postgres-level concern (`INSERT … ON CONFLICT` or row locks). Not in this plan; flag as follow-up.
- Idempotency of Phase 2 saga (the saga is intended to be called once per checkout attempt; replay should produce `ArrecadacaoContribuicaoNaoDisponivelError` on step 1 which is the correct signal).

---

# Phase 5 — `solicitarRepasseRecebedor` orchestration (recebedor closes the loop)

## Objective
The recebedor requests a payout. The existing `solicitarRepasseRecebedor` use case in `financeiro` already does the saldo check and creates the repasse in status `solicitado`. Phase 5 adds:
1. An **integration test** that exercises the full path (lancamentos exist → saldo computed → repasse created → status='solicitado').
2. A small orchestrator `iniciarRepasseRecebedor` in `checkout/` that wraps the financeiro use case with **pre-validation**: confirm the campaign actually has an active recebedor (via Arrecadação's `RecebedorRepository`) before creating the repasse. Catches the bug where a repasse is requested for a campaign whose recebedor was deactivated.

## DDD concepts
- **Read-then-write within a single BC** (the existing financeiro use case does this).
- **Cross-BC precondition checking in the orchestrator** — Financeiro can't know whether Arrecadação's recebedor is still active; the orchestrator queries Arrecadação's `RecebedorRepository` first.
- **Why some orchestrators are thin** — when the underlying use case already does most of the work, the orchestrator's job is *just* the cross-BC sanity check.

## Files
**NEW**
- `src/use-cases/checkout/iniciar-repasse-recebedor.ts` — orchestrator with pre-validation
- `tests/unit/checkout/iniciar-repasse-recebedor.test.ts`
- `tests/integration/iniciar-repasse-recebedor.test.ts` — full path via Testcontainers

**UPDATES**
- `src/errors/checkout/...` (or reuse existing) — need an error for "no active recebedor" if not covered (probably reuse `ArrecadacaoRecebedorNaoEncontradoError`)
- `src/index.ts` — export

## Out of scope
- Actually executing the PIX/bank transfer (status stays `solicitado`).
- Multi-status state machine for `RepasseRecebedor` (only `solicitado` exists today).

---

# Phase 6 — `examples/fluxo-completo.ts` (the teaching artifact)

## Objective
A single runnable file that exercises every phase end-to-end. Reads top-to-bottom as the canonical R$80 + R$4 → R$84 story. Added to `pnpm check` so it's part of the gate forever.

## DDD concepts
- **The composition root** — this is where concrete adapters are wired together for the first time. Up until Phase 5, every use case received its deps via parameter. The example file is where `CampanhaRepositoryMemory`, `ProvedorRegraTaxaMemory`, `PagamentoProviderFake`, `LivroFinanceiroRepositoryMemory`, etc. are *constructed* and passed in. This is the practical answer to "where does dependency injection happen?"
- **Examples as living documentation** — the file is the most accurate description of how to use the engine. README references it.

## Files
**NEW**
- `examples/fluxo-completo.ts`

**UPDATES**
- `package.json` — add `tsx examples/fluxo-completo.ts` to the `check` script
- `README.md` — link the new example in the examples table

## Script outline
```ts
// 1. Wire memory adapters + ConsoleLogger + noopTracer
// 2. Register an admin user (registrarContaUsuario)
// 3. Create a campanha (criarCampanha)
// 4. Add a opção "presente" (adicionarOpcaoContribuicao)
// 5. Admin creates a contribuição "Fralda" R$80 (criarContribuicao)
// 6. Contribuinte views the option panel (obterOpcoesPrecalculadasCampanha) — print: "Fralda: R$84 total"
// 7. Contribuinte initiates payment (iniciarPagamentoContribuicao with dadosContribuinte)
// 8. Provider fakes aprovação; orchestrator finalizes (finalizarPagamentoAprovado)
// 9. Print saldoRecebedor: { pendente: 8000, disponivel: 0 } and receitaPlataforma: { totalAmountCents: 400 }
// 10. (Simulate moving lancamento from pendente→disponivel — out of scope, but demo the read)
// 11. Recebedor requests repasse (iniciarRepasseRecebedor)
// 12. Print final state: pagamento aprovado, lancamentos registered, repasse solicitado
```

## Out of scope
- A `examples/fluxo-completo.with-postgres.ts` variant (defer; the existing Postgres examples cover that pattern).
- Concurrency / retry demos.
- HTTP transport (the Hono example covers that pattern separately).

---

# What this plan does NOT address (deferred)

These are real concerns worth eventually addressing, but each is its own plan document, not Phase 0.5 / Phase 7 here:

- **Rich Value Objects for `MoneyCents` and `ComposicaoValores`** — they're still anemic. After Phase 6, when the orchestrators are real, the cost of anemic Money becomes obvious and a separate plan can promote them.
- **Cross-BC domain coupling cleanup** — Financeiro still imports `IdCampanhaSchema` from `arrecadacao/value-objects/ids.js`. The DDD-purer fix is for Financeiro to define its own `IdCampanhaReferenciaSchema` and copy the UUID at the boundary. Worth a separate decision.
- **Real event bus** — if/when notifications, audit, or other observers need to react to `PagamentoEventPublisher`, a real bus implementation belongs in its own plan.
- **Real payment provider integration** (Stripe / Mercado Pago / PagSeguro) — the brief explicitly defers this; the `PagamentoProvider` port is already in place for when it's needed.
- **Real auth** — same; `Usuario` is fake-credentials-by-design until further notice.
- **Concurrency safety** for idempotency in Phase 4 — requires Postgres-level row locks or `INSERT ... ON CONFLICT`; deferred to whenever Pagamentos/Financeiro grow Postgres adapters.

# Verification (per phase)

After each phase: `pnpm check` must be green before moving on. No exceptions, no `--no-verify`. The check now includes (post-Phase-6) `tsx examples/fluxo-completo.ts`.
