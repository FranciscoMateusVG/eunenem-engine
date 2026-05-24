# Plan 0002 — Checkout / Orchestration Layer (6 phases)

**Status:** awaiting confirmation (revised 2026-05-24 after plan 0003 landed)
**Decided:** 2026-05-24 (revised after multi-tenant introduced)
**Depends on:**
- [0001](./0001-domain-vo-entity-split-done.md) — domain layout split — ✅ done
- [0003](./0003-plataforma-multi-tenant-done.md) — Plataforma multi-tenant boundary — ✅ done (phases A/B/C/D)

**Scope:** Build the application/orchestration layer that the contribuinte and recebedor interact with end-to-end — Arrecadação → Taxas → Pagamentos → Financeiro → Repasse — **all of it scoped to a Plataforma** (eunenem / eucasei / future).

## Goal

Make the financial intermediation engine work end-to-end through composed use cases. Today each BC has working use cases in isolation; the orchestration that glues them — the *"Checkout (Camada de Aplicação / UX)"* box in the architecture diagram — has no code. This plan builds it across 6 small phases, each with its own DDD lesson, ending in a runnable `examples/fluxo-completo.ts` that demonstrates the canonical R$80 + R$4 → R$84 flow from campaign creation to receiver payout, **on a chosen plataforma**.

## Locked architectural decisions

1. **New folder `src/use-cases/checkout/`** is the application/orchestration layer. Not a BC. Won't have its own `domain/`, `errors/`, or `adapters/` directories — it composes the existing BCs via their ports.
2. **Phase 2 partial-failure → Saga / compensating transactions.** The orchestrator catches a downstream failure and explicitly compensates upstream via `desassociarContribuinte`. No new compensation framework — just explicit try/catch + reverse-operation.
3. **Phase 3 Pagamentos→Financeiro wiring → Process Manager pattern.** A Checkout-layer use case explicitly drives the post-aprovação flow into Financeiro. `PagamentoEventPublisher` stays in the codebase for non-load-bearing observers (audit, notifications) — but the load-bearing path is the process manager, not the event bus.
4. **Phase 1 scope = bulk only.** `obterOpcoesPrecalculadasCampanha` — single-item is a trivial derivative and not in scope.
5. **🆕 Plataforma is plumbed through every Checkout orchestrator.** Every checkout orchestrator takes `idPlataforma` as input, validates that referenced aggregates (Campanha, Usuário, RegraTaxa) belong to that plataforma, stamps it onto downstream writes via cross-BC mirror VOs, and includes it as a span attribute for traceability. **Tenancy is first-class, not implicit.**

## Cross-cutting rules (apply to every phase)

- Orchestrators depend only on **ports** (`CampanhaRepository`, `ContribuicaoRepository`, `ProvedorRegraTaxa`, `PagamentoRepository`, `PlataformaRepository`, etc.) and **domain pure functions** — never on concrete adapter implementations.
- Cross-BC communication is by **IDs and DTOs** only. The orchestrator carries `idPlataforma`, `idContribuicao`, `idCampanha`, etc. across boundaries that the BCs themselves don't share.
- **🆕 Every orchestrator validates plataforma membership at the read boundary.** When an orchestrator loads a `Campanha`, it asserts `campanha.idPlataforma === input.idPlataforma`. Mismatches throw a typed error — they're the cross-tenant access attempt that must never silently succeed.
- Every orchestrator wraps in **exactly one span** named after the use case (`iniciarPagamentoContribuicao`, etc.). The span attributes always include `checkout.plataforma.id`. The downstream use cases keep their own spans, which nest automatically.
- Every orchestrator validates its input via Zod at the boundary. Domain types stay typed; no double-parse inside.
- Every orchestrator logs **meaningful business events** via `logger.info` (`checkout.pagamento.iniciado`, `checkout.pagamento.finalizado`, etc.) and always includes `idPlataforma` in the log payload.
- No new BCs. No new adapters except minor port additions where read-side queries require them.
- Tests are unit-level using memory adapters; integration tests via Testcontainers only where the test value justifies the cost.

## Cadence (per the brief)

For each phase: explain objective → name DDD concepts → list files → implement smallest piece → write tests → run `pnpm check` → explain plainly → **STOP for your confirmation** before the next phase. Max 6 phases; no scope expansion without a new plan document.

---

# Phase 1 — `obterOpcoesPrecalculadasCampanha` (read-only orchestration)

## Objective
The contribuinte lands on a campaign page **on a specific plataforma**. Show every option and contribution with its `ComposicaoValores` already calculated using that plataforma's pricing rule. Read-only; no writes, no provider, no transaction concerns.

