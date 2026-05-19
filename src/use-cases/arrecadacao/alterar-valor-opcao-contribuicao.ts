import { SpanStatusCode } from '@opentelemetry/api';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import {
  type AlterarValorOpcaoContribuicaoInput,
  AlterarValorOpcaoContribuicaoInputSchema,
  type Campanha,
  campanhaComOpcaoValor,
  encontrarOpcaoContribuicao,
} from '../../domain/arrecadacao/campanha.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

export interface AlterarValorOpcaoContribuicaoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly observability: Observability;
}

/**
 * Altera o valor de uma opção de contribuição existente na campanha.
 */
export async function alterarValorOpcaoContribuicao(
  deps: AlterarValorOpcaoContribuicaoDeps,
  input: AlterarValorOpcaoContribuicaoInput,
): Promise<Campanha> {
  const { campanhaRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('alterarValorOpcaoContribuicao', async (span) => {
    try {
      const parsed = AlterarValorOpcaoContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha, idOpcao, valor } = parsed.data;

      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.opcao.id', idOpcao);
      span.setAttribute('arrecadacao.opcao.valor', valor);

      const existing = await campanhaRepository.findById(idCampanha);
      if (!existing) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(idCampanha);
      }

      if (!encontrarOpcaoContribuicao(existing, idOpcao)) {
        throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(idCampanha, idOpcao);
      }

      const updated = campanhaComOpcaoValor(existing, idOpcao, valor);

      await campanhaRepository.save(updated);

      logger.info('arrecadacao.campanha.opcao_valor_alterado', {
        idCampanha,
        idOpcao,
        valor,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return updated;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
