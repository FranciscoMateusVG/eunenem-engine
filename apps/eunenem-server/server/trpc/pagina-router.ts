import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import {
  type Campanha,
  computeCardSurchargeCents,
  type IdContribuicao,
  type IdIntencaoPagamento,
  type IdOpcaoContribuicao,
  type IdPagamento,
  iniciarPagamentoContribuicao,
  listarContribuicoesDeOpcao,
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
  nome: z.string(),
  valor: z.number().int().nonnegative(),
  /**
   * Buyer's total cost in cents when paying by credit card (aperture-uyw8i).
   * Includes the Stripe Brazil card surcharge (3.9% + R$0.39 gross-up)
   * computed via the shared backend helper. Frontend renders the
   * differential on the metodo picker so visitors see Cartão cost
   * BEFORE iniciar is called (no surprise at iframe-mount time).
   *
   * Equal to `valor` when card surcharge is zero (defensive; pre-launch
   * configurability). Frontend's pattern `valorComTaxaCartaoCents ?? valorCents`
   * (kx9bl) graceful-falls-back if the field is null on older clients.
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
      // aperture-uyw8i: include valorComTaxaCartao so Vance's metodo
       // picker can show the Cartão differential BEFORE iniciar is called.
       // Single source of truth — the same `computeCardSurchargeCents`
       // helper feeds this AND the Stripe line item; no frontend/backend
       // drift surface.
      return items.map((c) => ({
        id: c.id as string,
        nome: c.nome,
        valor: c.valor,
        valorComTaxaCartao: c.valor + computeCardSurchargeCents(c.valor),
        imagemUrl: c.imagemUrl,
        grupo: c.grupo,
        status: c.status,
      }));
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
