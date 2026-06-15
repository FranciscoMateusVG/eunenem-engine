# DDD Conventions — engine

Living reference for how this repo expresses DDD in the folder layout. Useful when you're staring at a BC and trying to figure out where a new thing belongs.

---

## The folder layout, restated

```
src/domain/<bc>/
├── entities/          ← one file per AGGREGATE ROOT
└── value-objects/     ← VOs split by concept; identifier VOs share ids.ts
```

If a BC has no aggregate roots (calculation-only, lookup table without lifecycle), it has **no `entities/` folder at all**. The folder's absence is itself informational.

---

## Entity vs Value Object — the diagnostic

> "Do two instances with the same data count as the same thing?"

- **Yes** → Value Object (structural equality, no identity, lives in `value-objects/`)
- **No** → Entity (identity matters; two rows with identical fields but different ids are different things)

| Thing | Same data → same thing? | Verdict |
|---|---|---|
| Two `MetodoPagamento` both `'pix'` | yes — `'pix' === 'pix'` | **VO** |
| Two `IntencaoPagamento` with same amount + metodo but different `id` | no — different intents | **Entity** |
| Two `ComposicaoValores` with same numbers | yes — equal by structure | **VO** |
| Two `Pagamento` with same status + total | no — different transactions | **Entity (aggregate root)** |

---

## Aggregate Root vs nested Entity — the *file* question

Once you've decided something is an entity, the next question is: **does it get its own file in `entities/`?**

**The rule: one file in `entities/` per aggregate root. Nested entities co-locate inside their root's file.**

The folder is a roll-call of *aggregate roots*, not of *entities*.

### The diagnostic: "is there a separate repository?"