eunenem campaign: R$80 contribuição → R$84 total (5% on contribuinte for all tipos).
eucasei campaign: R$80 presente → R$84.80 total (6%). R$80 rifa → R$86.40 total (8%).

## DDD concepts
- **Application Service** — a use case that doesn't belong to any single BC.
- **Cross-BC composition via ports + IDs only.**
- **Read-side projections** — the output is a UI-shaped DTO, not a domain entity.
- **Read-driven port additions** — adding `findByCampanhaId` to `ContribuicaoRepository` because the read-side needs it.
- **🆕 Plataforma-scoped pricing** — the use case calls `provedorRegraTaxa.getRegraAtiva(idPlataforma)` (plan 0003 Phase B signature), then resolves the per-tipo `TarifaTipo` for each Contribuição based on its opção's tipo, and calls `calcularComposicaoValores(tarifa, ...)`. Different plataformas, different prices — the orchestrator is where that materializes.
- **🆕 Tenant-membership assertion at the read boundary** — load Campanha, assert `campanha.idPlataforma === input.idPlataforma`, throw `CheckoutPlataformaMismatchError` if not.

## Files
**NEW**
- `src/use-cases/checkout/obter-opcoes-precalculadas-campanha.ts`
- `src/errors/checkout/plataforma-mismatch.error.ts` — new typed error for tenant-membership violation
- `tests/unit/checkout/obter-opcoes-precalculadas-campanha.test.ts`

**UPDATES**
- `folder-structure.mjs` — allow `checkout/` under `src/use-cases/`, `tests/unit/`, and `src/errors/`
- `src/adapters/arrecadacao/contribuicao-repository.ts` — add `findByCampanhaId`
- `src/adapters/arrecadacao/contribuicao-repository.memory.ts` — implement
- `src/adapters/arrecadacao/contribuicao-repository.postgres.ts` — implement
- `tests/helpers/contribuicao-repository.conformance.ts` — add conformance test
- `src/index.ts` — export the new use case + new error

