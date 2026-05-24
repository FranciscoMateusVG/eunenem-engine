import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
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
});

export type IniciarPagamentoContribuicaoInput = z.infer<
  typeof IniciarPagamentoContribuicaoInputSchema
>;

export interface IniciarPagamentoContribuicaoResult {
  readonly contribuicao: Contribuicao;
  readonly pagamento: Pagamento;
}

export interface IniciarPagamentoContribuicaoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Saga de checkout (write-side): o contribuinte clica "quero este item" e o
 * orquestrador compõe três BCs em sequência:
 *   1. plataforma membership check (campanha.idPlataforma === input.idPlataforma)
 *   2. associarContribuinteContribuicao (Arrecadação) → status passa a `indisponivel`
 *   3. calcularComposicaoValores (Taxas, plataforma+tipo escopado) → snapshot
 *   4. criarIntencaoPagamento (Pagamentos) → pagamento pendente com snapshot
 *
 * Se o passo 3 ou 4 falhar, **compensa** chamando desassociarContribuinte
 * (Arrecadação) — a contribuição volta a `disponivel`, nenhum pagamento
 * é criado. Falha de compensação é logada mas não substitui o erro original.
 *
 * Para no estado "intenção pendente criada"; aprovação é Phase 3.
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

        // step 4: create the payment intent (snapshot locked here)
        const pagamento = await criarIntencaoPagamento(
          { pagamentoRepository, pagamentoEventPublisher, clock, observability },
          {
            idPagamento: parsed.idPagamento,
            idIntencaoPagamento: parsed.idIntencaoPagamento,
            composicaoValores: composicao,
            valorACobrarCents: composicao.totalPaidCents,
            metodo: parsed.metodo,
          },
        );

        logger.info('checkout.pagamento.iniciado', {
          idPlataforma: parsed.idPlataforma,
          idCampanha: campanha.id,
          idContribuicao: parsed.idContribuicao,
          idPagamento: pagamento.id,
          tipoOpcao: opcao.tipo,
          totalPaidCents: composicao.totalPaidCents,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return { contribuicao: updated, pagamento };
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
