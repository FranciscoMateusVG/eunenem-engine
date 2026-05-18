import { SpanStatusCode } from '@opentelemetry/api';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import {
  type AdicionarOpcaoContribuicaoInput,
  AdicionarOpcaoContribuicaoInputSchema,
  type Campanha,
  campanhaComOpcao,
  type OpcaoContribuicao,
} from '../../domain/arrecadacao/campanha.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoOpcaoIdDuplicadoError } from '../../errors/arrecadacao/opcao-id-duplicado.error.js';
import type { Observability } from '../../observability/observability.js';

export interface AdicionarOpcaoContribuicaoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly observability: Observability;
}

/**
 * Adiciona uma opção de contribuição a uma campanha existente.
 */
export async function adicionarOpcaoContribuicao(
  deps: AdicionarOpcaoContribuicaoDeps,
  input: AdicionarOpcaoContribuicaoInput,
): Promise<Campanha> {
  const { campanhaRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('adicionarOpcaoContribuicao', async (span) => {
    try {
      const parsed = AdicionarOpcaoContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha, idOpcao, amountCents, rotulo } = parsed.data;

      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.opcao.id', idOpcao);

      const existing = await campanhaRepository.findById(idCampanha);
      if (!existing) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(idCampanha);
      }

      if (existing.opcoes.some((o) => o.id === idOpcao)) {
        throw new ArrecadacaoOpcaoIdDuplicadoError(idOpcao);
      }

      const opcao: OpcaoContribuicao =
        rotulo === undefined ? { id: idOpcao, amountCents } : { id: idOpcao, amountCents, rotulo };
      const updated = campanhaComOpcao(existing, opcao);

      await campanhaRepository.save(updated);

      logger.info('arrecadacao.campanha.opcao_adicionada', {
        idCampanha,
        idOpcao,
        amountCents,
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
