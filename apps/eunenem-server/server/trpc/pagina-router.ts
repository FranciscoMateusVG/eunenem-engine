import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import {
  calcularValorTaxaPercentual,
  type Campanha,
  computeCardSurchargeCents,
  type IdContribuicao,
  type IdIntencaoPagamento,
  type IdOpcaoContribuicao,
  type IdPagamento,
  iniciarPagamentoContribuicao,
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
      return items.map((c) => {
        const feeAmountCents = calcularValorTaxaPercentual(c.valor, tarifaPresente.percentageBps);
        const valorComTaxa = c.valor + feeAmountCents;
        return {
          id: c.id as string,
          nome: c.nome,
          valor: valorComTaxa,
          // Surcharge is computed off the bare contribution amount —
          // matches what the Stripe adapter sends as the surcharge line
          // item via composicao.surchargeCents (which is also computed
          // off contributionAmountCents in calcularComposicaoValores).
          // Keeping the surcharge base aligned across backend + projection
          // preserves the "what we display equals what Stripe charges"
          // invariant the operator caught the original bug under.
          valorComTaxaCartao: valorComTaxa + computeCardSurchargeCents(c.valor),
          imagemUrl: c.imagemUrl,
          grupo: c.grupo,
          status: c.status,
        };
      });
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

      try {
        const result = await iniciarPagamentoContribuicao(
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
            idContribuicao: input.idContribuicao as IdContribuicao,
            metodo: input.metodo,
            idPagamento,
            idIntencaoPagamento,
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

      const contribuicao = await ctx.deps.contribuicaoRepository.findById(
        pagamento.intencao.idContribuicao as unknown as IdContribuicao,
      );

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

      // aperture-m95f3: post-webhook the Contribuicao.contribuinte (set
      // by finalize → associarContribuinteContribuicao) is canonical for
      // nome / email / mensagem. Fall back to the provider session for the
      // pre-webhook window (visitor hit success before webhook fired) so
      // the page still shows something during the pending state.
      const persistedContribuinte = contribuicao?.contribuinte ?? null;

      return {
        giftName: contribuicao?.nome ?? '',
        valor: pagamento.intencao.amountCents,
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
