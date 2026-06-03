# 0015 — Contribuição / Pagamento / Financeiro collapse

**Status.** 📝 drafted 2026-06-03
**Depends on.** 0002 (checkout orchestration — done), 0004 (async confirmation — drafted), 0013 (provider fee passthrough — drafted)
**Supersedes parts of.** 0006 (maturation rule), 0008 (concurrency on claim), 0012 (estorno cascade)
**Unblocks.** Simpler estorno path, simpler webhook handler, fewer race conditions across BCs, cleaner mental model for the recebedor's balance.

## Goal

After this lands, the engine has:

- **One state machine** instead of three. Only Pagamento has an FSM; Contribuição has none; LançamentoFinanceiro has none.
- **Contribuição** is a pure slot definition created by the admin. No contribuinte data, no status, no transitions, no visitor-facing writes.
- **Pagamento** (1:N per contribuição) carries the `DadosContribuinte` + the Stripe lifecycle status. Each visit-and-pay attempt is a new pagamento row.
- **LançamentoFinanceiro** tracks money flow via two date columns instead of an FSM: `transferidoEm` (set manually by admin when the money actually reaches the recebedor) and `canceladoEm` (set when an estorno fires before transfer).
- **Financeiro** folds into the Pagamentos BC as a module, not a standalone BC.
- The "indisponivel" predicate is a single indexed query — no derived state cache, no race-prone status flips, no cross-BC cascade.

**Trigger.** Race-condition concerns from cross-BC FSM cascades — particularly the contribuição-status-mirror-of-pagamento-status pattern that introduced a backwards-transition problem on estorno. Once 1:N contribuição→pagamentos is allowed, the mirror status becomes redundant; once the mirror is gone, the cascade is gone; once the cascade is gone, most of the race surface evaporates.

Operator framing (verbatim): *"all of them have status and transitions which in my experience can lead up to terifying race conditions and state machine problems that in large scale might be a disaster. So... looking at them closely i thought... YOu know what... why dont we simplify this."*

## Locked decisions

1. **Three coupled changes ship together.** Partial application doesn't make sense; the simplifications reinforce each other.
   1. Financeiro → module inside Pagamentos (not a standalone BC).
   2. Contribuição loses `status` and `contribuinte` fields.
   3. Contribuição ↔ Pagamento becomes 1:N.

2. **Contribuição shape.** `{id, idCampanha, idOpcaoContribuicao, nome, valor, imagemUrl, grupo, criadaEm}`. Admin-owned. No visitor writes. Slot definition only.

