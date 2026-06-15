# Plan 0013 — Provider fee passthrough

> 📌 **Addendum 2026-06-03 — light revision pending after [0015](./0015-contribuicao-pagamento-financeiro-collapse.md).**
>
> Two references in this plan reflect the pre-0015 lançamento model and will be reconciled in 0013's implementation cycle (not in 0015 Phase 5's scope):
>
> 1. The interaction with 0006 (`maturacao-regra.ts`, `maturaEm`) is **moot** — 0006 is superseded. Lançamentos no longer carry `maturaEm`; the implicit "disponivel" state is now the predicate `transferidoEm IS NULL AND canceladoEm IS NULL` per 0015 §Locked-decision 9. The Phase reference below that says "passthrough lancamento born already disponivel (or with `maturaEm = criadoEm`)" should read "passthrough lancamento born with `transferidoEm: null, canceladoEm: null` — same as every other lançamento, no per-tipo maturation rule."
> 2. The interaction with 0012 (chargeback fee passthrough loss) is now part of 0012's narrower chargeback-only scope — see 0012 §Locked-decision 6 (new) and §Q7. Plan 0013 introduces the `credito_reembolso_taxa_provedor` lançamento tipo; plan 0012 introduces the loss row when the chargeback unrecovers it.
>
> The rest of this plan (the 3-part composition, the per-plataforma policy framing, the receita-vs-passthrough double-entry discipline) is unaffected by 0015. Treat the Phase-by-Phase implementation steps as currently-drafted but verify against the post-0015 lançamento shape before coding.
>
> ---
>
> 📌 **Addendum 2026-06-08 — surcharge field retires in [0016](./0016-multi-item-pagamento-and-quantidade.md).**
>
> The asymmetric surcharge field at `SnapshotComposicaoValores` (introduced by aperture-uyw8i as part of 0013's implementation) **retires** in plan 0016. Per 0016 §Locked-decision 11 ("Surcharge as item (Option C)"), the card-passthrough surcharge is now its own `ItemDoPagamento` with `tipo='passthrough_surcharge'`, modeled symmetrically with contribuição items inside the cart. The 3-part composition discipline this plan teaches survives — it's just expressed per-line + aggregated, instead of stamped on a single pagamento-level snapshot.
>
> Concretely after 0016: the line-item discipline (contribution / fee / surcharge as distinct money buckets) and the `credito_passthrough_surcharge` lançamento tipo (the double-entry side) both stand. What changes is *where the surcharge value lives* — it's a `tipo='passthrough_surcharge'` `ItemDoPagamento.composicaoValoresItem.amountCents` rather than `SnapshotComposicaoValores.surcharge*` at the intent root. The book-balance invariant updates from per-pagamento totals to sum-of-items totals (`totalReceiverCents + totalFeeCents + totalSurchargeCents === totalPaidCents` in the aggregate snapshot).
>
> ---
>
> **Status**: drafted 2026-05-24, awaiting confirmation. **Many decisions deliberately left open** — see "Open questions to answer before phases start" below. Don't begin implementation until those are resolved.
> **Depends on**: plan `0002-checkout-orchestration-layer-done.md` (existing `ComposicaoValores` is the extension point), plan `0009-plataforma-management-and-admin-ux.md` (versioned RegraTaxa pattern — `RegraTaxaProvedor` mirrors it; if 0009 hasn't shipped yet, this plan introduces versioning standalone).
> **Interacts with**: ~~plan `0006-lancamento-maturation-rule.md`~~ (superseded — see addendum), plan `0012-estorno-and-chargeback-cascade.md` (chargebacks usually don't refund the provider's fee — plataforma eats the passthrough on estorno; rescoped by 0015 — see addendum).

## Goal

Today the contribuinte's total is a 2-part composition:

```
R$80 (recebedor's slice)  +  R$4 (plataforma tarifa)  =  R$84 total
```

That `R$4` is plataforma's *receita* — pure margin. But credit-card pagamentos cost the plataforma real money (Stripe ~3.99% + R$0.39 per cartão transaction in Brazil; pix ~free; boleto ~R$3 fixed). Today those provider fees are absorbed silently by the plataforma. This plan turns them into an **explicit third slice** paid by the contribuinte and earmarked in Financeiro:

```
R$80 (recebedor)  +  R$4 (plataforma tarifa)  +  R$3.50 (provider passthrough)  =  R$87.50 total
```

The R$3.50 is **not** plataforma receita — it's money received specifically to offset what Stripe will deduct at settlement. In the books, it must be a *distinct* category from both recebedor-credit and plataforma-receita, so accounting reflects:

- What the recebedor is owed (R$80 → saldo).
- What the plataforma actually earned (R$4 → receita).
- What was collected to pass through to the provider (R$3.50 → reembolso_taxa_provedor).
- (Later) What the provider actually deducted (debit lancamento, ideally matching the passthrough).
- (Later) Any variance between predicted and actual (small adjustment lancamento).

This lets finance answer "how much did we actually keep this month" by summing receita — without provider passthrough polluting that number.

## What this plan does NOT cover (deferred)

- **Anticipation / antecipação** (advancing D+30 funds for a fee). Different financial product; deserves its own plan if/when it's a real product line.
- **Multi-currency / FX**. Pure passthrough math, but in BRL only. International expansion is a different plan.
- **Volume-tiered provider rates** (Stripe charges less per transaction above N tx/month). Could be modeled with `RegraTaxaProvedor` carrying tiers; out of scope for v1.
- **Refunding the passthrough on estorno**. Touched in plan 0012's open questions; the *handling* lives there, the *data model* lives here.

## Locked decisions

These are the few choices that aren't worth debating; the real decisions are in "Open questions" below.

1. **Provider passthrough is its own plan, not folded into 0009.** Although `RegraTaxaProvedor` parallels `RegraTaxa` (both versioned, both per-plataforma-able), the *consequence* of this change ripples through 4 BCs (Taxas, Pagamentos, Financeiro, Checkout DTO + Loja UI). Folding into 0009 would bury the narrative.

2. **Composition becomes 3-part, not 2-part.** `ComposicaoValores` (in Taxas BC) gains a `provedorFeeCents` field alongside the existing `feeAmountCents` (renamed to `plataformaFeeCents` for clarity). The total is the sum.

3. **Método selection happens before intencao creation.** Today the loja shows one price per contribuição; with this plan, *the price depends on método*. The contribuinte chooses método on the item (or at top of loja), and the precalculated DTO carries per-método prices.

4. **Provider passthrough lancamento is a new tipo in Financeiro.** Name TBD (likely `credito_reembolso_taxa_provedor` for the inbound side, `debito_taxa_provedor_realizada` for the matching debit when provider settles). Never folded into receita_plataforma; never folded into saldo_recebedor.

5. **`RegraTaxaProvedor` is versioned, mirroring `RegraTaxa`.** When Stripe raises rates, existing pendente pagamentos keep their original rate snapshot (it's already in ComposicaoValores, persisted on Pagamento.intencao). New pagamentos see the new rate.

6. **The provider fee is calculated and persisted at intencao creation.** Not derived at runtime. This is essential for historical correctness: if Stripe changes rates between intencao and webhook, the contribuinte was promised the old price; we honor it. Variance with actual is a separate (variance) lancamento.

7. **One `RegraTaxaProvedor` per provider (not per provider × plataforma) in v1.** Plataforma-specific negotiated rates are a v2 concern (probably folded into 0009's RegraTaxa-like flow). Open question if v1 should already support this.

## DDD concepts this plan teaches

### Composition as a domain operation, not a math hack

Today `calcularComposicaoValores` returns a 2-field record. It looks like simple arithmetic but it's actually a domain operation that encodes *who gets what slice of the money*. Extending it to 3 slices forces an explicit naming exercise: each slice has a meaning, a ledger destination, and a reconciliation lifecycle. Composition is the first place where the engine's *pricing model* lives in code.

### Parallel aggregates with different ownership

`RegraTaxa` belongs to the plataforma (plataforma sets it). `RegraTaxaProvedor` belongs to the provider relationship (set by us based on what Stripe charges us). Both live in the Taxas BC, both are versioned, both feed `ComposicaoValores`. The lesson: two aggregates with similar shape but distinct ownership — don't merge them just because the data looks alike. Provenance matters.

### Earmarked vs general money

The R$3.50 passthrough is *earmarked* — its only purpose is to offset a future debit. The R$4 plataforma tarifa is *general* — once collected, plataforma can do whatever with it. Financial systems handle these very differently (earmarked money often can't be touched until matched against its debit). Modeling them as distinct lancamento types makes the constraint visible.

### Predicted vs actual + variance reconciliation

At intencao time we *predict* what the provider will charge (R$3.50). When the provider settles, we learn the *actual* (R$3.47). The system has to:
1. Lock the prediction (so contribuinte isn't surprised).
2. Record the actual against the prediction.
3. Reconcile the variance into a small adjustment lancamento.

This pattern (predicted → actual → variance) repeats across financial systems (FX rates, market prices, shipping costs). Naming it once here makes future instances easier.

### Per-método pricing in the read DTO

The Checkout DTO from `obterContribuicoesPrecalculadasCampanha` returns one composition per contribuição today. Once price depends on método, it returns *one composition per (contribuição, método)*. The DTO shape changes; the UI shape changes. This is a good example of "the read model serves the UI, even when the write model doesn't change shape much."

## Phases

> ⚠️ **Phase shape depends on the open-questions resolutions.** The phase outline below is a *plausible* sequence assuming the recommended defaults from each open question; revisit before execution.

### Phase 1 — Resolve the open questions (no code)

**Objective**: Hold a working session, walk through the open questions below, lock the decisions, and revise this plan's "Locked decisions" section in place. **No code lands in this phase.** This plan should not advance past Phase 1 until the decisions are written down.

**Deliverable**: this file's "Open questions" section becomes empty (or shrunk to genuinely-implementation-time questions), and "Locked decisions" gains the new entries.

**STOP for confirmation.**

---

### Phase 2 — `TarifaProvedor` + `RegraTaxaProvedor` aggregate

**Objective**: Taxas BC gains a second tariff concept for providers. Versioned, with seed data for Stripe (per method: pix, cartão, boleto).

**Files NEW**:
```
src/domain/taxas/
├── entities/regra-taxa-provedor.ts          # aggregate root
└── value-objects/
    ├── tarifa-provedor.ts                    # { metodo, percentual, fixoCents, passarParaContribuinte }
    └── ids.ts (modified)                     # add IdRegraTaxaProvedor, IdProvedorPagamento
src/adapters/taxas/
├── regra-provedor-provider.ts                # port
├── regra-provedor-provider.memory.ts         # seeded with Stripe rates
└── regra-provedor-provider.postgres.ts
src/errors/taxas/
└── regra-provedor-nao-encontrada.error.ts
migrations/
└── 20271201_001_create_regras_taxa_provedor.ts
tests/unit/taxas/
└── regra-taxa-provedor.test.ts
```

**Shape**:
```ts
interface RegraTaxaProvedor {
  readonly id: IdRegraTaxaProvedor;
  readonly idProvedor: IdProvedorPagamento;            // 'stripe', 'pagseguro', ...
  readonly idPlataforma?: IdPlataformaReferencia;       // null = default; set = negotiated (v2, open question)
  readonly vigenteDesde: Date;
  readonly tarifasPorMetodo: Map<MetodoPagamento, TarifaProvedor>;
}

interface TarifaProvedor {
  readonly metodo: MetodoPagamento;
  readonly percentual: number;          // 0.0399 for 3.99%
  readonly fixoCents: number;            // 39 for R$0.39
  readonly passarParaContribuinte: boolean;  // if false, plataforma absorbs (open question: per-plataforma policy)
}
```

**Seed values for Stripe (v1, illustrative)**:
- pix: 0.99% + R$0, passarParaContribuinte=false (free for contribuinte, plataforma absorbs)
- cartao_credito: 3.99% + R$0.39, passarParaContribuinte=true
- boleto: 0% + R$3.45, passarParaContribuinte=true

**Verification**: `pnpm check` green; seed data loads; lookups by `(idProvedor, momento)` return the right version.

**STOP for confirmation.**

---

### Phase 3 — Extend `ComposicaoValores` to 3-part

**Objective**: Composition gains `provedorFeeCents` field. Calculation accepts both tarifas (plataforma + provedor) and the método.

**Files MODIFIED**:
- `src/domain/taxas/value-objects/composicao-valores.ts`:
  - Rename `feeAmountCents` → `plataformaFeeCents`.
  - Add `provedorFeeCents: number`.
  - `totalPaidCents = contributionAmountCents + plataformaFeeCents + provedorFeeCents`.
- `calcularComposicaoValores` signature changes to accept `{ tarifaPlataforma, tarifaProvedor, metodo, baseCents }`.

**Files NEW**:
```
tests/unit/taxas/
└── composicao-valores-passthrough.test.ts
```

**Verification**: existing callers updated; round-trip tests assert R$80 base + plataforma 5% + Stripe cartão 3.99%+R$0.39 = R$87.51 (or whatever the exact math is).

**STOP for confirmation.**

---

### Phase 4 — Checkout DTO + Pagamento intencao: per-método

**Objective**: Loja DTO returns per-método composition. Pagamento intencao captures the snapshot at creation time.

**Files MODIFIED**:
- `src/use-cases/checkout/obter-contribuicoes-precalculadas-campanha.ts` — DTO `ContribuicaoPrecalculada` gains `composicaoPorMetodo: Map<MetodoPagamento, ComposicaoValores>` instead of a single `composicao`.
- `src/use-cases/checkout/iniciar-pagamento-contribuicao.ts` — input includes método; computes composição with both tarifas; persists snapshot on Pagamento.intencao.
- `src/domain/pagamentos/entities/pagamento.ts` — intencao.composicao gains provedorFeeCents.
- Migration: add column to pagamentos.intencao_composicao_provedor_fee_cents.

**Verification**: loja shows N method options per contribuição with distinct prices; intencao persists exact predicted provider fee.

**STOP for confirmation.**

---

### Phase 5 — Financeiro: passthrough lancamento type

**Objective**: `finalizarPagamentoAprovado` creates 3 lancamentos when provedorFeeCents > 0 (instead of 2).

**Files MODIFIED**:
- `src/domain/financeiro/value-objects/tipo-lancamento.ts` — add `credito_reembolso_taxa_provedor`.
- `src/use-cases/checkout/finalizar-pagamento-aprovado.ts` — creates third lancamento for the provedor passthrough slice.
- `src/adapters/financeiro/livro-repository.{memory,postgres}.ts` — round-trip the new tipo.
- Conformance suite — assert all 3 lancamentos exist for cartão pagamento; only 2 for pix (if pix has passarParaContribuinte=false).

**Verification**: cartão pagamento for R$87.51 → 3 lancamentos summing to R$87.51, split correctly across recebedor / receita / passthrough.

**STOP for confirmation.**

---

### Phase 6 — Loja UI: per-método pricing

**Objective**: Demo loja shows per-método pricing on each contribuição card.

**Files MODIFIED**:
- `examples/fluxo-completo.web.ts`:
  - Render each contribuição card with method tabs / buttons showing price per método.
  - "Comprar" submits with selected método to checkout.
  - Status page shows the método and passthrough amount.

**Verification**: visual test in browser; switching método on same item updates total.

**STOP for confirmation.**

---

### Phase 7 — Provider settlement reconciliation (variance handling)

**Objective**: When provider settles (webhook or report), the engine records actual fee deducted, creates the matching debit lancamento, and handles variance.

**Files NEW**:
```
src/use-cases/financeiro/
└── conciliar-liquidacao-provedor.ts
src/domain/financeiro/value-objects/tipo-lancamento.ts (mod)
  add 'debito_taxa_provedor_realizada' + 'ajuste_taxa_provedor_variancia'
src/use-cases/pagamentos/
└── processar-evento-liquidacao-provedor.ts    # NEW webhook handler
```

**Behavior**:
```ts
conciliarLiquidacaoProvedor(deps, { idPagamento, feeRealizadoCents, liquidadoEm })
  → criar debito_taxa_provedor_realizada(feeRealizadoCents)
  → predicted = pagamento.intencao.composicao.provedorFeeCents
  → if abs(predicted - feeRealizadoCents) > 0:
      → criar ajuste_taxa_provedor_variancia(predicted - feeRealizadoCents)
        (positive = we overcharged, plataforma gains; negative = we undercharged, plataforma loses)
  → log per outcome
```

**Verification**: identical predicted vs actual → 2 new lancamentos summing zero against the passthrough; variance produces a 3rd adjustment lancamento.

**STOP for confirmation.**

---

### Phase 8 — Maturation rules for passthrough lancamentos

**Objective**: Passthrough + variance lancamentos get their own maturation rule (probably "always disponivel" since the plataforma absorbs/keeps them immediately).

**Files MODIFIED** (post-0015 — see addendum at top):
- ~~`src/domain/financeiro/value-objects/maturacao-regra.ts`~~ — moot (0006 superseded; no maturation rule exists). Passthrough lançamento is born with the standard `transferidoEm: null, canceladoEm: null` pair, same as every other lançamento.
- Tests for the new tipos (no maturation behaviour to test).

**Verification (post-0015)**: passthrough lançamento born with `transferidoEm: null, canceladoEm: null`; variance row created identically. The pre-0015 verification line that said "born already disponivel (or with `matura` baked in)" is retired — there is no disponivel-vs-pendente distinction on lançamentos anymore.

**STOP for confirmation.**

---

## Open questions to answer before phases start

### Q1 — Passthrough mandatory or opt-in per plataforma?

Some plataformas might choose to absorb provider fees as part of their value prop ("we pay the card fee for you, no surprises"). Others want full passthrough. Options:

- **A. Hardcoded global**: all plataformas pass through cartão, nobody passes pix.
- **B. Per-plataforma boolean**: each plataforma sets `passaTaxaProvedor: true | false` globally for itself.
- **C. Per-plataforma per-método**: each plataforma sets it per método (eunenem passes cartão but not boleto; eucasei passes both).

Recommend C for realism; B for v1 simplicity.

### Q2 — Per-plataforma negotiated provider rates?

Real Stripe deals vary by volume — eunenem at 1k tx/month pays 3.99%, eunenem at 100k tx/month negotiates 2.49%. Options:

- **A. Single rate per provider** (v1): all plataformas use the same rate.
- **B. Default + per-plataforma override** rows: lookup falls back to default if no override.
- **C. Required per-plataforma row** for every plataforma using the provider.

B is realistic. Affects `RegraTaxaProvedor.idPlataforma` from optional to a real lookup hierarchy.

### Q3 — Surcharge legality

Brazilian CDC (Código de Defesa do Consumidor) historically prohibited price differentiation by método. Decree 9.101/2017 changed that — *with disclosure requirements*. Do we need to:

- Display "preço à vista (PIX): R$80" vs "preço a prazo (cartão): R$87.50" explicitly?
- Show somewhere "esse acréscimo é a tarifa cobrada pelo provedor de pagamento"?
- Different display rules for different plataformas?

This is half UX, half legal. Lawyer/compliance should weigh in for production; for the engine demo we just pick a sensible display.

### Q4 — Display granularity

How itemized is the breakdown shown to the contribuinte?

- **Fully itemized**: "R$80 contribuição + R$4 taxa plataforma + R$3.50 taxa provedor = R$87.50"
- **Two-line**: "R$80 contribuição + R$7.50 taxas = R$87.50"
- **Single total only**: "R$87.50" (and a tooltip / details link)

Affects loja UI from Phase 6.

### Q5 — UI flow: método-per-item or método-per-cart

Two cart paradigms:

- **Per-item**: each contribuição card has its own method selector. Contribuinte picks método for *this item*. (Matches today's "comprar uma coisa por vez" UX.)
- **Per-cart**: single método choice at checkout, applied to whole cart. (More like an e-commerce checkout.)

Today's demo is single-item (no cart concept), so per-item is the natural fit. If a cart concept ever lands (separate plan), per-cart selection makes more sense.

### Q6 — Variance handling policy

When actual provider fee differs from predicted, what does the engine do?

- **A. Auto-create variance lancamento** (per Phase 7). Plataforma absorbs the diff, visible in books.
- **B. Log and ignore**: if variance < R$0.05, swallow it.
- **C. Alert ops**: variance > X triggers a notification for human review.
- **D. Hybrid**: A always, plus C above a threshold.

D is realistic. A is minimum viable.

### Q7 — Reconciliation source

Where does the engine learn the *actual* fee charged?

- **A. Stripe Settlement Reports API**: scheduled job pulls reports daily/weekly.
- **B. Webhook per liquidação event**: real-time, per-pagamento.
- **C. CSV upload from finance**: finance team downloads from Stripe dashboard, uploads here.
- **D. Mix**: webhook for events we get, CSV fallback for what we miss.

Depends entirely on what Stripe offers per integration tier. Recommend B if available, D realistically.

### Q8 — Interaction with estorno

When a chargeback happens, the provider typically **does not refund their fee** — they keep the R$3.50. So on estorno:

- Contribuinte gets back full R$87.50 (refund).
- Stripe keeps R$3.50.
- Plataforma is out R$3.50 net per chargeback (plus original recebedor/receita reversal per plan 0012).
- The passthrough lancamento becomes a *loss* lancamento (`perda_taxa_provedor_estorno`?).

This must be coordinated with plan 0012. **Action**: add a Q10 to 0012 referencing this.

### Q9 — Per-método maturation for the passthrough side

Plan 0006 sets D+30 for cartão lancamentos. Does that include the passthrough lancamento, or does it mature immediately (since plataforma's exposure is settled at provider settlement, not at maturation)?

- **A. Same as primary**: passthrough lancamento matures with the recebedor lancamento (D+30 cartão).
- **B. Immediate**: passthrough is born disponivel; it's plataforma money, not recebedor money.
- **C. Tied to liquidação**: passthrough matures when provider settles (concrete event, not time-based).

C is the most accurate. B is the simplest. A is the laziest.

## Done definition

- Phase 1 decisions documented in this file's "Locked decisions" section.
- Phases 2–8 land, each gated by `pnpm check`.
- End-to-end demo: contribuinte sees per-método prices, picks cartão, pays inflated total, Financeiro shows 3 lancamentos. After "simular liquidação," debit lancamento + variance appear.
- Books reconcile: sum of all lancamentos for a campanha = sum of pagamentos collected − provider fees realized.
- Plan 0012 has a Q10 added covering chargeback × passthrough interaction.
