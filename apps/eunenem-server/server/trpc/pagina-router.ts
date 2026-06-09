import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import {
  calcularValorTaxaPercentual,
  type Campanha,
  computeCardSurchargeCents,
  quantidadeRestante,
  type IdContribuicao,
  type IdIntencaoPagamento,
  type IdItemDoPagamento,
  type IdOpcaoContribuicao,
  type IdPagamento,
  iniciarPagamentoCarrinho,
  listarContribuicoesDeOpcao,
  obterTarifaPorTipo,
  type SlugUsuario,
  type Usuario,
} from '../../../../src/index.js';
import { ID_PLATAFORMA_EUNENEM } from '../auth/setup.js';
import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create();

/**
 * Public (unauthed) tRPC router for the visitor checkout flow on
 * `/pagina/<slug>` (aperture-vkrkm).
 *
 * Three procedures back the three visitor-facing surfaces:
 *
 *   1. `pagina.obterListaPresentes` — query: visitor-safe projection of
 *      the slug-owner's `presente` contribuicoes (no PII, no internal ids).
 *   2. `pagina.iniciarPagamentoContribuicao` — mutation: composes the
 *      checkout saga (Stripe session + pending Pagamento), returns the
 *      `clientSecret` the embedded Stripe checkout iframe consumes.
 *   3. `pagina.obterSucessoPagamento` — query: post-redirect read for
 *      the success page, combining authoritative Pagamento status with
 *      provider-side session metadata (recadinho, contribuinte).
 *
 * **Why public:** visitors have no session cookie. Identity is resolved
 * from the URL slug via `(ID_PLATAFORMA_EUNENEM, slug)` → Usuario →
 * Campanha. This router intentionally does NOT import `readSessionCookie`
 * — the contribuicao-router pattern (session-scoped procedures) is
 * inappropriate here.
 *
 * **Visitor-safe projection:** `obterListaPresentes` returns ONLY the six
 * fields a visitor needs to render the gift list. Internal ids
 * (`idCampanha`, `idOpcaoContribuicao`) and PII (`contribuinte`) are
 * deliberately omitted — those would leak operator-side data through a
 * public endpoint.
 *
 * **Stacked on aperture-xaha2:** consumes the new Pagamentos +
 * CheckoutSessionProvider wiring from C2. Targets that branch (not
 * staging) until C2 merges; Rex will rebase to staging after.
 */

// ── Exported schemas (Vance imports types via RouterInputs/Outputs) ───────

export const ObterListaPresentesInputSchema = z.object({
  slug: z.string().trim().min(1).max(60),
});

export const ObterListaPresentesOutputItemSchema = z.object({
  id: z.string().uuid(),
  /**
   * Visitor-facing item name. Visitor-safe (no PII / no idCampanha).
   */
  nome: z.string(),
  /**
   * Plan 0016 slot capacity. The contribuição's intrinsic quantidade
   * column — how many units of this gift the recebedor opened. New-shape
   * contribuições carry quantidade > 1 (single row × N slots); legacy
   * multi-row data carries quantidade=1 (each row IS a single slot, the
   * grouper on the visitor side counts rows).
   *
   * Added under aperture-nz12u so the visitor's `groupVisitorGifts` can
   * read it and distinguish new-shape from legacy data (dual-mode). Pre-
   * nz12u the visitor was blind to the field, capping the cart at 1 for
   * every new-shape gift (Conjunto / Vale Banhos / Beleza / Kit de Sonos /
   * Pacote de Paciência all returned qtyTotal=1 from the legacy row-count
   * grouper, even though the recebedor opened 7/5/5/5/10 slots respectively).
   */
  quantidade: z.number().int().positive(),
  /**
   * Plan 0016 derived availability. `quantidade - SUM(ItemDoPagamento.
   * quantidade across aprovado pagamentos pointing at this slot)`.
   *
   * Can be 0 or negative (overshoot per locked decision #10 — operator
   * accepts the +money outcome; the badge just reads ESGOTADA without
   * surfacing the overshoot magnitude).
   *
   * The cart's UI cap reads this directly. For legacy multi-row data
   * (quantidade=1) it's either 1 (disponivel) or 0 (aprovado) — same
   * legacy semantics as before. For new-shape data it's the source of
   * truth for "how many can the visitor still add".
   */
  quantidadeRestante: z.number().int(),
  /**
   * Visitor-paid total in cents for the **Pix** path (aperture-ines9 —
   * semantic shift). Equals `contributionAmountCents + feeAmountCents`
   * where `feeAmountCents` is the platform fee from the active RegraTaxa
   * (eunenem presente = 5%). Matches the Stripe gift line item charged
   * on the iframe. **NOT the bare contribuicao.valor** — the operator's
   * intent is that the visible price already includes the platform fee
   * (the fee is invisible to the visitor; it "lives in" the price they
   * pay).
   *
   * Internal Pagamento + Financeiro bookkeeping still uses the bare
   * contribution + fee separately (composicaoValores carries both fields
   * distinctly). Only this projection layer surfaces the visible total.
   */
  valor: z.number().int().nonnegative(),
  /**
   * Visitor-paid total in cents for the **Cartão** path (aperture-uyw8i
   * + aperture-ines9 semantic update). Equals `valor + cardSurcharge`
   * where cardSurcharge is the Stripe Brazil 3.9% + R$0.39 gross-up.
   * Matches the sum of the gift + surcharge line items the visitor sees
   * inside the Stripe iframe. Frontend's pattern
   * `valorComTaxaCartaoCents ?? valorCents` (kx9bl) graceful-falls-back
   * if the field is null on older clients.
   */
  valorComTaxaCartao: z.number().int().nonnegative(),
});

