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
| Pagamentos | Pagamento | 1 (`PagamentoRepository`) | **1** (file contains `Pagamento` + nested `IntencaoPagamento` + nested `TransacaoExterna`) |
| Usuário | Usuario, Sessao | 2 (`UsuarioRepository`, `SessaoUsuarioRepository`) | **2** (`usuario.ts` also contains nested `Conta` + nested `CredencialSimulada`) |
| Taxas | RegraTaxa | 1 (`ProvedorRegraTaxa`) | **1** |
| Plataforma | Plataforma | 1 (`PlataformaRepository`) | **1** |
| Financeiro | LancamentoFinanceiro, RepasseRecebedor | 1 (`LivroFinanceiroRepository` — handles both) | **2** *(open design point)* |

**One file ⇔ one aggregate root ⇔ one persistence boundary.**

### Why the folder splits this way

The aggregate is the **consistency boundary** for transactions. When you save a `Pagamento`, its `intencao` and `transacaoExterna` must be saved with it — they're a transactional unit. The repository contract guarantees that.

If `IntencaoPagamento` were its own aggregate root, you could create a "payment intent" without a "payment" — leading to orphan intents with no clear invariant to guard them. By keeping `IntencaoPagamento` inside `Pagamento`, you make it **impossible by construction** for an intent to exist without its parent.

Compare to Arrecadação: a `Contribuicao` exists standalone (an item on the campaign page before any checkout). You create it, update it, delete it — all without touching its `Campanha` row. That independence is what earns it its own aggregate-root status, its own repository, and its own file.

### Mental shortcut

> If the only way to act on it is by loading something bigger first, it's a nested entity (lives inside the root's file).
>
> If you can load and act on it directly via its own repository, it's an aggregate root (gets its own file in `entities/`).

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

## When in doubt

1. Sketch the data: what fields does the thing have?
2. Ask "would two of these with the same fields be considered the same?" → if yes, VO; if no, Entity.
3. If Entity: ask "does it have its own repository / can it be loaded standalone?" → if yes, aggregate root (own file); if no, nested (lives in root's file).
4. If unsure on aggregate boundaries: which thing carries the *transactional invariant*? That's the aggregate root; everything reached only through it is nested.
