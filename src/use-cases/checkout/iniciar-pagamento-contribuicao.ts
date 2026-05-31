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
import { DadosContribuinteSchema } from '../../domain/arrecadacao/value-objects/dados-contribuinte.js';
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
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { CheckoutPlataformaMismatchError } from '../../errors/checkout/plataforma-mismatch.error.js';
import type { Observability } from '../../observability/observability.js';
import { associarContribuinteContribuicao } from '../arrecadacao/associar-contribuinte-contribuicao.js';
import { desassociarContribuinteContribuicao } from '../arrecadacao/desassociar-contribuinte-contribuicao.js';
import { criarIntencaoPagamento } from '../pagamentos/criar-intencao-pagamento.js';
import { calcularComposicaoValores } from '../taxas/calcular-composicao-valores.js';

export const IniciarPagamentoContribuicaoInputSchema = z.object({
  idPlataforma: IdPlataformaReferenciaSchema,
  idCampanha: IdCampanhaSchema,
  idContribuicao: IdContribuicaoSchema,
  contribuinte: DadosContribuinteSchema,
  metodo: MetodoPagamentoSchema,
  idPagamento: IdPagamentoSchema,
  idIntencaoPagamento: IdIntencaoPagamentoSchema,
  /**
   * URL the provider redirects the visitor to after they submit payment.
   * Use the literal `{CHECKOUT_SESSION_ID}` placeholder if the provider
   * supports it (Stripe substitutes it server-side). The caller (tRPC
   * layer) constructs this from the slug + sucesso route shape; the
   * use-case doesn't know URL conventions.
   *
   * Example: `https://eunenem.example/pagina/francisco/sucesso?session_id={CHECKOUT_SESSION_ID}`
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
 * Saga de checkout (write-side) — async session topology (aperture-xaha2).
 *
 * Step order:
 *   1. plataforma membership check (campanha.idPlataforma === input.idPlataforma)
 *   2. associarContribuinteContribuicao (Arrecadação) → status passa a `indisponivel`
 *   3. encontrarOpcaoContribuicao + calcularComposicaoValores (no DB writes)
 *   4. **checkoutSessionProvider.criarSessaoCheckout** → provider session,
 *      returns { sessionId, clientSecret, externalRef }
 *   5. criarIntencaoPagamento (Pagamentos) → pagamento pendente com snapshot
 *      + externalRef populated
 *
 * **Compensation:** if step 4 OR step 5 fails, call desassociarContribuinte
 * to revert step 2 — the contribuicao goes back to `disponivel`. A failed
 * step 4 leaves no provider-side state (Stripe session create is one-shot
 * with idempotencyKey = idPagamento, so a half-created session can't exist).
 * A failed step 5 leaves an orphaned provider session — it expires by the
 * provider's default TTL (Stripe: 24h) and self-cleans; no compensation
 * call needed.
 *
 * **Why criarSessaoCheckout before criarIntencaoPagamento, not after:**
 * Doing the network call first means a Stripe failure → no DB write for
 * Pagamento at all (cleaner state). Doing it after would leave an orphaned
 * pendente Pagamento with externalRef=null forever. We prefer "the
 * checkout never happened" over "the checkout half-happened."
 *
 * Returns the full set the tRPC layer needs to respond to the visitor.
 * The actual settlement (status → aprovado/rejeitado) is async via the
 * webhook (aperture-24n36).
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

      // step 1: plataforma membership check (no side effect yet)
      const campanha = await campanhaRepository.findById(parsed.idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(parsed.idCampanha);
      }
      if (campanha.idPlataforma !== parsed.idPlataforma) {
        throw new CheckoutPlataformaMismatchError(parsed.idPlataforma, campanha.idPlataforma);
      }

      // step 2: claim the contribuição (first write)
      const updated = await associarContribuinteContribuicao(
        { contribuicaoRepository, observability },
        { idContribuicao: parsed.idContribuicao, contribuinte: parsed.contribuinte },
      );

      try {
        // sanity: contribuição must belong to this campanha
        if (updated.idCampanha !== campanha.id) {
          throw new ArrecadacaoContribuicaoNaoEncontradaError(parsed.idContribuicao);
        }

        // step 3a: resolve tipo via the campanha's opção
        const opcao = encontrarOpcaoContribuicao(campanha, updated.idOpcaoContribuicao);
        if (!opcao) {
          throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(
            campanha.id,
            updated.idOpcaoContribuicao,
          );
        }

        // step 3b: compute composição (Taxas, plataforma + tipo scoped)
        const composicao = await calcularComposicaoValores(
          { provedorRegraTaxa, observability },
          {
            idPlataforma: parsed.idPlataforma,
            idContribuicao: parsed.idContribuicao,
            tipo: opcao.tipo,
            contributionAmountCents: updated.valor,
          },
        );

        // step 4: create the provider-side checkout session BEFORE the
        // Pagamento DB write. If this fails (network, auth, provider 5xx),
        // we compensate step 2 and exit cleanly — no orphan Pagamento row.
        const sessao = await checkoutSessionProvider.criarSessaoCheckout({
          idPagamento: parsed.idPagamento,
          idIntencaoPagamento: parsed.idIntencaoPagamento,
          idContribuicao: parsed.idContribuicao,
          idOpcaoContribuicao: updated.idOpcaoContribuicao,
          tipoOpcao: opcao.tipo,
          nomeItem: updated.nome,
          amountCents: composicao.totalPaidCents,
          metodo: parsed.metodo,
          contribuinte: parsed.contribuinte,
          returnUrl: parsed.returnUrl,
        });

        span.setAttribute('checkout.session.id', sessao.sessionId);

        // step 5: create the payment intent (snapshot locked here) with
        // externalRef populated so the webhook can resolve back to this
        // pagamento via PagamentoRepository.findByExternalRef.
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
          contribuicao: updated,
          pagamento,
          sessionId: sessao.sessionId,
          clientSecret: sessao.clientSecret,
        };
      } catch (downstreamError) {
        // compensation: revert the claim from step 2
        try {
          await desassociarContribuinteContribuicao(
            { contribuicaoRepository, observability },
            { idContribuicao: parsed.idContribuicao },
          );
          logger.info('checkout.pagamento.compensado', {
            idPlataforma: parsed.idPlataforma,
            idContribuicao: parsed.idContribuicao,
            motivo: (downstreamError as Error).message,
          });
        } catch (compensationError) {
          logger.info('checkout.pagamento.compensacao_falhou', {
            idPlataforma: parsed.idPlataforma,
            idContribuicao: parsed.idContribuicao,
            erroOriginal: (downstreamError as Error).message,
            erroCompensacao: (compensationError as Error).message,
          });
        }
        throw downstreamError;
      }
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