export const IniciarPagamentoContribuicaoInputSchema = z.object({
  slug: z.string().trim().min(1).max(60),
  idContribuicao: z.string().uuid(),
  // aperture-m95f3: no contribuinte input. Stripe collects nome + email
  // + mensagem inside the embedded iframe via custom_fields +
  // customer_creation. The webhook reads them from the completed session
  // and finalize associates at payment-settled time. Operator decision —
  // mirrors legacy eunenem.
  metodo: z.enum(['pix', 'credit_card']),
});

/**
 * Plan 0017 / aperture-16flf — visitor cart multi-item checkout input.
 *
 * Each cart item carries an `idContribuicao` and a `quantidade ≥ 1`. Today
 * (pre-create-flow-rewrite — aperture-1l37i lands separately) every
 * contribuição row in the DB has quantidade=1, so the cart drawer maps a
 * line of "Fralda × 3" to THREE items with quantidade=1 each, one per
 * available unit-row in the group. After Rex's create-flow rewrite ships,
 * the drawer can collapse a multi-unit line into a single `{idContribuicao,
 * quantidade: 3}` item against a single row with quantidade=3 — same
 * saga, simpler shape.
 *
 * idsItens is OMITTED from the visitor-facing input. The procedure mints
 * UUIDs server-side per-item (contribuição items + the surcharge item
 * when metodo='credit_card'). Keeping client uninvolved here matches the
 * existing single-shot procedure's pattern and avoids leaking saga-shape
 * details across the public API.
 */