## Use case shape
```ts
interface ObterOpcoesPrecalculadasCampanhaInput {
  readonly idPlataforma: IdPlataformaReferencia;  // mirror VO in checkout (or borrow arrecadacao's)
  readonly idCampanha: IdCampanha;
}

interface OpcoesPrecalculadasCampanha {
  readonly idPlataforma: IdPlataformaReferencia;
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

**Algorithm (revised for multi-tenant):**
1. Load Campanha by id; if missing throw `ArrecadacaoCampanhaNaoEncontradaError`.
2. Assert `campanha.idPlataforma === input.idPlataforma`; if not throw `CheckoutPlataformaMismatchError`.
3. Load all Contribuições for that campanha (`findByCampanhaId`).
4. Load RegraTaxa for the plataforma (`provedorRegraTaxa.getRegraAtiva(idPlataforma)`).
5. For each Contribuição: resolve the opção's tipo, then `tarifa = obterTarifaPorTipo(regra, tipo)`, then `calcularComposicaoValores(tarifa, { idContribuicao, contributionAmountCents })`.
6. Group by opção → return DTO.

## Out of scope
- Mutations.
- Pagamentos / Financeiro calls.
- Idempotency (read-only).
- Authorization checks ("does the requesting user belong to this plataforma?") — that's a separate authorization plan.

---

# Phase 2 — `iniciarPagamentoContribuicao` + `desassociarContribuinte` (Saga)

## Objective
The contribuinte clicks "I want this item" on a plataforma. Run the write-side checkout:
1. Validate plataforma membership (Campanha must belong to `input.idPlataforma`).
2. `associarContribuinteContribuicao` (Arrecadação) — flips status to `indisponivel`.
3. `calcularComposicaoValores` (Taxas) — get the price breakdown **for this plataforma's tarifa for this opção's tipo**.
4. `criarIntencaoPagamento` (Pagamentos) — create a pending payment with the calculated total.

If step 3 or 4 fails, compensate step 2 by calling the new `desassociarContribuinte` use case. The contribuição reverts to `disponivel`. No payment record exists. No leak.

Stops at "intenção pendente created." Aprovação is Phase 3.

## DDD concepts
- **Saga / compensating transactions** — the orchestrator catches downstream failure and explicitly reverses upstream state. No saga framework, no event sourcing — just `try/catch` + explicit reverse operation.
- **Compensation operations as first-class domain ops** — `desassociarContribuinte` is added to Arrecadação as a real use case, not a private hack. It has its own invariants and its own error.
- **Orchestration boundary = compensation window** — the saga's correctness relies on the orchestrator catching failures within the same call.
- **🆕 Cross-tenant attack surface lives at the saga entry** — the plataforma-membership check happens *before* the first state change. Any cross-tenant attempt is rejected with no side effects.

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

## Saga shape (revised for multi-tenant)
```ts
// iniciar-pagamento-contribuicao.ts (pseudocode)
async function iniciarPagamentoContribuicao(deps, input) {
  // step 0: assert plataforma membership (read-side check, no side effect)
  const campanha = await deps.campanhaRepository.findById(input.idCampanha);
  if (!campanha) throw new ArrecadacaoCampanhaNaoEncontradaError(input.idCampanha);
  if (campanha.idPlataforma !== input.idPlataforma) {
    throw new CheckoutPlataformaMismatchError(input.idPlataforma, campanha.idPlataforma);
  }

  // step 1: claim the contribuição (Arrecadação write)
  const updated = await associarContribuinteContribuicao(deps, { idContribuicao, contribuinte });
  try {
    // step 2: calculate values (Taxas read, plataforma-scoped)
    const opcao = encontrarOpcaoContribuicao(campanha, updated.idOpcaoContribuicao);
    if (!opcao) throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(...);
    const composicao = await calcularComposicaoValores(deps, {
      idPlataforma: input.idPlataforma,
      idContribuicao: updated.id,
      tipo: opcao.tipo,
      contributionAmountCents: updated.valor,
    });
    // step 3: create the payment intent (Pagamentos write)
    const pagamento = await criarIntencaoPagamento(deps, {
      idPagamento,
      idIntencaoPagamento,
      composicaoValores: composicao,
      valorACobrarCents: composicao.totalPaidCents,
      metodo,
    });
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
- The aprovação-safety check on `desassociar` (Phase 3 hardens — for Phase 2 the compensation window is before any payment can settle).
- Plataforma-scoping inside Pagamentos itself — Pagamentos doesn't yet know about plataforma; the orchestrator carries it. Future plan can scope Pagamentos if needed.

---

# Phase 3 — `finalizarPagamentoAprovado` (Process Manager → Financeiro)

## Objective
After Pagamentos approves a pending payment (via the fake provider), Financeiro must register the financial effects (saldo credit + receita credit). Build the orchestrator that drives this transition explicitly — the Process Manager — **carrying plataforma context through the chain for traceability**.

## DDD concepts
- **Process Manager pattern** — an orchestrator that observes the state of one aggregate and drives an operation on another. Distinct from a Saga in that it's not undoing things; it's *advancing* a workflow.
- **Why this instead of event subscribers** — `PagamentoEventPublisher` could fire an event and Financeiro could subscribe. We chose the process manager because (a) it makes the cross-BC dependency explicit and traceable, (b) it avoids inventing a quasi-event-bus we'd have to test, (c) the event publisher stays in the codebase for *non-load-bearing* observers (audit log, notifications) without being the load-bearing path. **Event-bus-as-coupling vs. process-manager-as-coupling — both are DDD-canonical, picking is the lesson.**
- **Carrying context across BCs** — Pagamentos doesn't know about `idCampanha` or `idPlataforma` (BC isolation). The process manager looks up the Contribuição → Campanha to obtain both, then hands the assembled `EfeitosFinanceirosPagamentoAprovado` shape to Financeiro and logs `idPlataforma` for observability. **The orchestrator IS the place where cross-BC identifiers come together.**

## Files
**NEW**
- `src/use-cases/checkout/finalizar-pagamento-aprovado.ts` — the process manager
- `tests/unit/checkout/finalizar-pagamento-aprovado.test.ts`

**UPDATES**
- `src/index.ts` — export

## Shape (revised for multi-tenant)
```ts
async function finalizarPagamentoAprovado(deps, { idPagamento }) {
  // step 1: approve (Pagamentos write — fake provider returns 'aprovado')
  const aprovado = await aprovarPagamento(deps, { idPagamento });

  // step 2: gather cross-BC context — Contribuição → Campanha → idPlataforma
  const contribuicao = await deps.contribuicaoRepository.findById(aprovado.intencao.idContribuicao);
  if (!contribuicao) throw new ArrecadacaoContribuicaoNaoEncontradaError(...);

  const campanha = await deps.campanhaRepository.findById(contribuicao.idCampanha);
  if (!campanha) throw new ArrecadacaoCampanhaNaoEncontradaError(...);

  // tag span + log with plataforma for traceability
  span.setAttribute('checkout.plataforma.id', campanha.idPlataforma);

  // step 3: register Financeiro effects
  const lancamentos = await registrarEfeitosFinanceirosPagamentoAprovado(deps, {
    idPagamento: aprovado.id,
    idContribuicao: aprovado.intencao.idContribuicao,
    idCampanha: contribuicao.idCampanha,
    statusPagamento: 'aprovado',
    composicaoValores: { /* unwrap from aprovado.intencao.composicaoValores */ },
  });

  logger.info('checkout.pagamento.finalizado', {
    idPagamento, idContribuicao: contribuicao.id, idCampanha: campanha.id,
    idPlataforma: campanha.idPlataforma,
  });

  return { pagamento: aprovado, lancamentos };
}
```

**Note:** `Financeiro` is NOT yet plataforma-scoped (plan 0003 only scoped Taxas/Arrecadação/Usuário). The process manager carries `idPlataforma` for logs/spans only. When Financeiro is scoped to plataforma (a future plan), `EfeitosFinanceirosPagamentoAprovado` will gain `idPlataforma` and the process manager will pass it through.

## Out of scope
- Rejeitar flow (separate orchestrator if needed; not in this plan).
- Real event-bus subscription mechanism (PagamentoEventPublisher stays optional/observer-only).
- Retries / idempotency (Phase 4).
- Plataforma-scoping inside Financeiro (deferred to a future plan).

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
The recebedor requests a payout **on a specific plataforma**. The existing `solicitarRepasseRecebedor` use case in `financeiro` already does the saldo check and creates the repasse in status `solicitado`. Phase 5 adds:
1. An **integration test** that exercises the full path (lancamentos exist → saldo computed → repasse created → status='solicitado').
2. A small orchestrator `iniciarRepasseRecebedor` in `checkout/` that wraps the financeiro use case with **two pre-validations**:
   - The campaign actually has an active recebedor (via Arrecadação's `RecebedorRepository`) — catches the "deactivated recebedor" bug.
   - **🆕 The campaign belongs to `input.idPlataforma`** — catches cross-tenant payout attempts.

## DDD concepts
- **Read-then-write within a single BC** (the existing financeiro use case does this).
- **Cross-BC precondition checking in the orchestrator** — Financeiro can't know whether Arrecadação's recebedor is still active; the orchestrator queries Arrecadação's `RecebedorRepository` first.
- **🆕 Tenant-membership as a precondition** — same pattern as Phase 1/2: load Campanha, assert plataforma.
- **Why some orchestrators are thin** — when the underlying use case already does most of the work, the orchestrator's job is *just* the cross-BC sanity check.

## Files
**NEW**
- `src/use-cases/checkout/iniciar-repasse-recebedor.ts` — orchestrator with pre-validations
- `tests/unit/checkout/iniciar-repasse-recebedor.test.ts`
- `tests/integration/iniciar-repasse-recebedor.test.ts` — full path via Testcontainers

**UPDATES**
- `src/errors/checkout/...` (or reuse existing) — `CheckoutPlataformaMismatchError` already exists from Phase 1; reuse for plataforma checks.  Reuse `ArrecadacaoRecebedorNaoEncontradoError` for the missing-recebedor case.
- `src/index.ts` — export

## Out of scope
- Actually executing the PIX/bank transfer (status stays `solicitado`).
- Multi-status state machine for `RepasseRecebedor` (only `solicitado` exists today).

---

# Phase 6 — `examples/fluxo-completo.ts` (the teaching artifact)

## Objective
A single runnable file that exercises every phase end-to-end **across two plataformas** to make the multi-tenant story visible. Reads top-to-bottom as the canonical R$80 + R$4 → R$84 story on eunenem, plus a parallel R$80 + R$4.80 → R$84.80 on eucasei to demonstrate distinct pricing. Added to `pnpm check` so it's part of the gate forever.

## DDD concepts
- **The composition root** — this is where concrete adapters are wired together for the first time. Up until Phase 5, every use case received its deps via parameter. The example file is where `PlataformaRepositoryMemory`, `CampanhaRepositoryMemory`, `ProvedorRegraTaxaMemory`, `PagamentoProviderFake`, `LivroFinanceiroRepositoryMemory`, etc. are *constructed* and passed in. This is the practical answer to "where does dependency injection happen?"
- **🆕 Tenancy as a first-class story** — running the same flow on eunenem and eucasei with distinct outputs (different fees) makes the multi-tenant invariant *visible*. The example is the proof that the model holds.
- **Examples as living documentation** — the file is the most accurate description of how to use the engine. README references it.

## Files
**NEW**
- `examples/fluxo-completo.ts`

**UPDATES**
- `package.json` — add `tsx examples/fluxo-completo.ts` to the `check` script
- `README.md` — link the new example in the examples table

## Script outline (revised for multi-tenant)
```ts
// 1. Wire memory adapters + ConsoleLogger + noopTracer
//    — including PlataformaRepositoryMemory (seeded with eunenem + eucasei)
//    — including ProvedorRegraTaxaMemory (seeded with both plataformas' pricing)
// 2. Pick plataforma = ID_PLATAFORMA_EUNENEM
// 3. Register an admin user scoped to eunenem (registrarContaUsuario with idPlataforma)
// 4. Create a campanha on eunenem (criarCampanha with idPlataforma)
// 5. Add a opção "presente" (adicionarOpcaoContribuicao)
// 6. Admin creates a contribuição "Fralda" R$80 (criarContribuicao)
// 7. Contribuinte views the option panel (obterOpcoesPrecalculadasCampanha with idPlataforma)
//    Print: "Eunenem | Fralda: R$84 total (R$80 + R$4 fee, 5%)"
// 8. Contribuinte initiates payment (iniciarPagamentoContribuicao with idPlataforma + dadosContribuinte)
// 9. Provider fakes aprovação; orchestrator finalizes (finalizarPagamentoAprovado)
// 10. Print saldoRecebedor: { pendente: 8000, disponivel: 0 } and receitaPlataforma: { totalAmountCents: 400 }
// 11. Recebedor requests repasse (iniciarRepasseRecebedor with idPlataforma)
// 12. Print final state on eunenem: pagamento aprovado, lancamentos registered, repasse solicitado

// 13. 🆕 REPEAT a slim version of steps 3-9 on ID_PLATAFORMA_EUCASEI
//     — same R$80 contribuição amount, same flow
//     — different fee output: R$4.80 instead of R$4
//     — print both side-by-side at the end to show the multi-tenant story
```

## Out of scope
- A `examples/fluxo-completo.with-postgres.ts` variant (defer; the existing Postgres examples cover that pattern).
- Concurrency / retry demos.
- HTTP transport (the Hono example covers that pattern separately).
- A cross-tenant negative-path example (would be a great teaching artifact for a future plan — "watch the orchestrator reject an eucasei contribuição on an eunenem checkout").

---

# What this plan does NOT address (deferred)

These are real concerns worth eventually addressing, but each is its own plan document, not Phase 0.5 / Phase 7 here:

- **Rich Value Objects for `MoneyCents` and `ComposicaoValores`** — they're still anemic. After Phase 6, when the orchestrators are real, the cost of anemic Money becomes obvious and a separate plan can promote them.
- **Cross-BC domain coupling cleanup** — Financeiro still imports `IdCampanhaSchema` from `arrecadacao/value-objects/ids.js`. The DDD-purer fix is for Financeiro to define its own `IdCampanhaReferenciaSchema` and copy the UUID at the boundary. Worth a separate decision.
- **🆕 Financeiro scoped to Plataforma** — `LancamentoFinanceiro` and `RepasseRecebedor` carry `idCampanha` (which carries `idPlataforma` transitively) but don't store `idPlataforma` directly. When Financeiro queries grow plataforma-scoped (e.g. "receita da plataforma X no mês Y"), a future plan adds `idPlataforma` as a first-class field and unique-index discipline catches up.
- **🆕 Authorization (who can act on what)** — "a user from eunenem cannot create a checkout on an eucasei campanha." Today the orchestrators validate the *Campanha's* plataforma, but they don't validate the *acting user's* plataforma matches. That's a separate authorization plan: takes a `Sessao` (which now carries `idPlataforma` post-plan-0003-Phase-D) and asserts session.idPlataforma === campanha.idPlataforma.
- **Real event bus** — if/when notifications, audit, or other observers need to react to `PagamentoEventPublisher`, a real bus implementation belongs in its own plan.
- **Real payment provider integration** (Stripe / Mercado Pago / PagSeguro) — the brief explicitly defers this; the `PagamentoProvider` port is already in place for when it's needed.
- **Real auth** — same; `Usuario` is fake-credentials-by-design until further notice.
- **Concurrency safety** for idempotency in Phase 4 — requires Postgres-level row locks or `INSERT ... ON CONFLICT`; deferred to whenever Pagamentos/Financeiro grow Postgres adapters.

# Verification (per phase)

After each phase: `pnpm check` must be green before moving on. No exceptions, no `--no-verify`. The check now includes (post-Phase-6) `tsx examples/fluxo-completo.ts`.
