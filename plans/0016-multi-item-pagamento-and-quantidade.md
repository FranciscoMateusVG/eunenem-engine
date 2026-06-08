# 0016 — Multi-item Pagamento + Quantidade na Contribuição

**Status.** 📝 drafted 2026-06-08
**Depends on.** 0015 (FSM collapse — shipped 2026-06-04), 0013 (provider fee passthrough — shipped via aperture-uyw8i + aperture-bjshv)
**Supersedes parts of.** —
**Unblocks.** Real-world cart UX (visitor buys N wine glasses in one shot), honest "queimou X de N" badge on partially-sold slots, item-shaped Stripe receipts that match the domain ledger 1:1, end of the asymmetric `surchargeCents` field at IntencaoPagamento level.

## Goal

After this lands, the engine has:

- **Contribuição** gains a single field — `quantidade: number` (default 1). The slot definition stops being "one row per countable thing" and starts being "one row per addressable item, with a stock count."
- The "indisponível" boolean predicate goes away. In its place: `quantidadeRestante(c): number` + `esgotada(c): boolean` (derived from `quantidadeRestante ≤ 0`).
- **IntencaoPagamento** becomes a multi-item cart. The single `idContribuicao` field at the root retires; in its place is `items: readonly ItemDoPagamento[]`.
- **ItemDoPagamento** is the new entity inside the Pagamento aggregate. Discriminated by `tipo`: `'contribuicao'` (carries `idContribuicao` + `quantidade` + per-item composição) or `'passthrough_surcharge'` (carries the card surcharge as its own line; no `idContribuicao`).
- **Lançamento factory** stops branching on the pagamento's `surchargeCents` and instead iterates over `items`, emitting per-item lançamentos (2 per contribuição item, 1 per surcharge item).
- The asymmetric `surchargeCents` field at `SnapshotComposicaoValores` retires — surcharge is just another item now, modeled symmetrically with everything else the buyer paid for.

**Trigger.** Operator's wine-glass framing: today, registering "5 wine glasses for the reception" creates 5 Contribuição rows that look identical to the visitor + ledger 5 times in the admin UI. The slot model and the buy-this-thing model fused into one row, which only works when quantidade ≡ 1. The locked decision splits them: Contribuição is one row per addressable thing (the slot); how many of that thing the slot represents is a field; how many a buyer wants is on the item.

Operator framing (verbatim): *"5 wine glasses = 1 Contribuicao with quantidade=5. Today's '1 row per slot' pattern goes away. Predicate rename: out goes `contribuicaoEstaIndisponivel: boolean`. In comes `quantidadeRestante(c): number` + `esgotada(c): boolean`."*

## Locked decisions

These mirror GLaDOS's dispatch verbatim and are not up for re-litigation.

1. **Contribuição gains `quantidade: number` (default 1).** Validated as positive integer at schema time. 5 wine glasses = 1 Contribuição row with `quantidade = 5`. Today's "create 5 identical rows" pattern is the workaround the field eliminates.

