# Plan 0003 — Plataforma (multi-tenant boundary)

> **Status**: drafted 2026-05-24, awaiting confirmation.
> **Blocks**: plan `0002-checkout-orchestration-layer.md` — every Checkout flow needs `idPlataforma`. This plan lands first; 0002 gets a small revision pass; then Phase 1 of Checkout proceeds.

## Goal

Introduce `Plataforma` as the multi-tenant boundary of the engine, so multiple plataformas (today: **eunenem**; tomorrow: **eucasei**, and beyond) can coexist on the same engine with distinct pricing, distinct user bases, and distinct campanhas.

Concrete trigger: eunenem charges 5% on the contribuinte for both presentes and rifas; eucasei will charge 6% on presentes and 8% on rifas. The current model has a single global `RegraTaxa` constant — that has to become per-plataforma data.

## Naming — why `Plataforma`

eunenem and eucasei are **plataformas** — white-label, brand-facing products. `engine` is the substrate they all run on. This is the standard term in white-label fintech / marketplace orchestration and it carries the right connotation.

Rejected alternatives: `Projeto` (vague, sounds internal), `Produto` (overloaded with product-catalog meaning), `Tenant` (infra-flavored, not domain-flavored).

## Locked decisions

1. **Coexistence model: true multi-tenant.** One database, one process serves all plataformas. The alternative ("per-deploy, plataforma as boot config") was rejected because it makes plataforma invisible to the domain — and pricing rules differ per plataforma, so plataforma IS domain.
2. **RegraTaxa shape: one aggregate per plataforma**, holding an internal `tarifasPorTipo` map keyed by `TipoOpcaoContribuicao`. Rejected: one row per `(plataforma, tipo)` — that fragments what is actually a single cohesive business object (a plataforma's pricing posture).
3. **Usuário scoping: 1 Usuario : 1 Plataforma.** Same person registering on two plataformas creates two `Usuario` rows. Email uniqueness becomes `(idPlataforma, email)`. No cross-plataforma SSO.
4. **Plataforma BC scope: minimum viable now.** Aggregate + repo + seed-data hardcoded with eunenem + eucasei. No `criarPlataforma` use case, no Postgres adapter, no status lifecycle. The concept is real (it gates business rules); the management UX comes later.
5. **Cross-BC reference discipline preserved.** Every BC that scopes to plataforma adds its OWN `IdPlataformaReferencia` mirror VO in its own `value-objects/ids.ts`. **No BC imports from `src/domain/plataforma/`.** Enforced by dependency-cruiser.

## DDD concepts this plan teaches

### Multi-tenancy as a domain concept (not infrastructure)

The lazy default is to treat tenancy as infra: an env var, a request header, middleware that scopes queries. That works *only if* tenancy doesn't change business rules. The moment tenancy affects pricing, validation, uniqueness, or visibility — it IS the domain. Hiding it in config means the model lies, and that lie compounds. We make Plataforma an explicit aggregate so the model tells the truth.

### Aggregate emergence

`RegraTaxa` started life as a Value Object because there was one global rule with no identity. Adding a second plataforma changes the world around it: the rule now has identity (which plataforma it belongs to), it has a lifecycle (created with the plataforma, mutable over time), and structural equality stops making sense ("5% on contribuinte" no longer uniquely names the rule — eunenem's and eucasei's might collide). That's the textbook moment to promote a VO to an aggregate root.

The lesson: aggregates emerge from real domain pressure, not from upfront ceremony. Same data shape — different DDD classification — because the surrounding world changed.

### Cross-BC reference Value Objects

`Campanha` references a plataforma. The naive move is `import { IdPlataforma } from '../../plataforma/value-objects/ids.js'`. We refuse that import. Instead, `arrecadacao/value-objects/ids.ts` declares its own `IdPlataformaReferencia` — same string shape, separate type, owned by Arrecadação. The two domains never touch via imports.

Why: BCs evolve at different rates. If Plataforma renames `IdPlataforma` tomorrow, Arrecadação shouldn't break. If we ever extract Plataforma into a separate service, the import boundary is already gone. The cost is one extra VO per consuming BC; the payoff is loose coupling at the type level, enforced by dependency-cruiser.

### Composite uniqueness as a tenancy fingerprint

When the uniqueness rule on `email` becomes `(idPlataforma, email)`, that single change is the code-level signal that tenancy is correctly embedded in the model. Watch for it elsewhere: when a "global" uniqueness rule starts feeling wrong, it's usually a hidden tenancy signal asking to be made explicit.

### Process Manager moment (deferred to a future plan)

When a Plataforma is created, its default RegraTaxa needs to exist. In the full design that's a Process Manager: `PlataformaCriada` event → Taxas seeds a default `RegraTaxa`. We skip that for MV by hand-seeding both rows in memory together. But the seam is intentional — when `criarPlataforma` arrives, the orchestration shape will be obvious.

## Phases

Each phase follows the brief's work mode: explain → list files → smallest piece → tests → `pnpm check` → plain-language summary → **STOP for confirmation**.

---

### Phase A — Plataforma BC (skeleton)

**Objective**: Plataforma exists as a domain concept with identity, name, and a memory repo seeded with eunenem + eucasei. Other BCs can begin referencing it.

**DDD concepts in play**:
- New aggregate root with minimal behavior — identity is the point
- Minimum-viable BC: no use cases, just data + lookup port

**Files NEW**:
```
src/domain/plataforma/
├── entities/plataforma.ts          # @aggregateRoot Plataforma (BC Plataforma)
└── value-objects/
    ├── ids.ts                       # IdPlataformaSchema, IdPlataforma
    └── slug-plataforma.ts           # SlugPlataformaSchema — "eunenem", "eucasei" (kebab-case)
src/adapters/plataforma/
├── repository.ts                    # PlataformaRepository port
└── repository.memory.ts             # Seeded with eunenem + eucasei in constructor
src/errors/plataforma/
└── nao-encontrada.error.ts
tests/unit/plataforma/
└── plataforma.test.ts
```

**Plataforma shape**:
```ts
interface Plataforma {
  readonly id: IdPlataforma;
  readonly slug: SlugPlataforma;     // "eunenem", "eucasei"
  readonly nome: string;              // "EuNenem", "EuCasei" (display name)
  readonly criadaEm: Date;
}
```

**Port**:
```ts
interface PlataformaRepository {
  findById(id: IdPlataforma): Promise<Plataforma | undefined>;
  findBySlug(slug: SlugPlataforma): Promise<Plataforma | undefined>;
  listAtivas(): Promise<readonly Plataforma[]>;
}
```

**Seed (memory adapter constructor)**:
```ts
new PlataformaRepositoryMemory([
  { id: 'plat-eunenem-uuid', slug: 'eunenem', nome: 'EuNenem', criadaEm: new Date('2026-01-01') },
  { id: 'plat-eucasei-uuid', slug: 'eucasei', nome: 'EuCasei', criadaEm: new Date('2026-01-01') },
]);
```

**Out of scope**: `criarPlataforma` use case, Postgres adapter + conformance, status lifecycle (ativa/suspensa/arquivada).

**Verification**: `pnpm check` green; `Plataforma` types exported from `src/index.ts`; tests prove `findById` and `findBySlug` work on the seeded data.

---

### Phase B — Taxas: RegraTaxa becomes per-plataforma aggregate

**Objective**: Replace the global `REGRA_TAXA_PADRAO` constant with a per-plataforma `RegraTaxa` aggregate. eunenem keeps `{presente: 5%, rifa: 5%}` on contribuinte; eucasei gets `{presente: 6%, rifa: 8%}` on contribuinte.

**DDD concepts in play**:
- VO → Aggregate Root promotion
- Internal value-collection inside an aggregate (`tarifasPorTipo`)
- Separation of *aggregate data* from *pure calculation* — calculation helpers move to a stateless module
- Mirror VO `IdPlataformaReferencia` in Taxas

**Files NEW**:
```
src/domain/taxas/entities/regra-taxa.ts        # @aggregateRoot RegraTaxa (BC Taxas)
src/domain/taxas/value-objects/tarifa-tipo.ts  # TarifaTipo VO (percentageBps + responsavelTaxa)
src/errors/taxas/regra-nao-encontrada.error.ts
src/errors/taxas/tarifa-tipo-nao-configurada.error.ts
```

**Files UPDATED**:
- `src/domain/taxas/value-objects/regra-taxa.ts` → renamed/repurposed to `calculo-taxa.ts`. Keeps only the pure helpers (`calcularValorTaxaPercentual`, `calcularTaxa`, `calcularComposicaoValores`). They now take a `TarifaTipo` (or `(RegraTaxa, tipo)` pair), not the old flat shape.
- `src/domain/taxas/value-objects/ids.ts` — add `IdRegraTaxaSchema`, `IdPlataformaReferenciaSchema`.
- `src/adapters/taxas/regra-provider.ts` — port becomes `getRegraAtiva(idPlataforma: IdPlataformaReferencia): Promise<RegraTaxa>`. Throws `RegraNaoEncontradaError` if missing.
- `src/adapters/taxas/regra-provider.memory.ts` — seed two RegraTaxa rows (eunenem + eucasei) with the rates above.
- All Pagamentos use cases / orchestrators that currently call `calcularComposicaoValores` — signature update to pass the tipo so the right `TarifaTipo` is selected.
- Existing tests touching RegraTaxa.

**RegraTaxa aggregate shape**:
```ts
interface RegraTaxa {
  readonly id: IdRegraTaxa;
  readonly idPlataforma: IdPlataformaReferencia;
  readonly tarifasPorTipo: ReadonlyMap<TipoOpcaoContribuicao, TarifaTipo>;
  readonly criadaEm: Date;
}

interface TarifaTipo {
  readonly percentageBps: PercentualTaxaBps;
  readonly responsavelTaxa: ResponsavelTaxa;
}

function obterTarifaPorTipo(regra: RegraTaxa, tipo: TipoOpcaoContribuicao): TarifaTipo;
// throws TarifaTipoNaoConfiguradaError if the plataforma has no tarifa for that tipo
```

**Out of scope**: rule versioning over time (the existing `SnapshotComposicaoValores` on Pagamento already freezes the rate at payment time — historical accuracy is preserved), Postgres for RegraTaxa, mutating use case (`alterarRegraTaxa`).

**Verification**: `pnpm check` green; both eunenem and eucasei produce distinct composições for the same contribution amount in tests.

---

### Phase C — Arrecadação: Campanha scoped to plataforma

**Objective**: Every Campanha belongs to exactly one Plataforma. `criarCampanha` requires and validates `idPlataforma`.

**DDD concepts in play**:
- Mirror VO `IdPlataformaReferencia` in Arrecadação (not imported from Plataforma)
- Cross-BC validation via port injection (`plataformaRepository` injected into `criarCampanha`, used only for `findById` to assert existence)
- New read-side query: `findByPlataforma`

**Files UPDATED**:
- `src/domain/arrecadacao/value-objects/ids.ts` — add `IdPlataformaReferenciaSchema`.
- `src/domain/arrecadacao/entities/campanha.ts` — add `idPlataforma: IdPlataformaReferencia` field.
- `src/use-cases/arrecadacao/criar-campanha.ts` — input schema gains `idPlataforma`; deps gain `plataformaRepository`; body asserts plataforma exists before creating.
- `src/adapters/arrecadacao/campanha-repository.ts` — `findByPlataforma(idPlataforma)` added.
- `src/adapters/arrecadacao/campanha-repository.memory.ts` + `.postgres.ts` — implement.
- Conformance suite — assert both adapters return same shape for `findByPlataforma`.
- Migration: `migrations/XXXX-add-id-plataforma-to-campanhas.ts`.
- `pnpm db:codegen` after migration; commit the regenerated `db-types.generated.ts`.

**Files NEW**:
- `src/errors/arrecadacao/plataforma-nao-encontrada.error.ts`

**Out of scope**: backfilling existing campanhas (they're all eunenem — migration sets default to eunenem id), per-plataforma authorization ("a user can only create campanhas in their plataforma" — that's Phase E).

**Verification**: `pnpm check` green; both adapters pass conformance suite; tests prove `criarCampanha` rejects unknown `idPlataforma`.

---

### Phase D — Usuário scoped to plataforma

**Objective**: A Usuario belongs to exactly one Plataforma. Email uniqueness becomes `(idPlataforma, email)`. Login (`autenticarUsuario`) takes `idPlataforma`. Sessão is plataforma-scoped.

**DDD concepts in play**:
- Composite uniqueness invariant `(idPlataforma, email)`
- Mirror VO `IdPlataformaReferencia` in Usuário
- Cross-BC validation: `registrarContaUsuario` injects `plataformaRepository` to assert plataforma exists

**Files UPDATED**:
- `src/domain/usuario/value-objects/ids.ts` — add `IdPlataformaReferenciaSchema`.
- `src/domain/usuario/entities/usuario.ts` — add `idPlataforma` field on `Usuario`.
- `src/domain/usuario/entities/sessao.ts` — add `idPlataforma` field (or assert it's reachable via the linked Usuario).
- `src/use-cases/usuario/registrar-conta-usuario.ts` — input + deps + uniqueness check (`(idPlataforma, email)`).
- `src/use-cases/usuario/autenticar-usuario.ts` (login UC, exact name TBC) — input gains `idPlataforma`; lookup becomes `findByEmail(idPlataforma, email)`.
- `src/adapters/usuario/repository.ts` — `findByEmail` becomes `findByEmail(idPlataforma, email)`.
- `src/adapters/usuario/repository.memory.ts` + `.postgres.ts` — implement; Postgres unique index becomes composite.
- Conformance suite update.
- Migrations + codegen.

**Out of scope**: cross-plataforma SSO, identity federation, account-merge flows, "switch plataforma" UX. Not in this engine's scope at all.

**Verification**: `pnpm check` green; tests prove the same email can register on eunenem AND eucasei, but not twice on the same plataforma; login on plataforma A cannot authenticate against an account on plataforma B.

---

## What this plan does NOT address

- `criarPlataforma` use case (runtime onboarding of new plataformas)
- Plataforma status lifecycle (ativa / suspensa / arquivada)
- Plataforma-scoped configuration beyond RegraTaxa (branding, supported payment methods, custom domains, etc.)
- Per-plataforma authorization (a user can only act on resources in their plataforma — "Phase E" for a future plan)
- Rule versioning / historical rule lookup (snapshot on Pagamento makes this unnecessary today)
- Postgres adapter for Plataforma BC + RegraTaxa (memory-first per brief)
- Real event bus + Process Manager wiring (`PlataformaCriada → seed RegraTaxa`) — hand-seeded for now
- **Plan 0002 (Checkout) revisions** — every Checkout use case needs `idPlataforma` plumbed through. That revision pass happens AFTER this plan lands.

## Cadence

Each phase: explain objective → list files → write smallest piece → tests → `pnpm check` → plain-language summary → **STOP for confirmation** before next phase. No batching, no skipping.

## Order of operations

1. Phase A (Plataforma skeleton) — independent, smallest
2. Phase B (Taxas: aggregate promotion) — depends on A for IdPlataformaReferencia conceptually
3. Phase C (Arrecadação: Campanha scoping) — depends on A
4. Phase D (Usuário: scoping + composite uniqueness) — depends on A
5. **Revision pass on plan 0002** — small edit to mark `idPlataforma` plumbing across all Checkout phases
6. Resume Checkout Phase 1 from 0002
