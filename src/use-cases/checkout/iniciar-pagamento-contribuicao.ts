import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { CheckoutSessionProvider } from '../../adapters/pagamentos/checkout-session-provider.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { ProvedorRegraTaxa } from '../../adapters/taxas/regra-provider.js';
import { encontrarOpcaoContribuicao } from '../../domain/arrecadacao/entities/campanha.js';
import {
  type Contribuicao,
  contribuicaoDisponivel,
} from '../../domain/arrecadacao/entities/contribuicao.js';
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
import { ArrecadacaoContribuicaoNaoDisponivelError } from '../../errors/arrecadacao/contribuicao-nao-disponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { CheckoutPlataformaMismatchError } from '../../errors/checkout/plataforma-mismatch.error.js';
import type { Observability } from '../../observability/observability.js';
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
 * of-truth shape (aperture-m95f3 rework of aperture-xaha2's original flow).
 *
 * Step order:
 *   1. Plataforma membership check (campanha.idPlataforma === input.idPlataforma)
 *   2. Resolve contribuicao + opção (READ-ONLY, no claim yet)
 *      - Verify contribuicao exists, belongs to campanha, AND is currently
 *        disponivel (early-fail UX — refuses to mount Stripe iframe for an
 *        already-claimed gift; saves the visitor a payment they can't keep)
 *   3. encontrarOpcaoContribuicao + calcularComposicaoValores (no DB writes)
 *   4. **checkoutSessionProvider.criarSessaoCheckout** → provider session
 *   5. criarIntencaoPagamento (Pagamentos) → pagamento pendente with
 *      externalRef populated
 *
 * **Why no claim here (aperture-m95f3 architecture change):**
 *
 * The original (xaha2) saga claimed the contribuicao at step 2 — flipping
 * status to indisponivel as part of session-create. That coupled "visitor
 * initiated checkout" with "visitor owns the gift," which was wrong:
 * a visitor could abandon the iframe (close tab, Stripe-side timeout) and
 * the contribuicao would stay locked until manual intervention. Operator
 * caught this during live-walk testing (2026-05-30) — moving the claim
 * to the WEBHOOK (the moment the payment actually settles) means:
 *   - Abandoned sessions don't lock contribuicoes
 *   - Race condition between two concurrent visitors becomes "first
 *     successful payment wins" — clean, observable, handled by finalize
 *   - The visitor's nome/email/recadinho are collected inside Stripe's
 *     iframe (custom_fields + customer_creation), so we don't even know
 *     them at session-create time — there's no input to associate at
 *     this layer.
 *
 * **Compensation:** unchanged in spirit, but simpler in practice — there's
 * no claim to revert. If criarSessaoCheckout (step 4) or criarIntencaoPagamento
 * (step 5) fails, we just throw. The contribuicao was never touched.
 * Orphaned Stripe sessions self-expire via provider TTL.
 *
 * **Early-fail on indisponivel:** step 2 reads the contribuicao + bails
 * with ArrecadacaoContribuicaoNaoDisponivelError if it's already claimed.
 * This is a UX win, NOT a correctness gate — the webhook's finalize path
 * remains the source of truth (it must handle the race where two visitors
 * both pass this check, both mount Stripe, both pay; finalize tolerates
 * the second one's contribuicao-already-claimed branch). Without the
 * early check, visitors would routinely pay for already-claimed gifts in
 * any reasonable concurrency.
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
      if (!contribuicaoDisponivel(contribuicao)) {
        // UX-friendly early fail — don't make the visitor pay for a gift
        // someone else just bought. The webhook's finalize path is still
        // the correctness source-of-truth (handles the race when two
        // visitors both pass this check concurrently).
        throw new ArrecadacaoContribuicaoNaoDisponivelError(parsed.idContribuicao);
      }

      // step 3a: resolve tipo via the campanha's opção
      const opcao = encontrarOpcaoContribuicao(campanha, contribuicao.idOpcaoContribuicao);
      if (!opcao) {
        throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(
          campanha.id,
          contribuicao.idOpcaoContribuicao,
        );
      }

      // step 3b: compute composição (Taxas, plataforma + tipo scoped)
      const composicao = await calcularComposicaoValores(
        { provedorRegraTaxa, observability },
        {
          idPlataforma: parsed.idPlataforma,
          idContribuicao: parsed.idContribuicao,
          tipo: opcao.tipo,
          contributionAmountCents: contribuicao.valor,
        },
      );

      // step 4: provider-side checkout session. If this fails (network,
      // auth, provider 5xx), we just throw — nothing to compensate.
      const sessao = await checkoutSessionProvider.criarSessaoCheckout({
        idPagamento: parsed.idPagamento,
        idIntencaoPagamento: parsed.idIntencaoPagamento,
        idContribuicao: parsed.idContribuicao,
        idOpcaoContribuicao: contribuicao.idOpcaoContribuicao,
        tipoOpcao: opcao.tipo,
        nomeItem: contribuicao.nome,
        amountCents: composicao.totalPaidCents,
        metodo: parsed.metodo,
        returnUrl: parsed.returnUrl,
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
