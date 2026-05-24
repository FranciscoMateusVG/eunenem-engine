# Plan 0009 — Plataforma management (real admin UX)

> **Status**: drafted 2026-05-24, awaiting confirmation.
> **Depends on**: plan `0003-plataforma-multi-tenant-done.md` (Plataforma aggregate + seed data + RegraTaxa per plataforma). Synergizes with plan `0010-real-authentication-and-sessions.md` (admin role needs real auth).

## Goal

Today plataformas (`eunenem`, `eucasei`) are hand-seeded in the memory adapter's constructor. There's no way to create a new plataforma, edit its `RegraTaxa`, suspend, or archive it from outside the codebase.

This plan promotes Plataforma from "config that pretends to be domain" to a *real* domain aggregate with a lifecycle and the use cases needed to manage it:

- Create plataforma.
- Edit RegraTaxa (with versioning — past pagamentos must keep using the rule that was active when they happened).
- Suspend (no new campanhas/checkouts; existing ones drain).
- Archive (terminal, no resurrection).
- An admin UI that exposes these flows.

## Locked decisions

1. **Plataforma lifecycle states**: `ativa | suspensa | arquivada`. State machine:
   - `ativa → suspensa`: voluntary or by ops (e.g. fraud investigation). Reversible.
   - `suspensa → ativa`: reactivation.
   - `ativa | suspensa → arquivada`: terminal. No new state allowed after.
   - Existing campanhas keep functioning under their plataforma's current state (suspensa = no new checkouts but in-flight ones finish).

2. **RegraTaxa is versioned, not mutated in place.** Each edit creates a new RegraTaxa row with `vigenteDesde: Date` and (implicitly) the previous one is closed at the same instant. Pagamentos look up "the RegraTaxa where vigenteDesde <= pagamento.criadoEm AND nenhuma mais nova existe." This preserves historical correctness: a pagamento approved under the 5% rule is forever a 5% pagamento, even if today's rule is 6%.

3. **Postgres adapter for Plataforma BC lands here.** Plan 0003 left only the memory adapter. Real admin needs persistence.

4. **Admin UX is a separate set of routes** under `/admin/plataformas` in the demo. Not the same as the per-plataforma `/p/:slug/...` routes (which are tenant-scoped end-user views).

5. **Role-based authz: `admin` vs `operador` vs end-user.** Plataforma management requires `admin`. Suspend can be done by `operador`. Archive needs `admin`. This depends on plan 0010 — without real auth, the admin UX is unprotected (acceptable for demo, not for prod).

6. **`criarPlataforma` triggers `criarRegraTaxaPadrao` automatically.** Process manager / saga. New plataforma starts with a configurable default (e.g. presente: 5%, rifa: 5%). Admin can edit immediately after.

## DDD concepts this plan teaches

### Aggregate lifecycle as a first-class state machine

Today Plataforma has no state beyond "exists." Adding `ativa | suspensa | arquivada` makes the lifecycle explicit and lets the model reject invalid transitions (`arquivada → ativa` throws). This pattern repeats for every long-lived aggregate: Contribuicao (disponivel/indisponivel), Pagamento (pendente/aprovado/rejeitado), Repasse (solicitado/processando/concluido/falhou). Plataforma joins the club.

### Versioned value objects (effective-dated rules)

RegraTaxa was a single mutable thing. Making it versioned (each edit = new row, lookups by effective date) turns it into a *time series of immutable rules*. This is a generally useful pattern: pricing rules, fee schedules, tax rates, terms-of-service. The mental shift: instead of "what's the current rule," ask "what was the rule at moment T." The former is just `T = now`.

### Auto-seed via process manager (the deferred-from-0003 piece)

Plan 0003 explicitly deferred "when Plataforma is created, its default RegraTaxa needs to exist." Now we build it: `criarPlataforma` publishes `PlataformaCriada` → Taxas BC subscribes and runs `criarRegraTaxaPadrao`. Or, if we don't want the indirection yet, `criarPlataforma` calls `criarRegraTaxaPadrao` directly in the same use case. Either way, the seam is real.

### Admin operations are domain operations