2. **Predicate rename.** Drop `contribuicaoEstaIndisponivel(idContribuicao): Promise<boolean>`. Replace with:
   - `quantidadeRestante(idContribuicao): Promise<number>` — `contribuicao.quantidade - SUM(item.quantidade across aprovado pagamentos)`. Can return ≤ 0 (overshoot is fine, see #10).
   - `esgotada(idContribuicao): Promise<boolean>` — derived: `quantidadeRestante(c) <= 0`.

3. **Consuming status = `aprovado` only.** Same gate as today's `contribuicaoEstaIndisponivel`. Double-pay is fine. Overshoot is fine. Operator-accepted: *"we actually just transfer funds, there is no stock no actual gifts... in case this happens there is absolutely no problem of having a contribucao with two valid pagamentos."* (carried forward from plan 0015 locked decision #6).

4. **Migration = greenfield drop on staging.** No backfill ceremony. No preserve-existing-rows logic. Operator confirmed staging is throwaway data; production hasn't seen real traffic on the changing surfaces. Existing aprovado pagamentos on the staging DB stay readable post-migration (FK linkage preserved); but no item-shape backfill, no synthetic `quantidade=1` migration step beyond the column default.

5. **New entity `ItemDoPagamento`** lives inside the Pagamento aggregate, **as a collection child of IntencaoPagamento** (placement is my call per dispatch). IntencaoPagamento today already owns the per-charge value snapshot + external-ref lifecycle; the items are the per-line decomposition of that same intent. Sibling to `IntencaoPagamento` (i.e. directly under Pagamento root) would force the lancamento factory to traverse two levels; under IntencaoPagamento it stays one.

6. **`ItemDoPagamento` shape:** `{ id, tipo, idContribuicao | null, quantidade, composicaoValoresItem }`. Position-stable inside `intencao.items` — contribuição items first (in caller-provided order), surcharge item ALWAYS LAST when present (locked at operator review per §Operator review locks #18). The convention mirrors Stripe's UI rendering of the processing fee. `id` is a fresh UUID per item (caller-controlled per the engine's existing convention).

7. **Discriminator `tipo: 'contribuicao' | 'passthrough_surcharge'`.** Construction-time validation:
   - `tipo === 'contribuicao'` → `idContribuicao` REQUIRED, `quantidade ≥ 1`.
   - `tipo === 'passthrough_surcharge'` → `idContribuicao === null`, `quantidade === 1` (the surcharge is a single line for the whole cart, not per-item; see invariant #11).

8. **Cart-construction invariant.** All items in one IntencaoPagamento share the same `idCampanha`. One cart = one recebedor. Cross-registry mixing is impossible — visiting another campanha resets the cart (UI invariant; domain doesn't model carts across campanhas at all). Enforcement lives **at two layers**:
   - **IntencaoPagamento factory** (`criarPagamentoPendente`): rejects construction if any `tipo='contribuicao'` item's contribuição lookup yields a different `idCampanha`. This is the entity-side honest backstop — any IntencaoPagamento that exists in the system is valid by construction.
   - **Cart use-case** (`iniciarPagamentoCarrinho`, see Phase 2): same check earlier with friendlier `CarrinhoMultiplasCampanhasError` for the API surface. The factory throws if reached with mismatched campanhas — a programming bug at that layer, not a user error.

9. **Estorno: whole-pagamento only.** All-or-nothing. The existing `aprovado → estornado` transition stays, just operates on a multi-item pagamento. No partial refunds, no item-level estorno state. Stripe refund call refunds the entire `totalPaidCents`; the cascade marks `canceladoEm` on every lançamento for the pagamento, regardless of which item produced it.

10. **Race conditions: accept overshoot.** Honest predicate at query time. No pre-reservation table, no TTL cleanup cron, no claim semantics. `quantidadeRestante` sums actual `aprovado` items. If 5 wine glasses are listed and 7 get bought (two carts of 4 + 4 racing through), the operator pockets 7-glasses-worth of money; `quantidadeRestante` returns `-3`; `esgotada` returns true. No remediation, no error.

11. **Surcharge as item (Option C).** The card-passthrough surcharge is its own ItemDoPagamento with `tipo='passthrough_surcharge'`. NOT a special field on IntencaoPagamento. Stripe sees it as a `line_item`; the domain mirrors that shape symmetrically. The asymmetric `surchargeCents` field at `SnapshotComposicaoValores` (introduced by aperture-uyw8i) **retires**. PIX flows have zero surcharge items; cartão flows have exactly one. The book balance shifts from "totalPaid = receiver + fee + surcharge" (pagamento-level) to "totalPaid = SUM(item totals)" (cart-level).

12. **Lançamento factory: per-item emission map.**
    - `item.tipo === 'contribuicao'` → 2 lançamentos:
      - `credito_saldo_recebedor` (amountCents = `item.composicaoValoresItem.lineReceiverAmountCents`)
      - `credito_receita_plataforma` (amountCents = `item.composicaoValoresItem.lineFeeAmountCents`)
    - `item.tipo === 'passthrough_surcharge'` → 1 lançamento:
      - `credito_passthrough_surcharge` (amountCents = `item.composicaoValoresItem.amountCents`)
    - Per-pagamento total lançamento count = `2 * (count of contribuicao items) + (count of passthrough_surcharge items)`.
    - The "+1 if cartao" branching at pagamento level **goes away** — replaced by uniform iteration over items.

13. **Bank-balance accounting:**
    - Bank balance = `SUM(credito_saldo_recebedor) + SUM(credito_receita_plataforma)` (filtered as needed for `transferidoEm` semantics; same predicates as 0015).
    - `credito_passthrough_surcharge` is **audit-only**. Represents money that flowed through to Stripe, never owned by the platform. Does NOT contribute to bank balance.
    - Worked example: contribution=100 + fee=10 + surcharge=5 → buyer pays 115 → Stripe takes 5 → bank receives 110. Owed to recebedor: 100. Earned revenue: 10. Total bank: 110. The `credito_passthrough_surcharge` lançamento exists for ledger reconciliation against Stripe payouts but is silent in every "what's in the bank" query.

14. **Not touched by this plan.** Listed explicitly so future readers don't infer scope from omission:
    - **Webhook handler FSM** — still operates on Pagamento as a whole (`pendente → processing → aprovado → estornado`). Doesn't care about items; items are an internal structure of the IntencaoPagamento child.
    - **RepasseRecebedor** — separate 2-state FSM (`solicitado → aprovado`) per aperture-s03dr. Item changes are invisible to it; it sweeps `LançamentoFinanceiro` rows by recebedor + tipo, doesn't care which item produced them.
    - **Cipher's open prod-gates** (aperture-haakf, aperture-wshvw, aperture-85n6u) — independent of this work; they live at the BetterAuth boundary, not the checkout boundary.
    - **BetterAuth integration** — orthogonal. The auth surface stays as plan 0010 / aperture-pgqih shipped it.

## Operator review locks (2026-06-08)

Following the operator + GLaDOS review pass after the first draft of this plan landed on PR #161, the 5 open questions from §Open questions were resolved and 4 plan-doc nits applied. They are locked alongside the original 14 decisions and not up for re-litigation.

**Open-question resolutions:**

15. **Postgres adapter shape: separate `intencao_items` table.** JSONB on `pagamentos` rejected — indexability for `quantidadeRestante`'s GROUP BY is required.

16. **Phase 0 migration is a pure drop.** No synthetic-row backfill for existing aprovado pagamentos on staging. Staging is throwaway; the drop is unconditional. The audit-preservation alternative considered in the first draft is gone.

17. **Saga rename to `iniciarPagamentoCarrinho` confirmed.** No `/** @deprecated */` re-export of `iniciarPagamentoContribuicao` — pure rename. (Aligns with nit C below.)

18. **Surcharge item is always last in the items array.** Insertion order: contribuição items first (in caller-provided order), surcharge item last when present. Mirrors Stripe's UI rendering of the processing fee.

19. **Domain event shape: drop `idContribuicao`, add `numeroDeItens` + `idsContribuicoes`.** `criarEventoPagamento` emits both — `numeroDeItens` as a top-level integer for cheap log-grep summaries, `idsContribuicoes` as the array of all contribuição ids the cart touched (excluding the surcharge item which has none). Empty surcharge-only carts can't exist per locked decision #7 (cart must have ≥ 1 contribuição item).

**Plan-doc nits applied:**

A. **Phase 0 pure drop.** The migration adds `quantidade`, adds the `intencao_items` table, drops the old `intencao_id_contribuicao` column + the per-pagamento composição columns + the asymmetric `surcharge_cents`. No synthetic-row insertion. Operator framing: *"no migration needed, all staging."*

B. **Phase 4 badge simplified to two states.** The plan's first draft proposed `DISPONÍVEL | PARCIAL | ESGOTADA` semantics. Operator collapses to:
   - When `quantidadeRestante > 0`: show `N/M` count only (e.g. `2/5`). No word badge.
   - When `quantidadeRestante <= 0`: show the literal word `ESGOTADA`. Overshoot cases (e.g. 6 sold against quantidade=5) still just say `ESGOTADA` — the operator cares that it's sold out, not how badly the count overshot.
   The two-state surface is enough. The three-state semantic carried unnecessary vocabulary.

C. **No backwards-compat re-export.** The first draft proposed keeping `contribuicaoEstaIndisponivel` as a `/** @deprecated */` thin re-export of `esgotada` for one release cycle. Greenfield staging means no external consumers — delete the old export outright at rename time.

D. **Phase 6 overshoot walk simplified.** First draft proposed an admin-manually-bypasses-tRPC-gate ceremony. Replaced with a clean backend integration test: race two tRPC mutations against the same last-slot in a `Promise.all` + assert both pagamentos land `aprovado` + `quantidadeRestante` returns negative. Same proof, no theater.

**Ownership note — Phase 4 → Vance.** Phase 4 (admin UI reshape) is a Vance bead. Spec defines the data contract (DTO shape, badge predicate, item-row data); Vance owns the visual treatment (badge styling, multi-item card layout, composição-aggregate display). Vance can start design work against the plan's draft contracts before Rex's Phase 2 lands, but Phase 4 ships only after the tRPC contract is stable from Phase 2.

## DDD concepts this plan teaches

1. **Symmetry between domain model and external system.** Stripe represents a checkout as a sequence of `line_items`. Modeling the domain that way (each item with its own composição snapshot) lets the Stripe-side rendering match the domain-side ledger 1:1 without translation. The pre-0016 asymmetric `surchargeCents` field forced a custom "explain the extra row" branch in every consumer; the post-0016 shape is uniform iteration.

2. **Cardinality is a field, not a row.** The "5 wine glasses" workaround duplicated identical rows to express stock count. The fix is to lift cardinality (`quantidade`) onto the slot. This is the same lesson plan 0015 taught about FSM state (don't store what you can compute) — here: don't duplicate what you can count.

3. **Derived predicates compose.** `esgotada(c)` is derived from `quantidadeRestante(c)`, which is itself derived from `SUM(item.quantidade WHERE pagamento.status='aprovado')`. The chain has no stored state at any link; it's all read-through. Same race-prone-mirror lesson plan 0015 carried — applied one level deeper now that items exist.

4. **Aggregate-internal nesting is fine.** `Pagamento → IntencaoPagamento → ItemDoPagamento[]` adds a level. This is OK because: (a) the aggregate consistency boundary stays at Pagamento; (b) ItemDoPagamento has no independent lifecycle (born + dies with its IntencaoPagamento); (c) the lançamento factory iterates over items but treats them as data, not as targets for use-cases. A new BC would be wrong here for the same reason Financeiro was demoted to a module in 0015 — no independent lifecycle, no separate ubiquitous language.

5. **Invariant placement.** Locked decision #8 enforces "items share `idCampanha`" at two layers (factory + use-case). The factory check is the honest backstop: any IntencaoPagamento that exists in the system is valid by construction. The use-case check exists for friendlier errors at the API boundary. This is the same pattern as the existing `totalPaidCents === SUM(items)` check that lives both at the SnapshotComposicaoValores schema validation AND inside `criarPagamentoPendente`.

6. **Open-set discriminator.** `tipo: 'contribuicao' | 'passthrough_surcharge'` is a discriminated union, room to extend without rewriting the iteration. Future tipos under consideration (out-of-scope today): `'discount'`, `'shipping'`, `'tip'`. Each would slot in with its own composição shape and its own lançamento factory branch — but only if a real need surfaces. Don't add `'discount'` speculatively; add it when an actual discount feature ships.

## Open items resolved

GLaDOS's dispatch flagged 5 open items I decide and document here. The answers shape Phase 1 / 2 work and need to be visible at review time.

### 1. Composição split per item (`SnapshotComposicaoValoresItem` shape)

**Decision:** discriminated union mirroring the item tipo.

```ts
// Per-item — contribuição shape
export const SnapshotComposicaoValoresItemContribuicaoSchema = z.object({
  tipo: z.literal('contribuicao'),
  idContribuicao: IdContribuicaoPagamentoSchema,
  quantidade: z.number().int().positive(),
  // Per-unit values (matches the contribuição's intrinsic price + fee math)
  contributionUnitAmountCents: MoneyCentsSchema, // = contribuicao.valor at intent-creation
  feeUnitAmountCents: MoneyCentsSchema,           // calculated by Taxas per unit
  receiverUnitAmountCents: MoneyCentsSchema,      // = contribution when responsavelTaxa=contribuinte
  // Per-line totals (per-unit × quantidade) — denormalised so the ledger
  // never has to recompute. Round-on-store, never round-on-aggregate.
  lineContributionAmountCents: MoneyCentsSchema,
  lineFeeAmountCents: MoneyCentsSchema,
  lineReceiverAmountCents: MoneyCentsSchema,
});

// Per-item — passthrough_surcharge shape
export const SnapshotComposicaoValoresItemSurchargeSchema = z.object({
  tipo: z.literal('passthrough_surcharge'),
  amountCents: MoneyCentsSchema, // total surcharge for the cart (single line)
});

export const SnapshotComposicaoValoresItemSchema = z.discriminatedUnion('tipo', [
  SnapshotComposicaoValoresItemContribuicaoSchema,
  SnapshotComposicaoValoresItemSurchargeSchema,
]);
```

The denormalised per-line totals (`line*AmountCents`) are stored alongside the per-unit values so consumers don't have to multiply at read time. The line values are the canonical "what hit the ledger"; the per-unit values are the audit trail. Validation invariant per contribuição item: `line* === unit* × quantidade` (exact; rounding happens before storage if at all).

At the IntencaoPagamento level, the existing `SnapshotComposicaoValores` (with `surchargeCents`, `feeAmountCents`, etc. at the root) is **replaced** by an aggregate snapshot that is the SUM of item lines:

```ts
export const SnapshotComposicaoValoresAggregateSchema = z.object({
  idCampanha: IdCampanhaSchema, // hoisted from items (all share)
  totalContributionCents: MoneyCentsSchema, // SUM lineContributionAmountCents across contribuicao items
  totalFeeCents: MoneyCentsSchema,           // SUM lineFeeAmountCents across contribuicao items
  totalReceiverCents: MoneyCentsSchema,      // SUM lineReceiverAmountCents across contribuicao items
  totalSurchargeCents: MoneyCentsSchema,     // amountCents of the single surcharge item (or 0)
  totalPaidCents: MoneyCentsSchema,          // = receiver + fee + surcharge (invariant)
  responsavelTaxa: ResponsavelTaxaPagamentoSchema, // unchanged ('contribuinte')
});
```

The book balance invariant at intent-creation: `totalReceiverCents + totalFeeCents + totalSurchargeCents === totalPaidCents` AND (when `responsavelTaxa === 'contribuinte'`) `totalReceiverCents === totalContributionCents`. Same shape as today's invariant in `validarComposicaoFinanceiraPagamentoAprovado`, just summed across items first.

### 2. Cart-construction validation surface

**Decision:** both layers, with different purposes.

- **`iniciarPagamentoCarrinho` use-case** (renamed from `iniciarPagamentoContribuicao` — see open item #3 below for the naming rationale): pre-validates the cart at the API boundary. Loads every item's contribuição, verifies all share `idCampanha`, throws `CarrinhoMultiplasCampanhasError` (HTTP 400 with a clean message) if not. This is the user-facing error.

- **IntencaoPagamento factory (`criarPagamentoPendente`)**: same check at construction time. Throws a plain Error (not domain-typed; this should never reach this layer in normal operation). This is the honest backstop — any IntencaoPagamento that exists in the DB is valid by construction. Same discipline as the existing `valorACobrarCents === composicaoValores.totalPaidCents` check.

The use-case check is reachable; the factory check is unreachable except via a programming bug. We keep both anyway because honest invariants at the entity boundary protect against any future caller (admin tooling, scripts, replay) that might bypass the use-case. Same reasoning that gives `SnapshotComposicaoValores` its zod schema — defense in depth.

### 3. Naming — surcharge tipo VO

**Decision:** asymmetric, as GLaDOS proposed in the dispatch:
- **Item tipo (new):** `'passthrough_surcharge'` — no `credito_` prefix. It's an item kind, describing what the buyer is paying for. Sibling of `'contribuicao'`.
- **Lançamento tipo (unchanged):** `'credito_passthrough_surcharge'` — `credito_` prefix. It's a ledger-entry kind, describing the financial movement. Sibling of `'credito_saldo_recebedor'` + `'credito_receita_plataforma'`.

The asymmetry is meaningful: items live in the checkout/intent vocabulary (what's the buyer purchasing?); lançamentos live in the ledger vocabulary (what direction is money moving?). Conflating them would force "credito_contribuicao" into the item-tipo enum, which doesn't describe an item — it describes the entry the item produces.

Bonus naming note: the `iniciarPagamentoContribuicao` saga becomes `iniciarPagamentoCarrinho`. The old name names a single contribution; the new shape names a cart. The renaming is small but worth doing in this plan to avoid the future `iniciarPagamentoContribuicao(input.items)` shape that lies about its own behavior. Old name kept as a one-release-cycle re-export with `/** @deprecated use iniciarPagamentoCarrinho */`.

### 4. Phase ordering

**Decision:** 6 phases, each with STOP for confirmation, mirroring 0015 in shape but tighter in scope.

- **Phase 0** — Migrations + schema surgery
- **Phase 1** — Entity surgery (Contribuição.quantidade + ItemDoPagamento + IntencaoPagamento reshape)
- **Phase 2** — Use-case rewrites (cart saga, lançamento factory, predicates)
- **Phase 3** — Webhook handler audit (no transitions change, but contribuinte projection now lands on the IntencaoPagamento root, not on a single item — verify)
- **Phase 4** — Admin UI reshape (`esgotada N/M` badge, multi-item pagamento card, lançamento grouping by item)
- **Phase 5** — Doc updates (CONTEXTS.md, ENGINE-DDD.md, ddd-conventions.md, plan 0015 cross-references)
- **Phase 6** — End-to-end live walks on staging

There's no Phase 7 separate from "live walks" in 0016 — the visitor cart UI is out-of-scope (see open item #5); admin walks are the only live verification surface.

### 5. Out-of-scope follow-ups

**Decision:** the following are real future work but explicitly do NOT ship with 0016. Each gets its own bead after this plan lands.

- **Item-level estorno granularity (v2).** Today's whole-pagamento estorno (locked decision #9) is the v1 contract. A future bead introduces partial-pagamento estorno (refund 2 of 5 glasses) with its own consistency model. Out of scope here because Stripe's refund API supports partial refunds but the lançamento cascade has no per-item rollback shape today.

- **Discount line-items.** A future bead can add `tipo='discount'` (negative-amount item, or signed) when a real discount feature is requested. The discriminated union accommodates it without breaking existing items.

- **Shipping line-items.** Same shape: `tipo='shipping'` with its own composição. Almost certainly never needed for digital gifts, but the door's open.

- **Visitor-side cart UI.** The frontend changes to let a visitor add multiple gifts to one checkout session are a separate frontend plan, owned by Vance. 0016 ships the backend cart model; the visitor still sees "one gift per checkout" until that frontend plan lands. The cart model is forward-compatible: a single-item cart is just a 2-item IntencaoPagamento (1 contribuicao + 1 surcharge for cartão) — same shape as today, just routed through the new factory.

- **Stripe `line_items` refinement.** Today's checkout-session-provider emits 1 line item per pagamento. Post-0016 it could emit N line items matching the domain items 1:1, making the buyer's Stripe receipt itemised. Bead-worthy follow-up but not required for the domain change to ship; admin UI itemisation works either way.

- **Admin UI for "ajustar quantidade na slot já vendida"** — an admin who wants to raise a slot's quantidade from 3 to 5 mid-event. The domain change (just edit the field) is trivial; the UI affordance and audit trail are not. Follow-up.

## Phases

Each phase ends with **STOP for confirmation**. Don't roll forward without explicit go.

### Phase 0 — Migrations + schema surgery

**Objective.** Add `quantidade` to `contribuicoes`. Add `intencao_items` table (or item columns under `pagamentos`, depending on the post-0015 persistence shape). Drop `intencao_id_contribuicao` and any single-item composição columns from `pagamentos`. Drop the asymmetric `surcharge_cents` field at the pagamento level.

**Files NEW:**

- `migrations/20260608_021_multi_item_pagamento_and_quantidade.ts` (number rounded to next free slot; verify against `migrations/` at branch time — last shipped was `20260603_019_collapse_state_machines.ts` + `_020` for the available_on column per the 0015 derived-liberação extension, so this is 021).

**Schema changes:**

- `contribuicoes`:
  - ADD `quantidade INTEGER NOT NULL DEFAULT 1` with `CHECK (quantidade >= 1)`. Default ensures the migration applies cleanly to existing rows without backfill.
- `pagamentos` (or `intencoes_pagamento` — verify shape post-0015; the IntencaoPagamento is currently flattened into `pagamentos` per `pagamento-repository.postgres.ts`):
  - DROP `intencao_id_contribuicao` (moves to per-item)
  - DROP the SnapshotComposicaoValores root columns that move to per-item:
    `intencao_contribution_amount_cents`, `intencao_fee_amount_cents`, `intencao_receiver_amount_cents`, `intencao_surcharge_cents`. Keep the aggregate columns that survive: `intencao_amount_cents` (= totalPaid; renamed `intencao_total_paid_cents` for clarity), `intencao_id_campanha` (NEW, hoisted from items).
  - ADD `intencao_total_contribution_cents BIGINT NOT NULL`, `intencao_total_fee_cents BIGINT NOT NULL`, `intencao_total_receiver_cents BIGINT NOT NULL`, `intencao_total_surcharge_cents BIGINT NOT NULL` (the aggregate snapshot — denormalised at intent-creation for read-path simplicity).
  - ADD `intencao_id_campanha UUID NOT NULL REFERENCES campanhas(id)` (the cart's recebedor scope).
- `intencao_items` (NEW table — items live in their own table since they're a 1:N collection child of IntencaoPagamento; flattening into JSONB on `pagamentos` is tempting but loses indexability for `quantidadeRestante`'s GROUP BY):
  ```sql
  CREATE TABLE intencao_items (
    id UUID PRIMARY KEY,
    id_pagamento UUID NOT NULL REFERENCES pagamentos(id) ON DELETE CASCADE,
    id_intencao_pagamento UUID NOT NULL, -- denormalised for direct lookup
    position INTEGER NOT NULL,            -- insertion order, stable for receipt rendering
    tipo TEXT NOT NULL CHECK (tipo IN ('contribuicao', 'passthrough_surcharge')),
    id_contribuicao UUID NULL REFERENCES contribuicoes(id),
    quantidade INTEGER NOT NULL CHECK (quantidade >= 1),
    -- composição (contribuicao tipo): all six fields NULL when tipo='passthrough_surcharge'
    contribution_unit_amount_cents BIGINT NULL,
    fee_unit_amount_cents BIGINT NULL,
    receiver_unit_amount_cents BIGINT NULL,
    line_contribution_amount_cents BIGINT NULL,
    line_fee_amount_cents BIGINT NULL,
    line_receiver_amount_cents BIGINT NULL,
    -- composição (passthrough_surcharge tipo): set when tipo='passthrough_surcharge', NULL otherwise
    surcharge_amount_cents BIGINT NULL,
    criado_em TIMESTAMPTZ NOT NULL,
    -- Discriminator integrity (DB-side backstop; entity also validates)
    CONSTRAINT intencao_items_contribuicao_shape CHECK (
      (tipo = 'contribuicao' AND id_contribuicao IS NOT NULL AND contribution_unit_amount_cents IS NOT NULL AND surcharge_amount_cents IS NULL)
      OR
      (tipo = 'passthrough_surcharge' AND id_contribuicao IS NULL AND surcharge_amount_cents IS NOT NULL AND contribution_unit_amount_cents IS NULL)
    ),
    UNIQUE (id_pagamento, position)
  );
  ```
- `lancamentos_financeiros`:
  - No schema change. The factory output rate per pagamento changes (`2 * N + S` instead of `2 + (1 if cartao)`), but the per-row shape is identical to today.
- Drop the partial index `pagamentos_aprovado_por_contribuicao_idx ON (intencao_id_contribuicao) WHERE status='aprovado'` (migration 019) — replaced by a query over `intencao_items` joined on aprovado pagamentos.

**Indexes (NEW):**

- `idx_intencao_items_contribuicao_aprovado ON intencao_items(id_contribuicao) INCLUDE (quantidade) WHERE id_contribuicao IS NOT NULL` — feeds the `quantidadeRestante` query, joined against `pagamentos.status='aprovado'`. Partial because surcharge items have no `id_contribuicao`.
- `idx_intencao_items_pagamento_position ON intencao_items(id_pagamento, position)` — feeds the per-pagamento item list for the lançamento factory + admin UI rendering.

**Verification:**

- `pnpm db:migrate` runs clean against a fresh DB.
- `psql -c "\d contribuicoes"` shows `quantidade INTEGER NOT NULL DEFAULT 1` with the positive CHECK.
- `psql -c "\d pagamentos"` shows the dropped composição columns gone, the aggregate ones present, `intencao_id_campanha` present.
- `psql -c "\d intencao_items"` shows the discriminator CHECK constraint enforced.
- `EXPLAIN ANALYZE` on the `quantidadeRestante` query (join intencao_items + pagamentos on aprovado) uses the new partial index.
- `pnpm db:codegen` regenerates `src/adapters/db-types.generated.ts` cleanly (no orphan references to dropped columns).

**STOP for confirmation.** Operator approves before Phase 1.

### Phase 1 — Entity surgery

**Objective.** Add `quantidade` to Contribuição. Introduce `ItemDoPagamento` entity + `SnapshotComposicaoValoresItem` VO. Reshape `IntencaoPagamentoSchema` to carry items + aggregate composição. Update `criarPagamentoPendente` factory to validate cart-construction invariants.

**Files MODIFIED:**

- `src/domain/arrecadacao/entities/contribuicao.ts`:
  - Add `quantidade: number` field to `Contribuicao` interface, default 1 at construction.
  - Update `criarContribuicao` signature to accept optional `quantidade` (defaults to 1).
  - Update `contribuicaoAtualizada` patch shape to accept optional `quantidade` (admin can raise/lower; lowering below current sold count is allowed — `quantidadeRestante` goes negative, `esgotada` returns true; matches locked decision #10).
  - Update header comment: drop the "no transitions, no contribuinte" framing (already true post-0015) and add the quantidade rationale.
- `src/domain/pagamentos/value-objects/snapshot-composicao-valores.ts`:
  - **DELETE** this file. The pagamento-level composição moves to two places: per-item (new VO) + aggregate (also new). The single-shape snapshot doesn't survive.
- `src/domain/pagamentos/value-objects/snapshot-composicao-valores-item.ts` (NEW):
  - `SnapshotComposicaoValoresItemContribuicaoSchema` + `SnapshotComposicaoValoresItemSurchargeSchema` + discriminated union (per open item #1).
  - `validarComposicaoItem(item)` helper: enforces per-unit × quantidade = per-line math (contribuição tipo) + non-negative surcharge.
- `src/domain/pagamentos/value-objects/snapshot-composicao-valores-aggregate.ts` (NEW):
  - `SnapshotComposicaoValoresAggregateSchema` (per open item #1).
  - `validarComposicaoAggregate(aggregate, items)` helper: enforces sum-of-items === aggregate fields + book balance invariant.
- `src/domain/pagamentos/entities/item-do-pagamento.ts` (NEW):
  - `ItemDoPagamentoSchema` discriminated union:
    ```ts
    export const ItemDoPagamentoContribuicaoSchema = z.object({
      id: IdItemDoPagamentoSchema,
      tipo: z.literal('contribuicao'),
      idContribuicao: IdContribuicaoPagamentoSchema,
      quantidade: z.number().int().positive(),
      composicaoValoresItem: SnapshotComposicaoValoresItemContribuicaoSchema,
      criadoEm: z.date(),
    });
    export const ItemDoPagamentoPassthroughSurchargeSchema = z.object({
      id: IdItemDoPagamentoSchema,
      tipo: z.literal('passthrough_surcharge'),
      idContribuicao: z.null(),
      quantidade: z.literal(1),
      composicaoValoresItem: SnapshotComposicaoValoresItemSurchargeSchema,
      criadoEm: z.date(),
    });
    export const ItemDoPagamentoSchema = z.discriminatedUnion('tipo', [
      ItemDoPagamentoContribuicaoSchema,
      ItemDoPagamentoPassthroughSurchargeSchema,
    ]);
    ```
  - `criarItemContribuicao(input)` + `criarItemPassthroughSurcharge(input)` factories — each enforces its discriminator constraint.
- `src/domain/pagamentos/value-objects/ids.ts`:
  - ADD `IdItemDoPagamento` + `IdItemDoPagamentoSchema` (UUID).
- `src/domain/pagamentos/entities/pagamento.ts`:
  - Reshape `IntencaoPagamentoSchema`:
    - REMOVE `idContribuicao` from the root (moves to per-item).
    - REMOVE `composicaoValores: SnapshotComposicaoValoresSchema` (replaced by aggregate + items below).
    - REMOVE `amountCents` (replaced by `composicaoValoresAggregate.totalPaidCents`).
    - ADD `idCampanha: IdCampanhaSchema` (the cart-scope invariant carrier).
    - ADD `items: z.array(ItemDoPagamentoSchema).min(1)` (a cart must have at least 1 item).
    - ADD `composicaoValoresAggregate: SnapshotComposicaoValoresAggregateSchema`.
    - KEEP everything else verbatim (`id`, `externalRef`, `paymentIntentExternalRef`, `chargeExternalRef`, `contribuinte`, `balanceTransactionAvailableOn`, `criadaEm`).
  - Update `criarPagamentoPendente`:
    - Input shape: `{ idPagamento, idIntencaoPagamento, idCampanha, items, composicaoValoresAggregate, valorACobrarCents, metodo, criadoEm, externalRef? }`.
    - Drops `composicaoValores` from input (now `composicaoValoresAggregate`).
    - Adds cart-construction validation: `validarComposicaoAggregate(aggregate, items)`; `items.length >= 1`; all `tipo='contribuicao'` items have `quantidade >= 1`; at most one `tipo='passthrough_surcharge'` item; if surcharge item present then `aggregate.totalSurchargeCents === surcharge.amountCents`, else `aggregate.totalSurchargeCents === 0`.
    - Keeps `valorACobrarCents === composicaoValoresAggregate.totalPaidCents` check verbatim.
  - Update `criarEventoPagamento`: drop `idContribuicao` from emission (was sourced from `intencao.idContribuicao`, no longer present at root). Replace with three fields per §Operator review locks #19: `idCampanha` (single, hoisted from items), `numeroDeItens` (count of items in the cart, top-level integer for cheap log-grep summaries), `idsContribuicoes` (array of contribuição ids the cart touched — surcharge items have none so they don't contribute). The event-publisher contract changes; downstream subscribers updated in Phase 2.
- `src/domain/pagamentos/financeiro/value-objects/snapshot-composicao-valores-financeiro.ts`:
  - REMOVE `surchargeCents` from the root snapshot (it's now per-item).
  - Restructure as the financeiro-side mirror of the new per-item shape (it currently mirrors `SnapshotComposicaoValores`; needs to mirror the new per-item + aggregate split).
  - Verify: the financeiro snapshot is only consumed by `validarComposicaoFinanceiraPagamentoAprovado` and `criarLancamentosParaPagamentoAprovado` (Phase 2 work).

**Files NEW (already listed above — collated here for the impl plan's check):**

- `src/domain/pagamentos/value-objects/snapshot-composicao-valores-item.ts`
- `src/domain/pagamentos/value-objects/snapshot-composicao-valores-aggregate.ts`
- `src/domain/pagamentos/entities/item-do-pagamento.ts`

**Files DELETED:**

- `src/domain/pagamentos/value-objects/snapshot-composicao-valores.ts`

**Verification:**

- `pnpm typecheck` — fails predictably on all the consumers of the old shape (every use-case that touches `intencao.idContribuicao` or `intencao.composicaoValores`). Those failures get fixed in Phase 2.
- Domain tests (`tests/unit/pagamentos/`) red on the schema reshape — also fixed in Phase 2.
- New unit tests for `criarItemContribuicao`, `criarItemPassthroughSurcharge`, `validarComposicaoItem`, `validarComposicaoAggregate`. Cart-construction failure cases enumerated: zero items, multiple campanhas, multiple surcharge items, surcharge with non-1 quantidade, aggregate mismatch.

**STOP for confirmation.**

### Phase 2 — Use-case + factory rewrites

**Objective.** Update the saga, the lançamento factory, the indisponivel predicate (now `quantidadeRestante` + `esgotada`), and the persistence adapters to match the new shape.

**Files MODIFIED:**

- `src/use-cases/checkout/iniciar-pagamento-contribuicao.ts` → rename to `src/use-cases/checkout/iniciar-pagamento-carrinho.ts`:
  - Input shape changes:
    ```ts
    export const IniciarPagamentoCarrinhoInputSchema = z.object({
      idPlataforma: IdPlataformaReferenciaSchema,
      idCampanha: IdCampanhaSchema,
      itens: z.array(z.object({
        idContribuicao: IdContribuicaoSchema,
        quantidade: z.number().int().positive(),
      })).min(1),
      metodo: MetodoPagamentoSchema,
      idPagamento: IdPagamentoSchema,
      idIntencaoPagamento: IdIntencaoPagamentoSchema,
      idsItens: z.array(IdItemDoPagamentoSchema).min(1), // caller-controlled, one per item input + one if cartao
      returnUrl: z.string().trim().min(1).max(2000),
      redirectOnCompletion: z.enum(['always', 'if_required', 'never']).optional(),
    });
    ```
    Caller threads through `idsItens` for the contribuição items + (if cartão) one more id for the surcharge item, in insertion order. Same convention as the existing caller-controlled UUID pattern.
  - Saga steps:
    1. Plataforma membership check (unchanged).
    2. Load all contribuições (one query: `findManyByIds`). Verify they all belong to `input.idCampanha` (the cart-construction invariant at the application layer). Throw `CarrinhoMultiplasCampanhasError` (NEW) if any mismatch; `ArrecadacaoContribuicaoNaoEncontradaError` if any missing.
    3. UX gate (per-item `esgotada` check). The existing `contribuicaoEstaIndisponivel` saga step is replaced by a per-item `esgotada` check. If any contribuição in the cart is already esgotada, throw `ArrecadacaoContribuicaoIndisponivelError` (keep the error type; rename considered but the existing API contract uses it). Same locked-decision-#10 UX disclaimer applies: this is a courtesy, not a correctness check.
    4. Compute composição per item via `calcularComposicaoValoresParaItem` (NEW use-case in `taxas/`, see below). Each contribuição item produces a `SnapshotComposicaoValoresItemContribuicao`. If `metodo === 'credit_card'`, also compute the aggregate surcharge for the cart's total contribution amount; produce a single `SnapshotComposicaoValoresItemSurcharge` item.
    5. Build `composicaoValoresAggregate` (sum across items per open item #1).
    6. `checkoutSessionProvider.criarSessaoCheckout` — pass through the aggregate `totalPaidCents` (provider sees the cart's total; line-item itemisation against Stripe is out-of-scope follow-up, see locked decisions #14 + open item #5).
    7. `criarIntencaoPagamento(deps, { items, composicaoValoresAggregate, ... })` — feeds the reshaped factory.
  - Compensation: still trivial (no contribuição claim). Failure at any step is a thrown error; orphan Stripe sessions self-expire.
- `src/use-cases/pagamentos/criar-intencao-pagamento.ts`:
  - Input shape mirrors `criarPagamentoPendente` (new items + aggregate fields). Drops `composicaoValores`, adds `items` + `composicaoValoresAggregate` + `idCampanha`.
- `src/use-cases/taxas/calcular-composicao-valores.ts` → keep but **adjust scope**. Today's use-case computes a single `SnapshotComposicaoValores` for one (contribuição, metodo) pair. Post-0016:
  - Rename to `calcularComposicaoValoresParaItem` (computes the per-item snapshot for one contribuição item).
  - Per-unit math: fee per unit + receiver per unit, then × quantidade for the per-line denormalised fields.
  - Surcharge handling moves out: this use-case no longer touches `surchargeCents`. The surcharge is computed once per cart (against the aggregate contribution total) by a sibling use-case `calcularSurchargeParaCarrinho` (NEW) that returns a single `SnapshotComposicaoValoresItemSurcharge`. The saga calls both.
- `src/use-cases/arrecadacao/contribuicao-esta-indisponivel.ts` → rename to `src/use-cases/arrecadacao/quantidade-restante.ts`:
  - Export `quantidadeRestante(input): Promise<number>` and sibling `esgotada(input): Promise<boolean>` (derived: `quantidadeRestante(input) <= 0`). Per operator review nit C, NO backwards-compat alias for the old `contribuicaoEstaIndisponivel` name — delete the export outright. Greenfield staging, no external consumers. All callers in `src/` and `apps/eunenem-server/` updated in the same commit.
  - Query: `SUM(intencao_items.quantidade) WHERE intencao_items.id_contribuicao = X AND intencao_items.tipo='contribuicao' AND pagamentos.status='aprovado'`. Subtracted from `contribuicoes.quantidade` to give `quantidadeRestante`.
  - Repository method: `pagamentoRepository.findIdsContribuicoesComPagamentoAprovado(ids)` retires. Replaced by `pagamentoRepository.somarQuantidadesContribuicoesEmPagamentosAprovados(ids): Map<IdContribuicao, number>`. Returns 0 for any id with no aprovado items.
- `src/use-cases/checkout/estornar-pagamento.ts`:
  - Stripe refund call refunds the entire `composicaoValoresAggregate.totalPaidCents` (unchanged in semantics — it always refunded the full pagamento).
  - Pre-transfer guard unchanged.
  - Cascade unchanged — `canceladoEm` set on every lançamento for the pagamento.
- `src/domain/pagamentos/financeiro/entities/lancamento-financeiro.ts`:
  - `EfeitosFinanceirosPagamentoAprovado` input shape changes:
    ```ts
    export interface EfeitosFinanceirosPagamentoAprovado {
      readonly idPagamento: IdPagamentoReferencia;
      readonly idCampanha: IdCampanha;
      readonly statusPagamento: StatusPagamentoFinanceiro;
      readonly items: readonly ItemDoPagamentoFinanceiro[]; // financeiro mirror
    }
    ```
    `idContribuicao` retires from the root (now per-item).
  - `IdsLancamentosFinanceiros` retires. Replaced by per-item ID arrays:
    ```ts
    export interface IdsLancamentosPorItem {
      readonly itemId: IdItemDoPagamento;
      readonly idLancamentoRecebedor?: IdLancamentoFinanceiro;       // contribuicao tipo only
      readonly idLancamentoReceitaPlataforma?: IdLancamentoFinanceiro; // contribuicao tipo only
      readonly idLancamentoPassthroughSurcharge?: IdLancamentoFinanceiro; // surcharge tipo only
    }
    export type IdsLancamentosFinanceirosPorPagamento = readonly IdsLancamentosPorItem[];
    ```
  - `criarLancamentosParaPagamentoAprovado`:
    - Iterate over `input.items`, emit per-item lançamentos per locked decision #12.
    - `validarComposicaoFinanceiraPagamentoAprovado` updated to validate aggregate-level invariants (sum of items === aggregate; receiver === contribution per item; surcharge non-negative).
    - Book-balance invariant: `SUM(amountCents across all returned lançamentos) === composicaoValoresAggregate.totalPaidCents` for any path (pix = 2N rows, cartão = 2N + 1 rows).
- `src/use-cases/pagamentos/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.ts`:
  - Takes the new input shape (per-item composição, per-item ID list). Threads through to the factory.
  - The id-generation pattern in callers: each item gets its own UUID(s) at the same point in the lifecycle as today (random UUIDs generated in the use-case caller, threaded as `idsLancamentos`).
- `src/use-cases/pagamentos/financeiro/obter-saldo-recebedor.ts`:
  - No change to the SQL — already sums by `recebedor_id + tipo` ignoring per-item structure. The factory output now produces more rows per pagamento (2N + S instead of 2 + cartao branch), but the per-row shape is identical. Verify with a re-run of the existing balance test against a fixture with multi-item pagamentos.

**Files NEW:**

- `src/errors/checkout/carrinho-multiplas-campanhas.error.ts`:
  - `CarrinhoMultiplasCampanhasError` — thrown when the cart contains items from different campanhas.
- `src/use-cases/taxas/calcular-surcharge-para-carrinho.ts`:
  - Computes the single surcharge item for a cart (total contribuição × Stripe Brazil card rate). Returns `SnapshotComposicaoValoresItemSurcharge | null` (null for pix).

**Files DELETED:**

- (None at this phase; the `snapshot-composicao-valores.ts` file deleted in Phase 1 covers the only removal.)

**Verification:**

- `pnpm test` green — all use-case unit tests pass.
- New tests covering: multi-item cart construction (happy + failure cases per the locked invariants), `quantidadeRestante` with various item counts + statuses (`pendente`/`processing` don't count; `aprovado` does), per-item lançamento emission counts (1 contribuição → 2 lançamentos; 1 contribuição + 1 surcharge → 3; 3 contribuição + 1 surcharge → 7), book-balance invariant on each path.
- Conformance-suite update: the `PagamentoRepository` shared conformance gains tests for `somarQuantidadesContribuicoesEmPagamentosAprovados` (memory + postgres parity).

**STOP for confirmation.**

### Phase 3 — Webhook handler audit

**Objective.** The webhook handler operates on Pagamento as a whole (per locked decision #14). It doesn't transition items; items don't transition. But two surfaces need verification:

1. **Contribuinte projection**: `checkout.session.completed` writes `intencao.contribuinte` from `custom_fields` + `customer_details`. The contribuinte lives at `IntencaoPagamento` root (per plan 0015 / aperture-7pqee), not on any item — confirmed by the entity reshape (Phase 1 kept the root `contribuinte` field). The handler logic doesn't change.

2. **Event-publisher contract**: `criarEventoPagamento` previously emitted `idContribuicao` (sourced from `intencao.idContribuicao`); Phase 1 replaced it with `idCampanha`. Verify all downstream subscribers (event-publisher adapters, observability emissions, audit log writes) match the new shape. Grep is sufficient: `grep -r 'evento.idContribuicao\|event.idContribuicao' src/ apps/eunenem-server/` should return zero hits in src/ post-Phase-1.

**Files MODIFIED:**

- (None expected — this phase is verification-only. If a downstream subscriber relies on the old `idContribuicao` event field, fix it here.)

**Verification:**

- `grep -r 'idContribuicao' src/adapters/webhook-archive/` returns hits only where the handler reads contribuinte data from Stripe (`custom_fields`), not from the event shape.
- Existing webhook tests still green (handler logic unchanged).
- One new test: post-checkout-session-completed, verify the contribuinte landed on `IntencaoPagamento.contribuinte` regardless of item count.

**STOP for confirmation.**

### Phase 4 — Admin UI reshape (Vance owns)

**Objective.** Update the eunenem-server admin surfaces that today assume single-contribuição-per-pagamento + boolean `indisponivel` to surface multi-item pagamentos + the new `N/M` count or `ESGOTADA` badge.

**Ownership.** This phase is Vance's. The bullets below define the data CONTRACT — DTO shape, badge predicate, item-row data. The visual treatment (badge styling, item-row layout, composição-aggregate display, typography of the count) is Vance's design call against the contract. She can start visual design work against the draft contracts before Rex's Phase 2 lands (parallel track), but Phase 4 ships only after Phase 3 closes (per the blocked-by chain) so the underlying tRPC contract is stable.

**Surfaces affected:**

1. **`/admin/contribuicao/:id` detail page** (the DDD-trace view from plan 0015 Phase 6):
   - **Arrecadação card** — the badge that today shows `DISPONIVEL | INDISPONIVEL` becomes a two-state surface (operator review nit B):
     - When `quantidadeRestante > 0`: show only the count `N/M` (e.g. `2/5`). No word label.
     - When `quantidadeRestante <= 0`: show the literal word `ESGOTADA`. Overshoot cases (e.g. 6 sold against quantidade=5) still just say `ESGOTADA`.
   - The badge query: one `quantidadeRestante` call + the contribuição's static `quantidade`.
   - Visual treatment (colour, typography, spacing of the count display) is Vance's call — the data contract is fixed, the visual surface is hers.

2. **Pagamentos card** — each pagamento entry today shows a single contribuinte block + single composição. Post-0016 each pagamento has N items; the card shows them as a sub-list:
   ```
   [status badge] [totalPaid] [criado em]
   MÉTODO: cartão / pix
   EXTERNAL REFS: cs_xxx... | pi_xxx... | ch_xxx...
   CONTRIBUINTE: name + email + recadinho  (from intencao.contribuinte — pagamento-level)

   ITENS:
   - [contribuição nome] × N → contribution: X, fee: Y, receiver: X
   - [contribuição nome] × M → contribution: X, fee: Y, receiver: X
   - [TAXA DE PROCESSAMENTO CARTÃO] → surcharge: X         (only when cartão)

   COMPOSIÇÃO AGREGADA:
     total contribution + total fee + total surcharge = total paid
     net to recebedor: <total receiver>
   ```

3. **Financeiro card** — lançamentos already render per-row with `tipo + amountCents`. Post-0016 there are more rows per pagamento (2N + S instead of 2 or 3). Visual grouping by `id_pagamento` already exists per plan 0015 Phase 6 work (aperture-joeh9 — `LancamentosBlock` collapsable group). The new shape fits naturally; each item produces its 2 or 1 lançamentos under the same pagamento header.

4. **Admin pagamentos list** (`/admin/repasses`, `/admin/contribuicao/:id` Pagamentos card list view):
   - Sort/filter unchanged (status, criado em).
   - Tooltip on hover now lists the cart's item count + first item's contribuição name + "... + N more" for multi-item carts.

5. **Visitor "buy this gift" flow** — **OUT OF SCOPE for 0016**. The visitor still sees one gift per checkout until the frontend cart plan lands (out-of-scope follow-up #5). Validation: the single-item cart path is forward-compatible — the visitor's "click gift → checkout" produces a 2-item IntencaoPagamento (1 contribuição + 1 surcharge for cartão) handled by the same factory.

**Files MODIFIED (under apps/eunenem-server):**

- Admin contribuição detail page server-side renderer + read-DTO query (locate via `grep -r 'admin/contribuicao' apps/eunenem-server/src`).
- Read-side query helper that today reads `pagamento.intencao.idContribuicao` for the admin pagamentos card → switch to iterating `pagamento.intencao.items`.
- Status-badge component used in the Arrecadação card — re-wire to `quantidadeRestante`/`esgotada`.
- DTO projection layer: `PagamentoAdminDTO` gains `items: ItemDoPagamentoAdminDTO[]`; the per-item DTO carries `tipo`, optional `idContribuicao` + `contribuicaoNome` (joined for display), `quantidade`, per-line composição.

**Verification:**

- Visual walk of `/admin/contribuicao/<seeded-id>` with each of: a 1-item single-quantidade pagamento, a 1-item multi-quantidade pagamento (e.g. quantidade=3), a multi-item single-quantidade cart, a multi-item multi-quantidade cart. All four render the items block, the aggregate composição, and the per-pagamento contribuinte correctly.
- The Arrecadação badge updates correctly across all four states (DISPONÍVEL, PARCIAL, ESGOTADA, ESGOTADA-overshoot).
- Type-check passes (TS sees no `intencao.idContribuicao` reads in admin code).

**STOP for confirmation.** Operator visual walk required.

### Phase 5 — Doc updates

**Objective.** Bring the conceptual docs into alignment with the multi-item shape. The Plan 0015 doc updates landed in Atlas's PR #160 — this phase builds on that, doesn't redo it.

**Files MODIFIED:**

- `CONTEXTS.md`:
  - In the **BC Arrecadação** section: update the Contribuição shape paragraph to reflect `quantidade: number`. The "slot puro" framing stays — quantidade is part of the slot's intrinsic shape, not a state.
  - Add a paragraph: "uma slot com quantidade > 1 representa N exemplares fungíveis da mesma coisa (5 taças de vinho, 12 convites VIP). O badge 'esgotada' é derivado da soma de quantidades em pagamentos aprovados."
  - In the **BC Pagamentos** section: add ItemDoPagamento to the conceito-map (under "Entidades dentro do agregado"). Note the discriminated union shape.
  - In the **Módulo Financeiro** section: update the lançamento-emission table — uniform per-item iteration replaces the cartão branch.

- `ENGINE-DDD.md`:
  - Section on Pagamento aggregate: add ItemDoPagamento as a child of IntencaoPagamento (nesting level deeper than today).
  - Section on cross-BC mirror VOs: no changes (the existing IdCampanha mirror handles the cart's idCampanha invariant).
  - Section on derived state vs stored state: extend with `esgotada` / `quantidadeRestante` as the new exemplar (alongside the existing `transferidoEm`/`canceladoEm` from 0015).

- `plans/README.md`:
  - Add row for 0016 in the table.
  - Update dependency graph: 0016 depends on 0015 (Pagamento aggregate post-FSM-collapse is the substrate) + 0013 (surcharge field is inherited from there).

- `plans/0015-contribuicao-pagamento-financeiro-collapse.md`:
  - Add a "**Subsequent work**" cross-reference at the top pointing to 0016 — items + quantidade is a natural follow-on once the FSM collapse landed.

- `plans/0013-provider-fee-passthrough.md`:
  - Append a note in the "Subsequent work" section: the asymmetric `surchargeCents` field introduced here retires in 0016, replaced by `tipo='passthrough_surcharge'` item.

- `docs/ddd-conventions.md`:
  - Section on "aggregate nesting": add an example of three-level nesting (`Pagamento → IntencaoPagamento → ItemDoPagamento[]`) and the rationale (items have no independent lifecycle, no separate ubiquitous language — they're data inside the aggregate).
  - Section on naming conventions: add the `ItemDoPagamento` rationale — the `Do` connector is deliberate (real entity inside the aggregate), distinguishing from the existing no-connector VOs (`EventoPagamento`, `MetodoPagamento`, `IntencaoPagamento`).

- `docs/idempotency-and-concurrency.md`:
  - Update the optimistic-CC paragraph: same overshoot-accepted shape from plan 0015 carries forward, just applied per-item now (`quantidadeRestante` can go negative; operator-accepted +money outcome).

**Verification:**

- All affected docs reviewed inline by operator.
- `grep -rE 'contribuicaoEstaIndisponivel|surchargeCents' docs plans CONTEXTS.md ENGINE-DDD.md` returns hits only in `-superseded` files or behind `/** @deprecated */` re-exports.

**STOP for confirmation.**

### Phase 6 — End-to-end live walks

**Objective.** Validate the redesign on staging (`eunenem.xeroxtoxerox.com`) with both shipped payment metodos. Apply the `verify-user-path` skill discipline: Layer A (URL opens), Layer B (action performed), Layer C (network response correct), Layer D (DB row + audit event match).

Because the visitor-side cart UI is out-of-scope (#5), all walks are exercised via the admin's seeded "create pagamento" surface OR direct tRPC mutations using the existing single-gift visitor flow (which post-0016 routes through the new multi-item factory with a 2-item cart). The single-item path is the regression surface; the multi-item path is exercised by seeded fixtures + admin-tool surfaces only.

**Walks:**

1. **Card happy path — single gift (regression).** Visitor clicks one gift → IntencaoPagamento born with 1 contribuição item + 1 surcharge item → cartão flow → `charge.succeeded` → pagamento `aprovado` → 3 lançamentos (recebedor + receita + passthrough_surcharge). Admin contribuição detail page shows `PARCIAL — 1/M` (or `ESGOTADA — 1/1` if quantidade was 1).

2. **Pix happy path — single gift (regression).** Same shape, 2 lançamentos (no surcharge), passes through `processing` state.

3. **Card multi-item cart — seeded.** Seeded fixture creates a 3-item cart (2 different contribuições × quantidade=2 each + 1 surcharge) → admin-tool mutation drives it through aprovado → verify 5 lançamentos (4 contribuição lançamentos: 2 per contribuição-item × 2 items + 1 passthrough_surcharge).

4. **Quantidade-restante partial state.** A contribuição with quantidade=5, two pagamentos aprovados consuming quantidade=2 each → admin page shows the count `4/5`, `esgotada = false`. Saga's `iniciarPagamentoCarrinho` accepts a third request for quantidade=1.

5. **Quantidade-restante esgotada state.** Same contribuição, third pagamento aprovado consuming quantidade=1 → `quantidadeRestante = 0`, `esgotada = true`. Admin page shows the literal word `ESGOTADA`. Saga's `iniciarPagamentoCarrinho` UX-gates further attempts with `ArrecadacaoContribuicaoIndisponivelError`.

6. **Overshoot accepted (backend integration test, not live walk).** Per operator review nit D, this scenario is a backend integration test rather than a live admin walk. The test races two `iniciarPagamentoCarrinho` tRPC mutations against the same last-slot via `Promise.all`, asserts both complete `aprovado`, and verifies `quantidadeRestante` returns negative. Same proof of the locked-decision-#10 behaviour as the original draft proposed, without the admin-tool theatrics. The admin page subsequently shows `ESGOTADA` (no overshoot count surfaced in the two-state badge per nit B).

7. **Estorno on multi-item pagamento.** The 3-item cart from walk 3 → admin clicks "estornar" → endpoint validates no lançamento has `transferidoEm` → Stripe refund fires for full `totalPaidCents` → pagamento `estornado` + all 5 lançamentos get `canceladoEm` → both consumed contribuições return to their pre-pagamento `quantidadeRestante`.

**Done definition.**

- All 7 walks pass on staging.
- No FSM-transition errors in Loki / observability.
- Admin UI surfaces the multi-item shape + the new badge correctly.
- `plans/README.md` updated with 0016 row.
- Atlas-style docs updates landed (CONTEXTS.md + ENGINE-DDD.md updated; `docs/ddd-conventions.md` extended).
- Follow-up beads filed for: (1) item-level estorno granularity, (2) visitor-side cart UI (Vance frontend plan), (3) Stripe line_items refinement, (4) admin "ajustar quantidade na slot já vendida" affordance.

## Open questions

(All 5 first-draft open questions were resolved in the operator review pass — see §Operator review locks (2026-06-08) above. This section is intentionally empty as of the second draft.)

## Out of scope

- Item-level estorno granularity (refund 2 of 5 glasses)
- Discount line-items (`tipo='discount'`)
- Shipping line-items (`tipo='shipping'`)
- Visitor-side cart UI (Vance's separate frontend plan)
- Stripe `line_items` itemisation against domain items 1:1 (the buyer's Stripe receipt stays single-line until that follow-up bead)
- Admin UI for "ajustar quantidade na slot já vendida" mid-event (the domain change is trivial — `contribuicaoAtualizada` already supports the patch; the affordance and audit trail are a separate UX pass)
- Reconciliation tooling for the overshoot-accepted scenario (operator-acceptable per locked decision #10)
- Mobile app changes (no mobile app today; same as 0015)
- Plataforma-tier data migration

Each of these gets its own bead after this plan lands.

## Companion docs (post-Phase-5)

- [`CONTEXTS.md`](../CONTEXTS.md) — Contribuição section gains `quantidade`; Pagamentos section gains ItemDoPagamento under IntencaoPagamento; Financeiro section gets the per-item emission table.
- [`ENGINE-DDD.md`](../ENGINE-DDD.md) — Pagamento aggregate nesting deepens by one level.
- [`../docs/ddd-conventions.md`](../docs/ddd-conventions.md) — adds the `ItemDoPagamento` naming rationale + the three-level aggregate nesting example.
- [`0015-contribuicao-pagamento-financeiro-collapse.md`](./0015-contribuicao-pagamento-financeiro-collapse.md) — gains a "Subsequent work" cross-link to 0016.
- [`0013-provider-fee-passthrough.md`](./0013-provider-fee-passthrough.md) — gains a note that the asymmetric `surchargeCents` field retires in 0016.