export const IniciarPagamentoCarrinhoInputSchema = z.object({
  slug: z.string().trim().min(1).max(60),
  itens: z
    .array(
      z.object({
        idContribuicao: z.string().uuid(),
        quantidade: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(50),
  metodo: z.enum(['pix', 'credit_card']),
});

export const IniciarPagamentoContribuicaoOutputSchema = z.object({
  sessionId: z.string(),
  clientSecret: z.string(),
});

export const ObterSucessoPagamentoInputSchema = z.object({
  slug: z.string().trim().min(1).max(60),
  sessionId: z.string().trim().min(1).max(255),
});

export const ObterSucessoPagamentoOutputSchema = z.object({
  giftName: z.string(),
  valor: z.number().int().nonnegative(),
  recadinho: z.string().nullable(),
  babyName: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'unknown']),
  contribuinte: z.object({
    nome: z.string().nullable(),
    email: z.string().nullable(),
  }),
});

// ── Shared resolver ───────────────────────────────────────────────────────

/**
 * Resolve `(usuario, campanha, idOpcaoPresentes)` from a URL slug. Mirrors
 * the contribuicao-router's `resolveCallerCampanha` but anchored on the
 * slug instead of a session cookie.
 *
 * Throws `NOT_FOUND` (visitor-facing) for:
 *   - unknown slug on this plataforma
 *   - usuario has no campanha (shouldn't happen post-signup-saga, but
 *     defensive)
 *   - campanha has no `presente` opção (operator hasn't configured one;
 *     same 404 posture — there's nothing to show the visitor)
 *
 * NOT_FOUND is intentional here even where the contribuicao-router uses
 * 500 (no-opcao case): on the public surface we prefer "page not found"
 * over leaking that the user exists but is misconfigured.
 */
async function resolvePaginaBySlug(
  ctx: TrpcContext,
  slug: string,
): Promise<{
  usuario: Usuario;
  campanha: Campanha;
  idOpcaoPresentes: IdOpcaoContribuicao;
}> {
  const { deps } = ctx;
  const usuario = await deps.usuarioRepository.findUsuarioBySlug(
    ID_PLATAFORMA_EUNENEM,
    slug as SlugUsuario,
  );
  if (!usuario) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Pagina nao encontrada' });
  }

  const campanha = await deps.campanhaRepository.findByAdministrador(usuario.idConta);
  if (!campanha) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Pagina nao encontrada' });
  }

  const opcaoPresentes = campanha.opcoes.find((o) => o.tipo === 'presente');
  if (!opcaoPresentes) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Pagina nao encontrada' });
  }

  return {
    usuario,
    campanha,
    idOpcaoPresentes: opcaoPresentes.id,
  };
}

// ── Router ────────────────────────────────────────────────────────────────

