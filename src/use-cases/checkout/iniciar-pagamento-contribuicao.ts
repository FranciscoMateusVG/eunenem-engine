import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { CheckoutSessionProvider } from '../../adapters/pagamentos/checkout-session-provider.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { ProvedorRegraTaxa } from '../../adapters/taxas/regra-provider.js';
import { encontrarOpcaoContribuicao } from '../../domain/arrecadacao/entities/campanha.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  IdCampanhaSchema,
  IdContribuicaoSchema,
  IdPlataformaReferenciaSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import {
  IdIntencaoPagamentoSchema,
  IdPagamentoSchema,
} from '../../domain/pagamentos/value-objects/ids.js';
import { MetodoPagamentoSchema } from '../../domain/pagamentos/value-objects/metodo-pagamento.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoIndisponivelError } from '../../errors/arrecadacao/contribuicao-indisponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { CheckoutPlataformaMismatchError } from '../../errors/checkout/plataforma-mismatch.error.js';
import type { Observability } from '../../observability/observability.js';
import { contribuicaoEstaIndisponivel } from '../arrecadacao/contribuicao-esta-indisponivel.js';
import { criarIntencaoPagamento } from '../pagamentos/criar-intencao-pagamento.js';
import { calcularComposicaoValores } from '../taxas/calcular-composicao-valores.js';

export const IniciarPagamentoContribuicaoInputSchema = z.object({
  idPlataforma: IdPlataformaReferenciaSchema,
  idCampanha: IdCampanhaSchema,
  idContribuicao: IdContribuicaoSchema,
  metodo: MetodoPagamentoSchema,
  idPagamento: IdPagamentoSchema,
  idIntencaoPagamento: IdIntencaoPagamentoSchema,
  /**
   * URL the provider redirects the visitor to after they submit payment.
   * Use the literal `{CHECKOUT_SESSION_ID}` placeholder if the provider
   * supports it (Stripe substitutes it server-side).
   */
  returnUrl: z.string().trim().min(1).max(2000),
  /**
   * Completion-redirect policy threaded through to the provider session
   * (aperture-6g58e). See CheckoutSessionProvider.CriarSessaoCheckoutInput
   * for the full rationale. Default `always` preserves legacy behavior.
   */
  redirectOnCompletion: z.enum(['always', 'if_required', 'never']).optional(),
});

export type IniciarPagamentoContribuicaoInput = z.infer<
  typeof IniciarPagamentoContribuicaoInputSchema
>;

/**
 * Result includes the provider-side session details (`sessionId` +
 * `clientSecret`) that the frontend needs to mount the embedded checkout
 * iframe. The clientSecret is opaque on our side — never log it.
 */
export interface IniciarPagamentoContribuicaoResult {
  readonly contribuicao: Contribuicao;
  readonly pagamento: Pagamento;
  readonly sessionId: string;
  readonly clientSecret: string;
}

export interface IniciarPagamentoContribuicaoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  /**
   * Sibling-port checkout-session adapter (aperture-xaha2). Stripe adapter
   * in production, PagamentoProviderFake (which implements both ports)
   * in tests / non-prod. The saga depends on the abstraction — Stripe is
   * never imported here.
   */
  readonly checkoutSessionProvider: CheckoutSessionProvider;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Saga de checkout (write-side) — async session topology, Stripe-as-source-
 * of-truth shape.
 *
 * Step order:
 *   1. Plataforma membership check (campanha.idPlataforma === input.idPlataforma)
 *   2. Resolve contribuicao + opção (READ-ONLY, no claim, ever)
 *      - Verify contribuicao exists, belongs to campanha, AND no aprovado
 *        pagamento exists for it yet (early-fail UX — refuses to mount
 *        Stripe iframe for an already-purchased gift; saves the visitor
 *        a payment they can't keep)
 *   3. encontrarOpcaoContribuicao + calcularComposicaoValores (no DB writes)
 *   4. **checkoutSessionProvider.criarSessaoCheckout** → provider session
 *   5. criarIntencaoPagamento (Pagamentos) → pagamento pendente with
 *      externalRef populated AND contribuinte: null (the visitor's
 *      nome/email/recadinho are collected by Stripe inside the iframe
 *      via custom_fields + customer_creation; the webhook populates
 *      IntencaoPagamento.contribuinte at finalize time)
 *
 * **Plan 0015 collapse (aperture-ucgok).** The old saga had a
 * `contribuicaoComContribuinte` step that flipped the contribuição's
 * status field as part of finalize. With the status field gone, that
 * step is gone — `contribuição` is a pure slot definition. The
 * "indisponivel" badge is derived from the EXISTS predicate over
 * pagamentos (the `contribuicaoEstaIndisponivel` use-case, step 2's
 * gate). The locked decision #6 of plan 0015 explicitly accepts
 * concurrent double-pay (visitor's +money outcome), so this gate is
 * a UX courtesy, not a correctness check.
 *
 * **Compensation:** trivial — there's no claim to revert. If
 * criarSessaoCheckout (step 4) or criarIntencaoPagamento (step 5)
 * fails, we throw. Contribuição was never touched. Orphaned Stripe
 * sessions self-expire via the provider's TTL.
 */
export async function iniciarPagamentoContribuicao(
  deps: IniciarPagamentoContribuicaoDeps,
  input: IniciarPagamentoContribuicaoInput,
): Promise<IniciarPagamentoContribuicaoResult> {
  const {
    campanhaRepository,
    contribuicaoRepository,
    provedorRegraTaxa,
    pagamentoRepository,
    pagamentoEventPublisher,
    checkoutSessionProvider,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('iniciarPagamentoContribuicao', async (span) => {
    try {
      const parsed = IniciarPagamentoContribuicaoInputSchema.parse(input);

      span.setAttribute('checkout.plataforma.id', parsed.idPlataforma);
      span.setAttribute('checkout.campanha.id', parsed.idCampanha);
      span.setAttribute('checkout.contribuicao.id', parsed.idContribuicao);
      span.setAttribute('checkout.pagamento.id', parsed.idPagamento);
      span.setAttribute('checkout.metodo', parsed.metodo);

      // step 1: plataforma membership check
      const campanha = await campanhaRepository.findById(parsed.idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(parsed.idCampanha);
      }
      if (campanha.idPlataforma !== parsed.idPlataforma) {
        throw new CheckoutPlataformaMismatchError(parsed.idPlataforma, campanha.idPlataforma);
      }

      // step 2: read-only contribuicao + opção check (NO claim — see header)
      const contribuicao = await contribuicaoRepository.findById(parsed.idContribuicao);
      if (!contribuicao) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(parsed.idContribuicao);
      }
      if (contribuicao.idCampanha !== campanha.id) {
        // Cross-tenant access attempt — surface as not-found (don't leak existence).
        throw new ArrecadacaoContribuicaoNaoEncontradaError(parsed.idContribuicao);
      }
      // Plan 0015 (aperture-ucgok): UX-friendly early fail derived
      // from the EXISTS-aprovado-pagamento query. Don't make the
      // visitor pay for a gift someone else just bought. NOT a
      // correctness gate — locked decision #6 accepts double-pay
      // as +money for the recebedor when two visitors race through.
      const indisponivel = await contribuicaoEstaIndisponivel(
        { pagamentoRepository, observability },
        { idContribuicao: parsed.idContribuicao },
      );
      if (indisponivel) {
        throw new ArrecadacaoContribuicaoIndisponivelError(parsed.idContribuicao);
      }

      // step 3a: resolve tipo via the campanha's opção
      const opcao = encontrarOpcaoContribuicao(campanha, contribuicao.idOpcaoContribuicao);
      if (!opcao) {
        throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(
          campanha.id,
          contribuicao.idOpcaoContribuicao,
        );
      }

      // step 3b: compute composição (Taxas, plataforma + tipo + metodo
      // scoped). Passing `metodo` triggers Stripe Brazil's card
      // surcharge inclusion in the composicao snapshot (aperture-uyw8i).
      // Pix flows resolve to 0 surcharge.
      const composicao = await calcularComposicaoValores(
        { provedorRegraTaxa, observability },
        {
          idPlataforma: parsed.idPlataforma,
          idContribuicao: parsed.idContribuicao,
          tipo: opcao.tipo,
          contributionAmountCents: contribuicao.valor,
          metodo: parsed.metodo,
        },
      );

      // step 4: provider-side checkout session. If this fails (network,
      // auth, provider 5xx), we just throw — nothing to compensate.
      // surchargeCents threaded so the adapter can surface it as a
      // separate line item (aperture-uyw8i — buyer sees an itemised
      // receipt: gift price + processing surcharge).
      const sessao = await checkoutSessionProvider.criarSessaoCheckout({
        idPagamento: parsed.idPagamento,
        idIntencaoPagamento: parsed.idIntencaoPagamento,
        idContribuicao: parsed.idContribuicao,
        idOpcaoContribuicao: contribuicao.idOpcaoContribuicao,
        tipoOpcao: opcao.tipo,
        nomeItem: contribuicao.nome,
        amountCents: composicao.totalPaidCents,
        surchargeCents: composicao.surchargeCents,
        metodo: parsed.metodo,
        returnUrl: parsed.returnUrl,
        ...(parsed.redirectOnCompletion
          ? { redirectOnCompletion: parsed.redirectOnCompletion }
          : {}),
      });

      span.setAttribute('checkout.session.id', sessao.sessionId);

      // step 5: create the payment intent with externalRef so the webhook
      // can resolve back to this Pagamento via findByExternalRef.
      const pagamento = await criarIntencaoPagamento(
        { pagamentoRepository, pagamentoEventPublisher, clock, observability },
        {
          idPagamento: parsed.idPagamento,
          idIntencaoPagamento: parsed.idIntencaoPagamento,
          composicaoValores: composicao,
          valorACobrarCents: composicao.totalPaidCents,
          metodo: parsed.metodo,
          externalRef: sessao.externalRef,
        },
      );

      logger.info('checkout.pagamento.iniciado', {
        idPlataforma: parsed.idPlataforma,
        idCampanha: campanha.id,
        idContribuicao: parsed.idContribuicao,
        idPagamento: pagamento.id,
        sessionId: sessao.sessionId,
        tipoOpcao: opcao.tipo,
        totalPaidCents: composicao.totalPaidCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return {
        contribuicao,
        pagamento,
        sessionId: sessao.sessionId,
        clientSecret: sessao.clientSecret,
      };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
