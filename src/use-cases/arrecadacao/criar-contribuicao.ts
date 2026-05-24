import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import { encontrarOpcaoContribuicao } from '../../domain/arrecadacao/entities/campanha.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  criarContribuicaoDisponivel,
  LIMITE_CONTRIBUICOES_POR_OPCAO,
  NomeContribuicaoSchema,
} from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  IdCampanhaSchema,
  IdContribuicaoSchema,
  IdOpcaoContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../domain/money.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoJaExisteError } from '../../errors/arrecadacao/contribuicao-ja-existe.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoLimiteOpcaoExcedidoError } from '../../errors/arrecadacao/limite-opcao-excedido.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

export const CriarContribuicaoInputSchema = z.object({
  id: IdContribuicaoSchema,
  idCampanha: IdCampanhaSchema,
  idOpcaoContribuicao: IdOpcaoContribuicaoSchema,
  nome: NomeContribuicaoSchema,
  valor: MoneyCentsSchema,
  imagemUrl: z.url().nullable().optional(),
  grupo: z.string().trim().min(1).max(60).nullable().optional(),
});

export type CriarContribuicaoInput = z.infer<typeof CriarContribuicaoInputSchema>;

export interface CriarContribuicaoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Administrador cria um item de contribuição disponível dentro de uma opção (sacola).
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

      const { id, idCampanha, idOpcaoContribuicao, nome, valor, imagemUrl, grupo } = parsed.data;

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

      const total = await contribuicaoRepository.countByOpcao(idCampanha, idOpcaoContribuicao);
      if (total >= LIMITE_CONTRIBUICOES_POR_OPCAO) {
        throw new ArrecadacaoLimiteOpcaoExcedidoError(
          idCampanha,
          idOpcaoContribuicao,
          LIMITE_CONTRIBUICOES_POR_OPCAO,
          total,
        );
      }

      const contribuicao = criarContribuicaoDisponivel({
        id,
        idCampanha,
        idOpcaoContribuicao,
        nome,
        valor,
        imagemUrl: imagemUrl ?? null,
        grupo: grupo ?? null,
        criadaEm: clock(),
      });

      await contribuicaoRepository.save(contribuicao);

      logger.info('arrecadacao.contribuicao.criada', {
        idContribuicao: id,
        idCampanha,
        idOpcaoContribuicao,
        valor: contribuicao.valor,
        status: contribuicao.status,
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
