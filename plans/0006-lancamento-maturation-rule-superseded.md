# Plan 0006 — Lancamento maturation rule

> ⚠️ **SUPERSEDED-BY** plan 0015 — 2026-06-03. Canonical phase: [0015 §Phase 1 (Entity surgery — Lançamento schema swap)](./0015-contribuicao-pagamento-financeiro-collapse.md#phase-1--entity-surgery). Rationale: [0015 §Locked decisions #9 (LançamentoFinanceiro has no FSM)](./0015-contribuicao-pagamento-financeiro-collapse.md#locked-decisions) + [0015 §DDD concept #6 (Predicted dates vs observed dates)](./0015-contribuicao-pagamento-financeiro-collapse.md#ddd-concepts-this-plan-teaches).
>
> The predicted-maturation model (`maturaEm` computed from método + `aprovadoEm`, flipped by a scheduled job) is replaced by an **observed-transfer** model: `LancamentoFinanceiro` carries a `transferidoEm: Date | null` column set manually by the admin when the money actually reaches the recebedor. There is no `status` field on lançamento anymore (and no FSM); the implicit states are query-time predicates over `transferidoEm` + `canceladoEm`. The "maturation rule" — `calcularMaturaEm`, `MaturacaoRegra`, the `maturarLancamentos` use case, the scheduler job — is removed entirely. We store what *happened*, not what we *guessed would happen*.
>
> This file is preserved as historical context: the original predicted-maturation design and the DDD lessons it taught (time-based rules as persisted state, eager vs lazy projection) remain useful background reading even though the chosen path is different.
>
> ---
>
> **Status (historical)**: drafted 2026-05-24, never implemented.
> **Depended on**: plan `0005-durable-event-log-and-worker-queue.md` (the scheduler would have run the maturation job). Without 0005 it still worked as a manual use case; the cron piece needed 0005.

## Goal

Replace the demo's "Maturar pendentes" button with a real domain rule that flips `LancamentoFinanceiro.status` from `pendente` to `disponivel` automatically based on time + método.

Today: `examples/fluxo-completo.web.ts` mutates the memory map directly via an `as unknown as` hack. That's clearly demo-only. The real rule:

- **PIX**: maturation is essentially T+0 — funds available within minutes of provider confirmation. We pick a conservative 1-hour buffer.
- **Cartão de crédito**: standard market rule is D+30 from the *aprovado* date. Some plataformas negotiate D+14 or D+2 (anticipation). For 0006: D+30 default, no anticipation logic yet.
- **Boleto**: not supported yet; would be ~D+2.

## Locked decisions

1. **Maturation is a Financeiro BC concern.** Lancamento already lives there; the rule that flips its status belongs there too. Not Pagamentos (Pagamento is already terminal-aprovado by this point), not Checkout (no orchestration needed).

2. **Maturation rule is data on Lancamento, not derived.** When a Lancamento is created (during `finalizarPagamentoAprovado`), we *compute and persist* its `maturaEm: Date` based on método + aprovadoEm. The maturation job is then "find lancamentos where status=pendente AND maturaEm < agora" — trivial query, no per-row logic.

3. **Default rules table is a domain constant.** A map `{ pix: { days: 0, hours: 1 }, cartao_credito: { days: 30 } }` lives in `src/domain/financeiro/maturacao-regra.ts`. Per-plataforma overrides are out of scope for 0006 (deferred to plan 0009's RegraTaxa-like aggregate for plataforma-level financial rules).

4. **Business days vs calendar days: calendar days for 0006.** Holidays/weekends matter in real banking but add a lookup table and locale-awareness we don't need yet. Document the gap; revisit when a real recebedor complains.

5. **Maturation is eager (a job runs and writes), not lazy (computed on read).** Lazy is simpler but breaks any consumer that queries "what's my disponivel balance" without going through the right helper. Eager keeps the model honest: `status` is always current.

## DDD concepts this plan teaches

### Time-based domain rules as persisted state

A rule like "D+30" sounds like behavior, but persisting the *target date* turns it into state. The query becomes simple ("where maturaEm < now"), and the rule itself is auditable per-row ("this lancamento was created with a 30-day maturation"). If the rule changes later, old lancamentos keep their original maturaEm — which is what you want, because changing the rule retroactively is itself a business decision.

### Eager vs lazy projection of derived state

`status: disponivel` could be a *computed* field (look at maturaEm + now). Or it could be a *stored* field updated by a job. The trade: lazy is always consistent but harder to query/index; eager is fast to query but introduces a "when did the job run?" lag window. We pick eager because Financeiro queries (balance, repasse eligibility) are hot paths.

### The maturation rule is the engine's view, not the bank's

The provider/bank ultimately controls when funds actually arrive. Our `disponivel` is *our model's* view of "the recebedor can request a repasse on this." If the bank delays settlement, repasse will fail — we treat that as a Repasse failure, not a maturation problem. Clean separation between "the engine thinks it's ready" and "the bank actually paid out."

## Phases

### Phase 1 — `MaturacaoRegra` domain concept + `maturaEm` field

**Objective**: Lancamento gets a `maturaEm: Date` field. New lancamentos compute it from método.

**Files NEW**:
```
src/domain/financeiro/value-objects/
└── maturacao-regra.ts          # const MATURACAO_PADRAO + calcularMaturaEm(metodo, aprovadoEm)
migrations/
└── 20260701_001_add_matura_em_to_lancamentos.ts
tests/unit/financeiro/
└── maturacao-regra.test.ts
```

**Files MODIFIED**:
- `src/domain/financeiro/entities/lancamento-financeiro.ts` — add `maturaEm: Date` to interface (only meaningful for `tipo: 'credito_saldo_recebedor'`; null for `tipo: 'credito_receita_plataforma'`).
- `src/use-cases/checkout/finalizar-pagamento-aprovado.ts` — compute `maturaEm` when creating recebedor lancamentos.
- `src/adapters/financeiro/livro-repository.{memory,postgres}.ts` — persist new column.
- Conformance suite — assert maturaEm round-trips.

**Verification**: `pnpm check` green; new pix lancamentos get `maturaEm = aprovadoEm + 1h`; cartão lancamentos get `maturaEm = aprovadoEm + 30d`.

**STOP for confirmation.**

---

### Phase 2 — `maturarLancamentos` use case

**Objective**: A use case that finds matured-but-pendente lancamentos and flips them to disponivel.

**Files NEW**:
```
src/use-cases/financeiro/
└── maturar-lancamentos.ts
src/adapters/financeiro/
└── livro-repository.ts (modified)    # NEW method: findPendentesMaturados(antes: Date)
tests/unit/financeiro/
└── maturar-lancamentos.test.ts
```

**Behavior**:
```ts
maturarLancamentos(deps, { agora })
  → matched = livroRepo.findPendentesMaturados(agora)
  → for each: update status pendente → disponivel
  → log per-lancamento
  → return { count, idsMaturados }
```

**Verification**: integration test seeds lancamentos with past/future maturaEm, asserts only past ones flip.

**STOP for confirmation.**

---

### Phase 3 — Scheduler integration + remove demo hack

**Objective**: Maturation runs on a schedule via plan 0005's worker. Demo's "Maturar pendentes" button removed (or kept as "Run now" for testing).

**Files NEW**:
```
src/workers/jobs/
└── maturar-lancamentos.job.ts     # wraps maturarLancamentos for scheduler
```

**Files MODIFIED**: scheduler registers the job (every 5 min in dev, configurable); `examples/fluxo-completo.web.ts` removes the `as unknown as { lancamentos: Map }` hack and the manual button (or repurposes button to "Run maturation now").

**Verification**: worker tick maturates as expected; demo no longer mutates adapter internals.

**STOP for confirmation.**

---

## Open questions

1. **Anticipation (D+30 → D+2).** Some plataformas charge a fee to advance funds early. That's a whole sub-system: `solicitarAntecipacao(idsLancamentos)` → new Lancamento with negative tarifa, original lancamentos move to `antecipado` status. Out of scope for 0006, but the data model should leave room.

2. **Per-plataforma maturation overrides.** RegraTaxa is per-plataforma; should MaturacaoRegra be too? Probably yes eventually. For now hardcoded; future plan adds `RegraMaturacao` aggregate alongside RegraTaxa.

3. **What if Pagamento gets reversed/chargebacked after maturation?** Reversal is a real flow (cardholder disputes). It would create a *negative* lancamento that subtracts from saldo. If saldo is already repassado, we're underwater — same problem all PSPs deal with. Out of scope for 0006; needs its own plan.

4. **maturaEm for receita_plataforma lancamentos.** Plataforma's receita is "available" immediately or follows the same maturation rule? Probably immediate (plataforma already absorbed the risk). 0006 leaves receita lancamentos with `maturaEm = null` and treats them as always-disponivel.

5. **Backfill.** When 0006 lands, existing lancamentos have no `maturaEm`. Migration needs to compute and backfill them based on `criadoEm`. Easy for fresh data; needs a one-shot script for any pre-existing.

## Done definition

- All 3 phases land; `pnpm check` green.
- Demo no longer has the `as unknown as { lancamentos: Map }` hack.
- New lancamentos get `maturaEm` automatically.
- Worker (from plan 0005) runs maturation on schedule.