The temptation: "admin stuff is just CRUD, skip the use case pattern, write controllers directly." Resist. `suspenderPlataforma` is a domain operation with rules (can't suspend an arquivada one) and side effects (block new checkouts). It deserves a use case file, typed errors, span, log. Admin actions are domain actions performed by a different actor — same plumbing.

## Phases

### Phase 1 — Plataforma lifecycle + state transitions

**Objective**: Add `status: 'ativa' | 'suspensa' | 'arquivada'` to Plataforma. Use cases for transitions. No UI yet.

**Files NEW**:
```
migrations/
└── 20261001_001_add_status_to_plataformas.ts        # plus the table itself if not yet in Postgres
src/use-cases/plataforma/
├── criar-plataforma.ts
├── suspender-plataforma.ts
├── reativar-plataforma.ts
└── arquivar-plataforma.ts
src/errors/plataforma/
├── transicao-status-invalida.error.ts
└── plataforma-arquivada.error.ts
src/adapters/plataforma/
└── repository.postgres.ts                          # NEW (memory exists from 0003)
tests/unit/plataforma/
├── criar-plataforma.test.ts
├── suspender-plataforma.test.ts
├── reativar-plataforma.test.ts
└── arquivar-plataforma.test.ts
tests/integration/
└── plataforma-repository.postgres.test.ts
tests/helpers/
└── plataforma-repository.conformance.ts
```

**Files MODIFIED**:
- `src/domain/plataforma/entities/plataforma.ts` — add status field + helpers (`podeSuspender(p)`, `podeArquivar(p)`).
- Memory adapter — initial seed entries get `status: 'ativa'`.
- `src/use-cases/arrecadacao/criar-campanha.ts` — reject if plataforma.status !== 'ativa' (new error).
- `src/use-cases/checkout/iniciar-pagamento-contribuicao.ts` — reject if plataforma.status !== 'ativa'.

**Verification**: `pnpm check` green; existing flows unaffected for ativa plataformas; suspensa blocks new checkouts.

**STOP for confirmation.**

---

### Phase 2 — Versioned RegraTaxa

**Objective**: Replace the per-plataforma single RegraTaxa with a time-series. Pagamentos resolve "the rule active at criadoEm."

**Files MODIFIED**:
- `src/domain/taxas/entities/regra-taxa.ts` — add `vigenteDesde: Date`. Aggregate root remains; uniqueness becomes `(idPlataforma, vigenteDesde)`.
- `src/adapters/taxas/regra-provider.ts` — port gains `getRegraVigenteEm(idPlataforma, momento: Date)` alongside existing `getRegraAtiva(idPlataforma)`.
- Memory + Postgres adapters — implement.
- `src/use-cases/checkout/iniciar-pagamento-contribuicao.ts` — use `getRegraVigenteEm(idPlataforma, clock())` instead of `getRegraAtiva`. The DTO use case for loja-precalc keeps using `getRegraAtiva` (showing the *current* price, not historical).
- `src/use-cases/plataforma/atualizar-regra-taxa.ts` — NEW use case: inserts a new RegraTaxa row with `vigenteDesde: clock()`.
- Migration: add `vigente_desde` column; backfill existing rows with `vigenteDesde = criadaEm` or epoch.

**Verification**: pagamento created under rule A keeps using A even after admin edits to rule B; loja precalc reflects rule B immediately.

**STOP for confirmation.**

---

### Phase 3 — Auto-seed RegraTaxa on `criarPlataforma`

**Objective**: When admin creates a new plataforma, the default RegraTaxa is created in the same flow.

**Files MODIFIED**:
- `src/use-cases/plataforma/criar-plataforma.ts` — after creating plataforma, calls `criarRegraTaxaPadrao(idPlataforma)` (a new helper or use case in taxas BC). Or publishes `PlataformaCriada` and lets a worker handler from plan 0005 do it. Choose based on whether 0005 is in.

**Decision point**: direct call (simple) or event-driven (decoupled). Direct call for 0009 unless 0005 is already shipped.

**Verification**: `criarPlataforma` followed by `getRegraAtiva` returns the default rule.

**STOP for confirmation.**

---

### Phase 4 — Admin UX

**Objective**: Web routes for admin to manage plataformas.

**Files MODIFIED**:
- `examples/fluxo-completo.web.ts`:
  - `GET /admin/plataformas` — list all (any status), with create button.
  - `GET /admin/plataformas/new` — create form.
  - `POST /admin/plataformas` — calls `criarPlataforma`.
  - `GET /admin/plataformas/:id` — detail page with current RegraTaxa, status, action buttons (suspender / reativar / arquivar), edit-regra form.
  - `POST /admin/plataformas/:id/suspender` etc.
  - `POST /admin/plataformas/:id/regra-taxa` — calls `atualizarRegraTaxa`.

**Out of scope**: actual authentication (depends on 0010 — the admin routes are "open" in the demo until then).

**Verification**: manual flow in browser; create plataforma → edit rule → checkout uses new rule → archive blocks further use.

**STOP for confirmation.**

---

## Open questions

1. **What does archiving cascade?** Archive a plataforma → existing campanhas: do they archive too, or do they continue under a "ghost plataforma"? Realistic answer: campanhas drain (existing pagamentos finish), no new campanhas created, after N days everything reads as "arquivada." Needs a soft answer first.

2. **RegraTaxa effective-date scheduling.** Today the new rule is effective immediately. Realistic: "rule X takes effect 2026-06-01 00:00 BRT" so admins can announce changes ahead. Add `vigenteDesde` to use-case input.

3. **Auditability.** Every Plataforma state transition + RegraTaxa change should produce an audit event. Wire to the outbox from plan 0005? Or a simple `plataforma_audit_log` table?

4. **Reactivation of arquivada.** Decided no, but worth confirming. The alternative ("create a fresh plataforma with same slug") feels cleaner because slugs in URLs would collide otherwise.

5. **Slug uniqueness on create.** Validation that new plataforma slug isn't already taken. Easy DB constraint; just don't forget.

## Done definition

- All 4 phases land; `pnpm check` green.
- Postgres adapter for Plataforma BC exists with conformance parity to memory.
- New plataforma creation works end-to-end in the demo.
- RegraTaxa is versioned; historical pagamentos use historical rules.
- Plataforma lifecycle (ativa/suspensa/arquivada) is enforced at every checkout entry point.