- **Yes** → it's an aggregate root → its own file in `entities/`
- **No** (it's only ever loaded as part of a larger thing) → it's a nested entity → defined inside the root's file with `@entity <Name> (within <Root> aggregate)` JSDoc

### Examples in this repo

| BC | Aggregate roots | Repositories | Files in `entities/` |
|---|---|---|---|
| Arrecadação | Campanha, Contribuicao, Recebedor | 3 (`CampanhaRepository`, `ContribuicaoRepository`, `RecebedorRepository`) | **3** |
| Pagamentos | Pagamento | 1 (`PagamentoRepository`) | **1** (file contains `Pagamento` + nested `IntencaoPagamento` + nested `TransacaoExterna` + the **Financeiro module** — see note below) |
| Usuário | Usuario, Sessao | 2 (`UsuarioRepository`, `SessaoUsuarioRepository`) | **2** (`usuario.ts` also contains nested `Conta` + nested `CredencialSimulada`) |
| Taxas | RegraTaxa | 1 (`ProvedorRegraTaxa`) | **1** |
| Plataforma | Plataforma | 1 (`PlataformaRepository`) | **1** |

**One file ⇔ one aggregate root ⇔ one persistence boundary.**

> 📌 **2026-06-03 — Financeiro is a module inside Pagamentos, not a standalone BC.** Per plan [0015 §Locked-decisions 1](../plans/0015-contribuicao-pagamento-financeiro-collapse.md), what was once a separate Financeiro BC (with its own `src/domain/financeiro/`, its own `LivroFinanceiroRepository`, its own ubiquitous language) collapses into the Pagamentos BC as the **Financeiro module**. Concretely: `LancamentoFinanceiro` and `RepasseRecebedor` live under `src/domain/pagamentos/financeiro/`, use-cases under `src/use-cases/pagamentos/financeiro/`, adapters under `src/adapters/pagamentos/financeiro/`. The persistence boundary stays one repository surface; the namespace folds. See the lifecycle-independence test below for why.

### Why the folder splits this way

The aggregate is the **consistency boundary** for transactions. When you save a `Pagamento`, its `intencao` and `transacaoExterna` must be saved with it — they're a transactional unit. The repository contract guarantees that.

If `IntencaoPagamento` were its own aggregate root, you could create a "payment intent" without a "payment" — leading to orphan intents with no clear invariant to guard them. By keeping `IntencaoPagamento` inside `Pagamento`, you make it **impossible by construction** for an intent to exist without its parent.

Compare to Arrecadação: a `Contribuicao` exists standalone (an item on the campaign page before any checkout). You create it, update it, delete it — all without touching its `Campanha` row. That independence is what earns it its own aggregate-root status, its own repository, and its own file.

### Three-level nesting — the cart pattern

Plan 0016 (multi-item pagamento) deepened the Pagamento aggregate to three levels:

```
Pagamento (aggregate root)
 ├── IntencaoPagamento (nested entity — the cart)
 │    ├── items: ItemDoPagamento[] (nested entities — the cart's lines)
 │    └── composicaoValoresAggregate (VO — sum of lines)
 └── TransacaoExterna (nested entity — provider settlement)
```

Three levels passes the same diagnostic that justified two levels:

- **Lifecycle independence?** No — an `ItemDoPagamento` is born when its `IntencaoPagamento` is born (`criarPagamentoPendente`) and dies when the pagamento dies (`ON DELETE CASCADE` at the persistence layer). There's no use case that creates, updates, or deletes an item in isolation.
- **Own ubiquitous language?** No — items use the cart's language (`tipo`, `quantidade`, `composicaoValoresItem`). Operators say "the cart has three items"; they don't say "the items belong to a payment" (that's an implementation detail of *how* the cart is persisted).
- **Standalone repository?** No — there is no `ItemDoPagamentoRepository`. Items are loaded as part of `PagamentoRepository.findById`; they're written as part of `save(pagamento)`. The repository surface stays one.

**Rationale for the depth.** The cart is itself a nested entity (Plan 0015's `IntencaoPagamento` decision), not an aggregate root. The cart's *lines* are the natural unit of iteration for the lançamento factory and for the Stripe `line_items` mapping. Hoisting them to be siblings of `IntencaoPagamento` (directly under `Pagamento`) would force a two-level traversal at the factory call site (`pagamento.items` AND `pagamento.intencao`); keeping them under `IntencaoPagamento` keeps the traversal one level (`pagamento.intencao.items`). The depth is a function of the data's natural shape, not of complexity for its own sake.

**Naming.** Items use the **"Do" connector** in the entity name (`ItemDoPagamento`, not `ItemPagamento`). See *Naming conventions* below for the rationale — TL;DR: the connector signals "real entity inside an aggregate," distinguishing this kind of thing from the no-connector VOs (`MetodoPagamento`, `EventoPagamento`, `IntencaoPagamento` itself).

### Mental shortcut

> If the only way to act on it is by loading something bigger first, it's a nested entity (lives inside the root's file).
>
> If you can load and act on it directly via its own repository, it's an aggregate root (gets its own file in `entities/`).

---

## Module vs Bounded Context — the lifecycle-independence test

Once a BC has more than one aggregate root, the temptation to grow it into "a BC for each cluster" is real. Resist by default. **A new BC is justified only when the cluster has independent lifecycle.** Concretely, a separate BC needs all three of:

1. **Its own ubiquitous language.** Domain experts say the same word for the same thing across the cluster, and a *different* word for the things outside it. If translating to/from the parent BC is one-to-one and trivial, the language hasn't actually forked.
2. **Its own consistency boundary.** The cluster has invariants that hold *within itself* but not against the parent. Writes inside the cluster should not require coordinating with the parent's aggregates in the same transaction. If they do, the cluster is downstream of the parent's consistency boundary, not parallel to it.
3. **Lifecycle independence from the parent.** Aggregates in the cluster can be born, change, and die *without* a corresponding event on a parent aggregate. If every write in the cluster is *caused by* a parent aggregate's transition, the cluster is the parent's downstream projection — that's a module, not a BC.

If any of the three fails, what you have is a **module inside the parent BC** — a folder grouping, not a sovereign domain.

**Worked example: Financeiro.** Originally drafted as a BC alongside Pagamentos. After plan 0015 the test fails on points 2 and 3:

- **Consistency:** `LancamentoFinanceiro` rows are born transactionally with the Pagamento that triggered them; their `canceladoEm` is set transactionally when the same Pagamento estorna. The financeiro write IS the pagamento write — same DB transaction, same aggregate boundary.
- **Lifecycle:** there is no Lancamento without a Pagamento causing it. Every state change on a Lancamento has a Pagamento (or admin action against a Lancamento, with no peer aggregate involved) as its proximate cause. There is no "Lancamento lifecycle" parallel to Pagamento's.

Conclusion: Financeiro is a **module of Pagamentos**, expressed at the folder level (`src/domain/pagamentos/financeiro/`) rather than at the BC level. The repository surface stays one (`PagamentoRepository`); the aggregate root stays Pagamento; the financeiro entities are reachable through it.

**Worked counter-example: Plataforma.** Plataforma passes all three: its own ubiquitous language (tenancy, ownership, RegraTaxa lifecycle), its own consistency boundary (per-tenant invariants that don't touch Pagamento writes), and lifecycle independence (a Plataforma is born + dies on its own admin clock, unrelated to any single pagamento). It earns its BC status.

The lesson: BCs are expensive. Modules are cheap. Use the test before splitting; collapse when the test stops passing.

---

## Cross-BC references — Mirror VOs

When a BC needs to reference an aggregate that lives in another BC, **it does NOT import that BC's domain types.** Instead, it declares its own *mirror VO* with the same shape.

Example: every BC that scopes to plataforma declares its own `IdPlataformaReferencia` VO in its own `value-objects/ids.ts`:

```
src/domain/plataforma/value-objects/ids.ts       ← IdPlataforma (canonical)
src/domain/arrecadacao/value-objects/ids.ts     ← IdPlataformaReferencia (mirror)
src/domain/taxas/value-objects/ids.ts            ← IdPlataformaReferencia (mirror)
src/domain/usuario/value-objects/ids.ts          ← IdPlataformaReferencia (mirror)
```

All four are structurally identical (`z.uuid()`), all four are nominally distinct, none import from another BC. Enforced by dependency-cruiser.

**Why the duplication is the design:** BCs evolve at different rates. If Plataforma renames `IdPlataforma` tomorrow, no other BC's build breaks. If we ever extract Plataforma into its own service, the import boundary is already gone. The cost is one extra VO per consuming BC; the payoff is loose coupling at the type level.

---

## JSDoc annotations

Every entity file starts with a JSDoc header that says *what kind of entity it is*:

```ts
/**
 * @aggregateRoot Campanha (BC Arrecadação)
 *
 * <one-liner on what it owns and how it's persisted>
 */
export interface Campanha { ... }
```

For nested entities inside an aggregate:

```ts
/** @entity Conta (within Usuario aggregate) */
export interface Conta { ... }
```

Reading the JSDoc tells you the entity's role without having to inspect imports or repository wiring.

---

## VO file-splitting rules

- Identifier VOs share a single `ids.ts` per BC (e.g., `IdCampanha`, `IdConta`, `IdRecebedor` all in one file).
- Each conceptual VO gets its own file (`dados-recebedor.ts`, `email-usuario.ts`, `metodo-pagamento.ts`).
- Tiny enums that are intrinsic to a single entity (e.g., `StatusContribuicao` for `Contribuicao`) stay **inlined** in the entity's file — they don't earn a separate VO file unless they'd ever be reused across aggregates.

---

## Naming conventions — the "Do" connector

Inside the Pagamentos BC two names share a noun root but mean different things:

- `MetodoPagamento` — a Value Object (pix / credit_card). No identity, no lifecycle.
- `EventoPagamento` — a Value Object (the published event after a status flip). No identity, no lifecycle.
- `IntencaoPagamento` — a **nested Entity** with identity, born + dies with its `Pagamento`.
- `ItemDoPagamento` — a **nested Entity** with identity, born + dies with its `IntencaoPagamento`.

Notice the pattern: the **"Do" connector** is used when the noun is a real entity nested inside the aggregate (`ItemDoPagamento` = "Item of the Payment"). The **no-connector form** is reserved for VOs that describe attributes of the payment without owning their own row (`MetodoPagamento`, `EventoPagamento`).

`IntencaoPagamento` looks like the exception (entity without the "Do"), but it was named before the convention crystallized; renaming would carry a wide refactor cost for a marginal clarity gain. New entities in the Pagamentos BC use the "Do" form going forward.

**Rationale.** The connector is a lightweight cue at read-time: when you see `ItemDoPagamento` you know there's an `id` somewhere and a row in the database; when you see `MetodoPagamento` you know it's a `'pix' | 'credit_card'` literal that gets compared structurally. The convention costs four characters and saves a JSDoc-lookup at every reference site.

**Not a hard rule for other BCs.** Arrecadação uses no connectors at all (`Campanha`, `Recebedor`, `Contribuicao`) — its entities are either aggregate roots (their own file makes their status obvious) or absent (no nested entities). The "Do" cue is most useful in BCs where nested entities and same-noun VOs coexist, which is currently only Pagamentos.

---

## When in doubt

1. Sketch the data: what fields does the thing have?
2. Ask "would two of these with the same fields be considered the same?" → if yes, VO; if no, Entity.
3. If Entity: ask "does it have its own repository / can it be loaded standalone?" → if yes, aggregate root (own file); if no, nested (lives in root's file).
4. If unsure on aggregate boundaries: which thing carries the *transactional invariant*? That's the aggregate root; everything reached only through it is nested.