export const paginaRouter = t.router({
  /**
   * Visitor-safe gift list. Resolves the slug → usuario → campanha →
   * `presente` opção, lists its contribuicoes, projects to the six fields
   * the visitor UI needs.
   *
   * **Projection rationale:** `contribuinte` (PII), `idCampanha`,
   * `idOpcaoContribuicao`, `criadaEm` are deliberately stripped. A
   * visitor only needs to know what's available and what each item costs.
   */
  obterListaPresentes: t.procedure
    .input(ObterListaPresentesInputSchema)
    .query(async ({ ctx, input }) => {
      const { campanha, idOpcaoPresentes } = await resolvePaginaBySlug(ctx, input.slug);

      // aperture-ines9: load the active RegraTaxa for this plataforma so
      // we can fold the platform fee into the visible-to-visitor prices.
      // The fee is invisible to the visitor; their displayed price already
      // includes it. obterTarifaPorTipo throws if the opção tipo isn't
      // covered by the regra (defensive — every seed-plataforma covers
      // all three tipos today, but a future custom regra might omit one).
      const regraAtiva = await ctx.deps.provedorRegraTaxa.getRegraAtiva(ID_PLATAFORMA_EUNENEM);
      const tarifaPresente = obterTarifaPorTipo(regraAtiva, 'presente');

      const items = await listarContribuicoesDeOpcao(
        {
          contribuicaoRepository: ctx.deps.contribuicaoRepository,
          observability: ctx.deps.observability,
        },
        {
          idCampanha: campanha.id,
          idOpcaoContribuicao: idOpcaoPresentes,
        },
      );

      // aperture-uyw8i + aperture-ines9: surface visitor-paid totals.
      // `valor` includes the platform fee (matches the Stripe gift line
      // item the visitor sees on the Pix path); `valorComTaxaCartao`
      // additionally includes the Stripe Brazil card surcharge (matches
      // the sum of the gift + surcharge line items on the Cartão path).
      // Single source of truth — same calcularValorTaxaPercentual +
      // computeCardSurchargeCents helpers feed Stripe AND this
      // projection; no frontend/backend drift surface.
      return Promise.all(
        items.map(async (c) => {
          const feeAmountCents = calcularValorTaxaPercentual(c.valor, tarifaPresente.percentageBps);
          const valorComTaxa = c.valor + feeAmountCents;
          // aperture-nz12u: surface BOTH the slot cap (quantidade) AND the
          // derived availability (quantidadeRestante) so the visitor side
          // can dual-mode the grouper + cap the cart honestly. Pre-nz12u
          // we only surfaced a boolean via esgotada(), which lost the
          // multiplicity signal on new-shape data.
          //
          // quantidadeRestante can be negative (overshoot per locked
          // decision #10). The status field stays "indisponivel" when
          // restante <= 0 — matches the pre-nz12u esgotada() predicate
          // shape so the visitor card's existing indisponivel branch
          // keeps working unchanged.
          const restante = await quantidadeRestante(
            {
              pagamentoRepository: ctx.deps.pagamentoRepository,
              contribuicaoRepository: ctx.deps.contribuicaoRepository,
              observability: ctx.deps.observability,
            },
            { idContribuicao: c.id },
          );
          // restante === null only when the contribuição doesn't exist —
          // which can't happen here since we just loaded c from the
          // contribuicao repo. Treat as 0 (disponivel=false) defensively.
          const restanteSafe = restante ?? 0;
          const indisponivel = restanteSafe <= 0;
          return {
            id: c.id as string,
            nome: c.nome,
            valor: valorComTaxa,
            valorComTaxaCartao: valorComTaxa + computeCardSurchargeCents(c.valor),
            imagemUrl: c.imagemUrl,
            grupo: c.grupo,
            quantidade: c.quantidade,
            quantidadeRestante: restanteSafe,
            status: indisponivel ? ('indisponivel' as const) : ('disponivel' as const),
          };
        }),
      );
    }),

  /**
   * Composes the checkout saga (aperture-xaha2's
   * `iniciarPagamentoContribuicao`): plataforma membership check →
   * associarContribuinte → computar composicao → Stripe session →
   * Pagamento pendente. Returns the `clientSecret` the embedded checkout
   * iframe mounts.
   *
   * **Server-built returnUrl:** the `{CHECKOUT_SESSION_ID}` literal is a
   * Stripe-side template — Stripe substitutes it after the visitor
   * completes payment, before redirecting to the success page. Leaving it
   * un-interpolated here is intentional.
   *
   * **Error mapping:** the engine use-case throws typed errors
   * (`ArrecadacaoContribuicaoNaoEncontradaError`, etc.). We let those
   * bubble as `INTERNAL_SERVER_ERROR` for now — read-only path doesn't
   * need the contribuicao-router's typed-sentinel mapping table.
   * Visitor-facing copy is rendered by the frontend; the tRPC error code
   * only signals "retry" vs "give up".
   */
  iniciarPagamentoContribuicao: t.procedure
    .input(IniciarPagamentoContribuicaoInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { campanha } = await resolvePaginaBySlug(ctx, input.slug);

      const idPagamento = randomUUID() as IdPagamento;
      const idIntencaoPagamento = randomUUID() as IdIntencaoPagamento;
      const returnUrl = `${ctx.deps.publicOrigin}/pagina/${encodeURIComponent(input.slug)}/sucesso?sessionId={CHECKOUT_SESSION_ID}`;

      // Plan 0016 (aperture-3htxg): visitor flow stays single-contribuição
      // for now (multi-item visitor cart is the separate 0017 follow-on).
      // Adapt the single-gift input to the multi-item saga shape: a
      // 1-element cart with quantidade=1. The saga itself injects the
      // surcharge item for the cartão path, so we mint exactly one
      // contribuição item id here.
      const idItemContribuicao = randomUUID() as IdItemDoPagamento;
      const idsItens: IdItemDoPagamento[] =
        input.metodo === 'credit_card'
          ? [idItemContribuicao, randomUUID() as IdItemDoPagamento]
          : [idItemContribuicao];

      try {
        const result = await iniciarPagamentoCarrinho(
          {
            campanhaRepository: ctx.deps.campanhaRepository,
            contribuicaoRepository: ctx.deps.contribuicaoRepository,
            provedorRegraTaxa: ctx.deps.provedorRegraTaxa,
            pagamentoRepository: ctx.deps.pagamentoRepository,
            pagamentoEventPublisher: ctx.deps.pagamentoEventPublisher,
            checkoutSessionProvider: ctx.deps.checkoutSessionProvider,
            clock: ctx.deps.clock,
            observability: ctx.deps.observability,
          },
          {
            idPlataforma: ID_PLATAFORMA_EUNENEM,
            idCampanha: campanha.id,
            itens: [
              {
                idContribuicao: input.idContribuicao as IdContribuicao,
                quantidade: 1,
              },
            ],
            metodo: input.metodo,
            idPagamento,
            idIntencaoPagamento,
            idsItens,
            returnUrl,
            // aperture-6g58e: browser-originated checkout uses inline
            // success — Stripe fires onComplete in the iframe instead of
            // redirecting. The /sucesso page remains the fallback for
            // payment methods that DO need a redirect (some bank-redirect
            // flows) and for direct-URL visits.
            redirectOnCompletion: 'if_required' as const,
          },
        );
        return { sessionId: result.sessionId, clientSecret: result.clientSecret };
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        });
      }
    }),

  /**
   * Plan 0017 / aperture-16flf — visitor cart multi-item checkout
   * mutation. Wraps `iniciarPagamentoCarrinho` with the visitor-facing
   * shape: takes a slug + array of cart items (each `{idContribuicao,
   * quantidade}`) + metodo, returns the same `{sessionId, clientSecret}`
   * the single-shot procedure returns so the embedded Stripe checkout
   * mounts identically.
   *
   * Server mints UUIDs per-item:
   *   - One IdItemDoPagamento per cart item (contribuição-tipo).
   *   - Plus one more for the surcharge item when metodo === credit_card
   *     (the saga inserts the surcharge automatically; the id must be
   *     provided up-front per the saga's contract).
   *
   * Tenant + invariants enforced by the saga itself:
   *   - All cart items must resolve to the same campanha (cart-construction
   *     invariant per locked decision #8 of Plan 0016) — the saga throws
   *     CarrinhoMultiplasCampanhasError if violated; the procedure
   *     surfaces this as INTERNAL_SERVER_ERROR with the message preserved.
   *   - Per-item esgotada early-fail (locked decision #6) — if any
   *     contribuição in the cart is sold out, the entire mutation rejects.
   */
  iniciarPagamentoCarrinho: t.procedure
    .input(IniciarPagamentoCarrinhoInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { campanha } = await resolvePaginaBySlug(ctx, input.slug);

      const idPagamento = randomUUID() as IdPagamento;
      const idIntencaoPagamento = randomUUID() as IdIntencaoPagamento;
      const returnUrl = `${ctx.deps.publicOrigin}/pagina/${encodeURIComponent(input.slug)}/sucesso?sessionId={CHECKOUT_SESSION_ID}`;

      // Mint one item-id per cart line, plus one more for the surcharge
      // item when the visitor picked cartão. The saga enforces the
      // "surcharge always last" invariant (Plan 0016 locked decision #18)
      // — we just provide the ids in the same order: contribuição items
      // first, surcharge id last when present.
      const idsItensContribuicao: IdItemDoPagamento[] = input.itens.map(
        () => randomUUID() as IdItemDoPagamento,
      );
      const idsItens: IdItemDoPagamento[] =
        input.metodo === 'credit_card'
          ? [...idsItensContribuicao, randomUUID() as IdItemDoPagamento]
          : idsItensContribuicao;

      try {
        const result = await iniciarPagamentoCarrinho(
          {
            campanhaRepository: ctx.deps.campanhaRepository,
            contribuicaoRepository: ctx.deps.contribuicaoRepository,
            provedorRegraTaxa: ctx.deps.provedorRegraTaxa,
            pagamentoRepository: ctx.deps.pagamentoRepository,
            pagamentoEventPublisher: ctx.deps.pagamentoEventPublisher,
            checkoutSessionProvider: ctx.deps.checkoutSessionProvider,
            clock: ctx.deps.clock,
            observability: ctx.deps.observability,
          },
          {
            idPlataforma: ID_PLATAFORMA_EUNENEM,
            idCampanha: campanha.id,
            itens: input.itens.map((item) => ({
              idContribuicao: item.idContribuicao as IdContribuicao,
              quantidade: item.quantidade,
            })),
            metodo: input.metodo,
            idPagamento,
            idIntencaoPagamento,
            idsItens,
            returnUrl,
            // Same inline-success policy as the single-shot procedure:
            // browser-originated checkout uses redirect_on_completion =
            // 'if_required' so Stripe fires onComplete inside the iframe
            // for happy-path metodos (cartão + most PIX flows). The
            // /sucesso page remains the fallback for bank-redirect flows
            // + direct-URL visits + the legacy redirect path.
            redirectOnCompletion: 'if_required' as const,
          },
        );
        return { sessionId: result.sessionId, clientSecret: result.clientSecret };
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        });
      }
    }),

  /**
   * Post-redirect read for the success page. Combines TWO sources:
   *
   *   - `pagamentoRepository.findByExternalRef(sessionId)` — authoritative
   *     for final state (`aprovado` / `rejeitado` — set by the webhook).
   *   - `checkoutSessionProvider.obterSessaoCheckout(sessionId)` —
   *     provider-side metadata (custom_fields.mensagem = recadinho,
   *     contribuinte name/email captured by Stripe).
   *
   * **Status precedence:** the Pagamento row wins for finalized states
   * (the webhook is the source of truth). The provider session is only
   * consulted for the pending state (visitor hit success page before the
   * webhook fired) and to surface `unknown` when nothing has settled yet.
   *
   * **gift name** comes from the Contribuicao (via the Pagamento's
   * intencao → idContribuicao), not the provider session — Stripe stores
   * a free-text line item name that we set but the Contribuicao is
   * canonical.
   */
  obterSucessoPagamento: t.procedure
    .input(ObterSucessoPagamentoInputSchema)
    .query(async ({ ctx, input }) => {
      const { usuario } = await resolvePaginaBySlug(ctx, input.slug);

      const pagamento = await ctx.deps.pagamentoRepository.findByExternalRef(input.sessionId);
      if (!pagamento) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Pagamento nao encontrado' });
      }

      const sessao = await ctx.deps.checkoutSessionProvider.obterSessaoCheckout(input.sessionId);

      // Plan 0016: visitor flow is single-item today (multi-item visitor
      // cart is the separate 0017 follow-on). The cart has exactly one
      // contribuição item; resolve its slot for gift-name display.
      const primeiroItemContribuicao = pagamento.intencao.items.find(
        (item): item is Extract<typeof item, { tipo: 'contribuicao' }> =>
          item.tipo === 'contribuicao',
      );
      const contribuicao = primeiroItemContribuicao
        ? await ctx.deps.contribuicaoRepository.findById(
            primeiroItemContribuicao.idContribuicao as unknown as IdContribuicao,
          )
        : undefined;

      let status: 'pending' | 'approved' | 'rejected' | 'unknown';
      if (pagamento.status === 'aprovado') {
        status = 'approved';
      } else if (pagamento.status === 'rejeitado') {
        status = 'rejected';
      } else if (sessao?.paymentStatus === 'pending') {
        status = 'pending';
      } else {
        status = 'unknown';
      }

      // Post-Phase-1 (plan 0015): contribuinte data moved from Contribuicao
      // to IntencaoPagamento per-pagamento. The success page now reads it
      // from this specific pagamento's intencao (where the webhook stamped
      // it on finalize). Fall back to the Stripe session for the
      // pre-webhook window (visitor hit success before webhook fired).
      const persistedContribuinte = pagamento.intencao.contribuinte ?? null;

      return {
        giftName: contribuicao?.nome ?? '',
        // Plan 0016: total paid lives on the aggregate composição now.
        // For a single-item visitor cart this equals the legacy
        // intencao.amountCents (saga seeds it from the aggregate sum).
        valor: pagamento.intencao.composicaoValoresAggregate
          .totalPaidCents as unknown as number,
        recadinho:
          persistedContribuinte?.mensagem ?? sessao?.customFields.mensagem ?? null,
        babyName: usuario.nomeExibicao,
        status,
        contribuinte: {
          nome: persistedContribuinte?.nome ?? sessao?.contribuinteNome ?? null,
          email: persistedContribuinte?.email ?? sessao?.contribuinteEmail ?? null,
        },
      };
    }),
});

export type PaginaRouter = typeof paginaRouter;