3. **DadosContribuinte moves to IntencaoPagamento.** Nullable at intent-creation time (Stripe iframe hasn't shown yet, no contribuinte data available). Set by the webhook handler at `checkout.session.completed` when Stripe delivers `custom_fields`. Matches the existing pattern for `paymentIntentExternalRef` + `chargeExternalRef`, which are also nullable-at-intent-creation and set by the webhook.

4. **1:N Contribuição → Pagamento.** Each gift attempt is a fresh pagamento row. Estorno on pagamento_A doesn't touch the slot; pagamento_B (from same or different visitor) is a new row. Full audit trail preserved.

5. **Indisponivel predicate.** `EXISTS pagamento WHERE pagamento.idContribuicao = X AND pagamento.status = 'aprovado'`. One indexed condition. Sub-millisecond. No status mirror.

6. **Optimistic concurrency — accept double-pay.** No reservation locks. If two visitors complete payment for the same contribuição inside the same Stripe session window, both pagamentos go `aprovado`; recebedor receives 2x the value. **eunenem is a money-transfer product with no stock, no physical fulfillment** — double-pay is +money for the recebedor, not -inventory. Operator framing: *"we actually just transfer funds, there is no stock no actual gifts... in case this happens there is absolutely no problem of having a contribucao with two valid pagamentos."*

7. **Pagamento FSM: 5 states.**

   ```
   pendente   → processing   (payment_intent.processing — pix QR scanned / ACH float)
   pendente   → aprovado     (charge.succeeded, card happy path)
   processing → aprovado     (charge.succeeded after pix/ACH confirmation)
   pendente   → rejeitado    (failure before processing — declined, expired, fraud)
   processing → rejeitado    (failure during processing)
   aprovado   → estornado    (charge.refunded — pre-transfer guard enforced)
   ```

   Both `pix` and `credit_card` are shipped metodos (verified in `src/domain/pagamentos/value-objects/metodo-pagamento.ts`). Cards skip `processing`; pix transits through it. Partial refunds stay `aprovado` (full refund only triggers `estornado`).

8. **Pagamento aggregate keeps its existing nesting.** `Pagamento` root has `IntencaoPagamento` (born first) and `TransacaoExterna` (born at settlement). `DadosContribuinte` slots into `IntencaoPagamento` as a nullable field. Other entity structure stays as today. The nesting encodes "Stripe-side reservation vs. settled transaction" — earned domain semantics worth preserving.

9. **LançamentoFinanceiro has NO FSM.** Replaces `status` (`pendente | disponivel`) and `maturaEm` (predicted date) with two date columns:

   - `transferidoEm: Date | null` — set by admin when money actually reaches the recebedor (manual action; cron / Stripe Connect / automated banking out of scope).
   - `canceladoEm: Date | null` — set when pagamento transitions to `estornado` AND this lançamento was still untransferred.

   Implicit "states" are query-time predicates:

   | implicit state | predicate |
   |---|---|
   | pending | `transferidoEm IS NULL AND canceladoEm IS NULL` |
   | transferred | `transferidoEm IS NOT NULL AND canceladoEm IS NULL` |
   | cancelado | `canceladoEm IS NOT NULL` |

   The "maturation rule" (plano-maturação, `calcularMaturaEm`, predicted dates) is fully removed. We store what *happened*, not what we *guessed would happen*.

10. **Estorno gate.** The refund endpoint returns **409 Conflict** if any lançamento on the pagamento has `transferidoEm IS NOT NULL`. Money already with the recebedor can't be clawed back through this path (a chargeback would have to follow the disputes flow — out of scope here).

11. **No cancel UX for visitors.** Stripe owns the iframe lifecycle once `cs_xxx` is handed to the client. We can't cancel a Stripe session from our side. Pagamento sits in `pendente` until Stripe fires `checkout.session.expired` (default 24h) or the visitor completes payment. Contribuição has zero state-changing visitor-side operations.

12. **Disputes (customer-initiated chargebacks) are out of scope.** `charge.dispute.created` events CAN fire post-aprovado. For this plan we leave the dispute as an unhandled audit event in `payment_webhook_events`; the pagamento stays `aprovado`. Full handling (notify recebedor, reverse already-transferred lançamentos, mark `disputed` state) is a follow-up bead.

## DDD concepts this plan teaches

1. **State machines belong where the events are.** Pagamento is event-driven (Stripe webhooks fire actual transitions) — it earns its FSM. Lançamento is time/manual-action driven; its "states" are predicates over date columns. It does not earn an FSM. The asymmetry is honest: different shapes, different solutions.

2. **Aggregate boundaries vs BC boundaries.** Financeiro WAS a BC. This plan demotes it to a module inside Pagamentos because lançamentos have no lifecycle independent of a pagamento. A "BC" should imply an independent lifecycle (its own ubiquitous language, its own consistency boundary, its own team-ownership story). If those don't apply, it's a module.

3. **Optimistic vs pessimistic reservation.** The original `xaha2` saga claimed contribuição at session-create (pessimistic — wrong because iframe abandonment locked slots). The `m95f3` rework moved the claim to webhook-time (still pessimistic, just later). This plan goes fully optimistic: no claim, ever. "Indisponivel" is a derived predicate over actual aprovado pagamentos. Double-pay becomes a recoverable edge case (which we accept as +money) instead of a race-prone lock.

4. **Derived state vs stored state.** When a "state" can be computed from a column you already have (a date, a foreign key, a count), don't store it. The derived form is always consistent with reality; the stored form has to be synced and is therefore race-prone.

5. **Cascade scope discipline.** When pagamento transitions to `estornado`, the cascade into lançamentos is bounded: only `transferidoEm IS NULL` rows get `canceladoEm`. The 409-on-estorno-after-transfer rule is the boundary that keeps the cascade safe.

6. **Predicted dates vs observed dates.** `maturaEm` was a prediction ("Stripe will probably release these funds in N days based on the metodo's maturation rule"). `transferidoEm` is an observation ("the admin marked this row as transferred at this exact moment"). Predictions desync from reality; observations don't.

## Phases

Each phase ends with **STOP for confirmation**. Don't roll forward without explicit go.

### Phase 0 — Migrations + schema surgery

**Objective.** Drop the old columns; add the new ones. Single migration run. No data-preservation work (operator confirmed: not yet in real-prod use; staging DB has been cleared throughout development; production has only walk-through data and is expendable).

**Files NEW:**

- `migrations/20260603_019_collapse_state_machines.ts`

**Schema changes:**

- `contribuicoes`:
  - DROP `status`
  - DROP `contribuinte_nome`, `contribuinte_email`, `contribuinte_recadinho` (and any other DadosContribuinte columns)
- `intencoes_pagamento` (or the table holding IntencaoPagamento — verify in adapter):
  - ADD `contribuinte_nome VARCHAR(120) NULL`
  - ADD `contribuinte_email VARCHAR(255) NULL`
  - ADD `contribuinte_recadinho TEXT NULL`
- `pagamentos`:
  - ALTER `status` enum: extend from `pendente | aprovado | rejeitado` to `pendente | processing | aprovado | rejeitado | estornado`
- `lancamentos_financeiros`:
  - DROP `status`
  - DROP `matura_em`
  - ADD `transferido_em TIMESTAMPTZ NULL`
  - ADD `cancelado_em TIMESTAMPTZ NULL`
- `repasses_recebedor` (if present): **leave untouched in this phase**. Phase 4 decides the entity's fate; if Phase 4 picks "delete," a follow-up migration drops the table. Touching it here would force a re-create if Phase 4 picks "keep."

**Indexes:**

- `idx_pagamentos_contribuicao_aprovado ON pagamentos(id_contribuicao) WHERE status='aprovado'` (the indisponivel predicate — partial index)
- `idx_lancamentos_recebedor_pending ON lancamentos_financeiros(recebedor_id) WHERE transferido_em IS NULL AND cancelado_em IS NULL`
- `idx_lancamentos_pagamento_transferred ON lancamentos_financeiros(id_pagamento) WHERE transferido_em IS NOT NULL` (the estorno gate)

**Verification:**

- `pnpm db:migrate` runs clean against a fresh DB
- `psql -c "\d pagamentos"` shows the 5-value enum
- `psql -c "\d contribuicoes"` shows no `status` column, no contribuinte columns
- `psql -c "\d lancamentos_financeiros"` shows no `status`, no `matura_em`, with `transferido_em` + `cancelado_em` present
- All `EXPLAIN ANALYZE` against the indisponivel predicate uses the partial index

**STOP for confirmation.** Operator approves before Phase 1.

### Phase 1 — Entity surgery

**Objective.** Slim Contribuicao. Expand Pagamento FSM + add contribuinte to IntencaoPagamento. Replace lançamento status + maturaEm with date columns.

**Files MODIFIED:**

- `src/domain/arrecadacao/entities/contribuicao.ts`:
  - Remove: `StatusContribuicaoSchema`, `StatusContribuicao`, `status` field, `contribuinte` field
  - Remove helpers: `contribuicaoDisponivel`, `contribuicaoComContribuinte`, `contribuicaoSemContribuinte`
  - Remove invariant checks tied to status from `contribuicaoComValor`, `contribuicaoAtualizada`
  - Keep: `criarContribuicaoDisponivel` (rename to `criarContribuicao`), simplified `contribuicaoAtualizada` (admin-only patches, no status gating)
- `src/domain/pagamentos/entities/pagamento.ts`:
  - Expand `StatusPagamentoSchema` to 5 values: `['pendente', 'processing', 'aprovado', 'rejeitado', 'estornado']`
  - Add `contribuinte: DadosContribuinteSchema.nullable()` to `IntencaoPagamentoSchema`
  - Add transition functions: `iniciarProcessamentoPagamento` (pendente → processing), `estornarPagamentoAprovado` (aprovado → estornado, with guard)
  - Update `podeAprovarPagamento` / `podeRejeitarPagamento` to accept both `pendente` and `processing` as valid source states
- `src/domain/financeiro/entities/lancamento-financeiro.ts`:
  - Remove: `StatusLancamentoSchema`, `status` field, `maturaEm` field
  - Add: `transferidoEm: z.date().nullable()`, `canceladoEm: z.date().nullable()`
  - Remove: `criarLancamentosParaPagamentoAprovado` `metodo` parameter (no longer needed without maturation)
  - Adjust `criarLancamentosParaPagamentoAprovado` to set both new date fields to `null` at creation
- `src/domain/arrecadacao/value-objects/dados-contribuinte.ts`:
  - Move file to `src/domain/pagamentos/value-objects/dados-contribuinte.ts`
  - Keep re-export at old path with `/** @deprecated moved to pagamentos */` for one release cycle, then delete

**Files DELETED:**

- `src/domain/financeiro/value-objects/regra-maturacao.ts`
- `src/use-cases/financeiro/maturar-lancamentos-pendentes.ts`
- `src/use-cases/arrecadacao/associar-contribuinte-contribuicao.ts`
- `src/use-cases/arrecadacao/desassociar-contribuinte-contribuicao.ts`
- `src/errors/arrecadacao/contribuicao-nao-disponivel.error.ts`
- `src/errors/arrecadacao/contribuicao-ja-disponivel.error.ts`

**Verification:**

- `pnpm typecheck` — passes after the changes (no orphan references in domain layer)
- Existing tests fail predictably on the renamed/removed signatures; those failures get fixed in Phase 2

**STOP for confirmation.**

### Phase 2 — Use-case rewrites

**Objective.** Update saga + finalize + estorno use-cases to match the new model.

**Files MODIFIED:**

- `src/use-cases/checkout/iniciar-pagamento-contribuicao.ts`:
  - Drop the `contribuicaoComContribuinte` saga step entirely (no claim, ever)
  - Drop the `contribuicaoDisponivel` early-fail gate (replace with `contribuicaoEstaIndisponivel` EXISTS query — the new derived predicate; reject with `ContribuicaoIndisponivelError` if true)
  - Saga simplifies to: validate plataforma + load contribuição + compute composição + create Stripe session + create IntencaoPagamento with `contribuinte: null`
- `src/use-cases/checkout/finalizar-pagamento-aprovado.ts`:
  - Update to handle 5-state transitions; accept both `pendente` and `processing` as valid source states for the aprovado transition
  - Read `DadosContribuinte` from the `checkout.session.completed` webhook event (`custom_fields` + `customer_details`) and write to `IntencaoPagamento.contribuinte` atomically with the status flip
- `src/use-cases/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.ts`:
  - Drop `maturaEm` computation entirely
  - Lançamentos born with `transferidoEm: null`, `canceladoEm: null`
  - Drop `metodo` from the input schema (no longer needed)
- `src/use-cases/financeiro/obter-saldo-recebedor.ts`:
  - Split into two queries:
    - "Total recebido" = `SUM WHERE recebedor_id = X AND tipo IN (...) AND transferidoEm IS NOT NULL AND canceladoEm IS NULL`
    - "A receber" (pending) = `SUM WHERE recebedor_id = X AND tipo IN (...) AND transferidoEm IS NULL AND canceladoEm IS NULL`

**Files NEW:**

- `src/use-cases/checkout/estornar-pagamento.ts`:
  - Inputs: `idPagamento`, `idContribuicao`, optional refund reason
  - Validate: `pagamento.status === 'aprovado'` AND no lançamento on this pagamento has `transferidoEm IS NOT NULL` (gate the 409)
  - Call Stripe Refunds API
  - Transition pagamento to `estornado`
  - Set `canceladoEm = now()` on all lançamentos for this pagamento
  - All in one DB transaction
- `src/use-cases/financeiro/marcar-lancamento-transferido.ts`:
  - Admin-action use-case
  - Inputs: batch of lançamento IDs + optional reference to the bank transfer
  - Sets `transferidoEm = now()` on the batch
  - Idempotent: re-marking an already-transferred lançamento is a no-op
- `src/use-cases/arrecadacao/contribuicao-esta-indisponivel.ts`:
  - Pure read query: `EXISTS pagamento WHERE idContribuicao = X AND status='aprovado'`
  - Replaces the old `contribuicaoDisponivel` helper from the entity

**Files DELETED:** (already removed in Phase 1; listed here for the impl plan's check)

- `src/use-cases/arrecadacao/associar-contribuinte-contribuicao.ts`
- `src/use-cases/arrecadacao/desassociar-contribuinte-contribuicao.ts`
- `src/use-cases/financeiro/maturar-lancamentos-pendentes.ts`

**Verification:**

- `pnpm test` green — all use-case unit tests pass
- New tests covering: 5-state FSM transitions, estorno gate (both green and red 409 paths), `marcar-lancamento-transferido` idempotency, the new indisponivel predicate

**STOP for confirmation.**

### Phase 3 — Webhook handler refactor

**Objective.** Map the 5-state FSM to Stripe events; handle the new `charge.refunded → estornado` path.

**Files MODIFIED:**

- `src/adapters/webhook-archive/stripe-webhook-pipeline.ts`: extend event routing.

  | Stripe event | Transition |
  |---|---|
  | `checkout.session.completed` (card, immediate succeeded) | `pendente → aprovado` + capture contribuinte from `custom_fields` |
  | `checkout.session.completed` (pix, pending settlement) | `pendente → processing` + capture contribuinte |
  | `checkout.session.expired` | `pendente → rejeitado` |
  | `payment_intent.created` | no transition (audit only) |
  | `payment_intent.processing` | `pendente → processing` |
  | `payment_intent.succeeded` | no transition (charge.succeeded is canonical; idempotent record) |
  | `payment_intent.payment_failed` | `pendente` or `processing` → `rejeitado` |
  | `charge.succeeded` | `pendente` or `processing` → `aprovado` (idempotent if already aprovado) |
  | `charge.failed` | `pendente` or `processing` → `rejeitado` |
  | `charge.updated` | no transition (handles partial refund signaling, dispute updates — captured in payment_webhook_events only) |
  | `charge.refunded` (full: `amount_refunded == amount_total`) | `aprovado → estornado` |
  | `charge.refunded` (partial: `amount_refunded < amount_total`) | no transition (stays aprovado per locked decision) |
  | `charge.dispute.created` | no transition (out-of-scope; audit only) |

- Webhook handler resolves the target pagamento via the existing `findByExternalRef` / `findByPaymentIntentExternalRef` / `findByChargeExternalRef` lookup chain (aperture-wif8s).

**Verification:**

- Updated unit tests for the webhook pipeline using `PagamentoProviderFake` (already supports both pix + credit_card flows)
- Live walks against staging (Phase 7 covers end-to-end; this phase verifies the handler unit-level)

**STOP for confirmation.**

### Phase 4 — Code organization (financeiro → pagamentos module)

**Objective.** Move financeiro files under the Pagamentos BC. Same code, new location, updated imports.

**Moves:**

- `src/domain/financeiro/` → `src/domain/pagamentos/financeiro/`
- `src/use-cases/financeiro/` → `src/use-cases/pagamentos/financeiro/`
- `src/adapters/financeiro/` → `src/adapters/pagamentos/financeiro/`
- `src/errors/financeiro/` → `src/errors/pagamentos/financeiro/`

**RepasseRecebedor disposition.** The existing `RepasseRecebedor` entity (currently at `src/domain/financeiro/entities/repasse-recebedor.ts`) becomes a thin shape over the manual batch-mark operation. Decide one of:

- (a) Keep as an aggregate (a "transfer batch" is a real entity — multiple lançamentos transferred together at one admin click)
- (b) Demote to a value object (a list of lançamento IDs with a shared timestamp)
- (c) Delete entirely and rely only on the `transferidoEm` column with no batch grouping

Recommendation: **(a) keep as aggregate** — gives the admin UI a real "batch" concept to display ("you transferred 12 lançamentos at this timestamp under this bank reference"). Refine during implementation.

**Verification:**

- `pnpm typecheck` green
- `pnpm test` green
- `pnpm build` produces a clean bundle
- Live walk of `/admin/contribuicao/:id` still loads and renders (no broken imports)

**STOP for confirmation.**

### Phase 5 — Doc updates

**Objective.** Update the existing plans + conceptual docs so the repo doesn't carry stale model assumptions.

**Files MODIFIED:**

- `plans/README.md`:
  - Add row for 0015 in the table
  - Update dependency graph: 0015 supersedes parts of 0006/0008/0012; mark renamed plans
  - Add to "Suggested execution order" note about 0015 being the simplification pass after the original event-driven design lessons

- `plans/0006-lancamento-maturation-rule.md` → rename to `0006-lancamento-maturation-rule-superseded.md`:
  - Add SUPERSEDED-BY block at top pointing to 0015
  - One-paragraph rationale: predicted maturation (`calcularMaturaEm`) replaced by observed transfer (`transferidoEm`), set manually by admin. Lançamento has no FSM anymore.

- `plans/0008-concurrency-safety-on-claim.md` → rename to `0008-concurrency-safety-on-claim-superseded.md`:
  - Add SUPERSEDED-BY block
  - Rationale: no more claim semantics; the optimistic-CC-via-versao pattern doesn't apply when there's no shared status to race on. Concurrency on multi-write paths still matters but moves under the Pagamentos aggregate's own consistency boundary.

- `plans/0012-estorno-and-chargeback-cascade.md`:
  - Heavy rewrite of the cascade section: drop the DEBITO_* row pattern; replace with `canceladoEm` timestamps on pre-transfer lançamentos
  - Drop the FSM-mirror discussion (no contribuição.status to mirror)
  - Keep the chargeback section but flag it as out-of-scope for 0015 and pending its own bead
  - Update the dependency arrows in the README

- `plans/0004-async-confirmation-and-webhooks.md`:
  - Update the FSM section to 5-state (`pendente | processing | aprovado | rejeitado | estornado`)
  - Update the webhook event → transition table to match Phase 3
  - Note: contribuição claim no longer fires in webhook

- `plans/0014-banking-provider-and-repasse-execution.md`:
  - Update the auto-repasse sections to note that the v1 model is manual `transferidoEm` (admin action)
  - Stripe Connect / automated banking integration becomes a separate future plan
  - Keep the high-risk warnings

- `plans/0002-checkout-orchestration-layer-done.md`:
  - Add note at the top: "Saga simplified by 0015 — the contribuição-claim step removed; see 0015 Phase 2."
  - The plan stays marked `-done` (the original work shipped); the addendum points to the next iteration

- `docs/ddd-conventions.md`:
  - Update BC list: Financeiro is a module inside Pagamentos, not a standalone BC
  - Add a paragraph on "module vs BC: lifecycle independence test" — a BC needs its own lifecycle, its own ubiquitous language, its own consistency boundary; if those don't apply, it's a module

- `docs/idempotency-and-concurrency.md`:
  - Update the race-condition framing: most cross-BC races eliminated by single-FSM design
  - Remaining concerns: double-pay (accepted as +money), lançamento batch-transfer ordering (admin discipline)
  - Adjust the open-questions section to drop the maturation race and the claim race; both no longer exist

**Verification:**

- All affected docs reviewed inline by operator
- `grep -rE 'maturaEm|StatusLancamento|associar-contribuinte|contribuicao\.status' docs plans` returns hits only in `-superseded` files

**STOP for confirmation.**

### Phase 6 — Admin UI reshape (`/admin/contribuicao/:id`)

**Objective.** The admin contribuição detail screen (the DDD-trace view rendered by the eunenem-server admin module — likely `apps/eunenem-server/src/admin/contribuicao/[id]/...`) embeds three assumptions invalidated by Phases 1–4. Reshape it so the surface matches the new model.

**Today's screen (per the screenshot operator surfaced 2026-06-03):**

```
ARRECADAÇÃO card
├── nome, valor, opção (id), grupo, criada em
├── INDISPONIVEL badge          ← assumes stored status on contribuição
├── CONTRIBUINTE: name + email  ← assumes contribuinte on contribuição
├── CAMPANHA, RECEBEDOR
└── MENSAGEM (recadinho)        ← assumes recadinho on contribuição

PAGAMENTOS card
└── (today: only intencão refs + composição; no contribuinte shown)

EVENTOS WEBHOOK card
└── (raw webhook list — already correct)

FINANCEIRO card
└── (lançamentos with status PENDENTE/DISPONIVEL — needs the new shape)
```

**New screen — required changes:**

1. **ARRECADAÇÃO card simplification.**
   - Remove the CONTRIBUINTE block (name + email) from this card
   - Remove the MENSAGEM (recadinho) block from this card
   - Replace the stored INDISPONIVEL badge with one computed from the new predicate: query `EXISTS pagamento WHERE idContribuicao = X AND status='aprovado'`; show INDISPONIVEL if true, DISPONIVEL otherwise. Visual style stays the same.

2. **PAGAMENTOS card expansion.** Each pagamento entry in the list now exposes its own contribuinte data inline (since DadosContribuinte moved to IntencaoPagamento). Per-pagamento block becomes:
   ```
   [status badge] [valor] [criado em]
   MÉTODO: cartão / pix
   EXTERNAL REFS: cs_xxx... | pi_xxx... | ch_xxx...
   CONTRIBUINTE: name + email + recadinho   ← NEW (from intencao.contribuinte)
   COMPOSIÇÃO DE VALORES: (existing — gift price + taxa plataforma + acréscimo cartão + total + líquido)
   ```
   Also surface the new states: the `processing` state needs visual treatment (yellow/in-flight) distinct from `pendente`; `estornado` needs a treatment distinct from `rejeitado`.

3. **FINANCEIRO card update.** Each lançamento row stops showing `status: PENDENTE/DISPONIVEL` (status no longer exists) and instead shows two timestamps:
   ```
   [tipo label] [amount]
   TRANSFERIDO EM: 02/07/2026, 10:15  (or "—" if null)
   CANCELADO EM:   —                   (or timestamp if estornado)
   ```
   Same row visual; the data binding changes.

4. **Indisponivel→Disponivel transition is now ad-hoc.** A pagamento that goes to `estornado` makes its associated contribuição disponivel again (no other aprovado pagamentos exist on the same slot). The UI should reflect this on next page-load — no separate "reverted" badge needed; the predicate just flips.

**Files MODIFIED (under apps/eunenem-server):**

- Admin contribuição detail page server-side renderer + read-DTO query (locate via `grep -r 'admin/contribuicao' apps/eunenem-server/src`)
- Read-side query helper that today reads `contribuicao.contribuinte` — split into a contribuição-only query + a per-pagamento contribuinte query
- Status-badge component(s) used in the Arrecadação card — re-wire to the EXISTS predicate
- Lançamento row component — swap the status pill for the timestamp pair

**Verification:**

- Visual walk of `/admin/contribuicao/<seeded-id>` with each of the 5 pagamento states surfaces correctly (Phase 7 live-walk scenarios will hit these)
- Inspect the rendered page DOM to confirm no orphan "INDISPONIVEL"/"PENDENTE" labels survive
- Type-check passes (TS sees no `contribuicao.status` or `contribuicao.contribuinte` reads)

**STOP for confirmation.** Operator visual walk required.

### Phase 7 — End-to-end live walks

**Objective.** Validate the redesign on staging (`eunenem.xeroxtoxerox.com`) with both shipped payment metodos. Apply the `verify-user-path` skill discipline: Layer A (URL opens), Layer B (action performed), Layer C (network response correct), Layer D (DB row + audit event match).

**Walks:**

1. **Card happy path.** Visitor selects gift → cs_xxx + IntencaoPagamento created (contribuinte=null) → enters card in iframe → `charge.succeeded` → pagamento `aprovado` + contribuinte populated → 2-3 lançamentos created (`transferidoEm=null`) → contribuição shows `indisponivel` in UI.

2. **Pix happy path.** Visitor selects gift → cs_xxx + IntencaoPagamento created → scans QR → `payment_intent.processing` → pagamento `processing` → user confirms in bank app → `charge.succeeded` → pagamento `aprovado` + contribuinte populated → lançamentos created.

3. **Card estorno pre-transfer.** Aprovado pagamento → admin clicks "estornar" → endpoint validates no lançamento has `transferidoEm` → Stripe refund fires → pagamento `estornado` + lançamentos `canceladoEm` set → contribuição shows `disponivel` again.

4. **Card estorno post-transfer (the 409 gate).** Aprovado pagamento → admin marks lançamentos as transferred (`transferidoEm` set) → admin clicks "estornar" → endpoint returns 409 with clear "lançamento já transferido" message; Stripe not called.

5. **Double-pay race (accept-both).** Open two browser windows; both submit payment for the same gift within seconds; both pagamentos go `aprovado`; lançamentos generated for both; UI shows contribuição as `indisponivel`; recebedor balance reflects 2x. No remediation, no error to the visitors.

6. **Session expiration.** Submit checkout → close tab → wait for `checkout.session.expired` (or trigger manually via Stripe CLI) → pagamento `rejeitado`; contribuição stays `disponivel`.

**Done definition.**

- All 6 walks pass on staging
- No FSM-transition errors in Loki / observability layer
- Admin UI surfaces the new states correctly (`/admin/contribuicao/:id` shows pagamento status + webhook events + lançamento `transferidoEm` / `canceladoEm` timestamps)
- `plans/README.md` updated with 0015 row + dependency graph
- Superseded plans renamed with `-superseded` suffix and carry the SUPERSEDED-BY block
- `docs/ddd-conventions.md` reflects financeiro-as-module
- `docs/idempotency-and-concurrency.md` reflects the simplified race model
- Follow-up beads filed for: (1) disputes / chargeback flow, (2) admin UI for `marcar-lancamento-transferido`, (3) automated transfer execution (Stripe Connect / banking provider), (4) RepasseRecebedor aggregate refinement after Phase 4 disposition.

## Open questions

1. **IntencaoPagamento.contribuinte at the persistence layer.** Locked on storing contribuinte on IntencaoPagamento, but the Postgres adapter (`pagamento-repository.postgres.ts`) needs to be checked — does it project IntencaoPagamento as nested rows or flatten everything onto a single `pagamentos` row? If flat, the contribuinte columns live on `pagamentos`; if nested, on `intencoes_pagamento`. Confirm during Phase 1 before writing the migration.

2. **Indisponivel predicate index validation.** Partial index `pagamentos(idContribuicao) WHERE status='aprovado'` proposed; verify Postgres planner uses it for the EXISTS query under typical query shape (run `EXPLAIN ANALYZE` against a seeded fixture).

3. **RepasseRecebedor disposition.** Decided in Phase 4 — recommendation (a) keep as aggregate. Validate with operator during Phase 4 STOP.

4. **Domain event on FSM transition.** Today the webhook saves the raw payload in `payment_webhook_events`. Does the FSM transition itself emit a domain event (for outbox / subscribers)? Today there's `PagamentoEventPublisher` — the new transitions (`pendente → processing`, `aprovado → estornado`) should publish corresponding events. Confirm scope during Phase 2.

5. **Naming.** The plan title says "collapse" — captures the FSM-collapse-and-BC-collapse spirit. Open to a rename ("simplification," "fsm-consolidation") if it reads better in the table.

## Out of scope

- Customer-initiated disputes / chargebacks (`charge.dispute.created` cascade)
- Admin UI for `marcar-lancamento-transferido` (its own design pass after this lands)
- Automated transfer execution — Stripe Connect, banking provider integration (separate plan; 0014 partially covers but needs revision)
- Plataforma-tier data migration (no plataforma data in production yet)
- Mobile app changes (no mobile app today)
- Reconciliation tooling for the double-pay-accepted scenario (operator-acceptable per locked decision 6)

Each of these gets its own bead after this plan lands.

## Companion docs (post-Phase-5)

- [`../docs/ddd-conventions.md`](../docs/ddd-conventions.md) — Pagamentos BC now contains Financeiro as a module
- [`../docs/idempotency-and-concurrency.md`](../docs/idempotency-and-concurrency.md) — simplified race model
- `0006-lancamento-maturation-rule-superseded.md` — historical context for what the predicted-maturation model looked like
- `0008-concurrency-safety-on-claim-superseded.md` — historical context for the claim-based concurrency pattern
- `0012-estorno-and-chargeback-cascade.md` — rewritten cascade model
