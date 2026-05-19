import { SpanStatusCode } from '@opentelemetry/api';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import { encontrarOpcaoContribuicao } from '../../domain/arrecadacao/campanha.js';
import type {
  Contribuicao,
  CriarContribuicaoInput,
} from '../../domain/arrecadacao/contribuicao.js';
import { CriarContribuicaoInputSchema } from '../../domain/arrecadacao/contribuicao.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoJaExisteError } from '../../errors/arrecadacao/contribuicao-ja-existe.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

export interface CriarContribuicaoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Regista uma contribuição de visitante a partir de uma opção da campanha (valor copiado da opção).
 */
export async function criarContribuicao(
  deps: CriarContribuicaoDeps,
  input: CriarContribuicaoInput,
): Promise<Contribuicao> {
  const { campanhaRepository, contribuicaoRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarContribuicao', async (span) => {
    try {
      const parsed = CriarContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { id, idCampanha, idOpcaoContribuicao, contribuinte } = parsed.data;

      span.setAttribute('arrecadacao.contribuicao.id', id);
      span.setAttribute('arrecadacao.campanha.id', idCampanha);

      const existingContribution = await contribuicaoRepository.findById(id);
      if (existingContribution) {
        throw new ArrecadacaoContribuicaoJaExisteError(id);
      }

      const campanha = await campanhaRepository.findById(idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(idCampanha);
      }

      const opcao = encontrarOpcaoContribuicao(campanha, idOpcaoContribuicao);
      if (!opcao) {
        throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(idCampanha, idOpcaoContribuicao);
      }

      const contribuicao: Contribuicao = {
        id,
        idCampanha,
        idOpcaoContribuicao,
        valor: opcao.valor,
        contribuinte,
        status: 'pendente_pagamento',
        criadaEm: clock(),
      };

      await contribuicaoRepository.save(contribuicao);

      logger.info('arrecadacao.contribuicao.criada', {
        idContribuicao: id,
        idCampanha,
        valor: contribuicao.valor,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return contribuicao;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
