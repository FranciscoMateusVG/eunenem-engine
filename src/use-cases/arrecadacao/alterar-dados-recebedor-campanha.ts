import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { RecebedorRepository } from '../../adapters/arrecadacao/recebedor-repository.js';
import {
  type AlterarDadosRecebedorCampanhaInput,
  AlterarDadosRecebedorCampanhaInputSchema,
  type Campanha,
  campanhaComRecebedorAtivo,
} from '../../domain/arrecadacao/campanha.js';
import {
  criarNovoRecebedor,
  desativarRecebedor,
  type IdRecebedor,
} from '../../domain/arrecadacao/recebedor.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoRecebedorNaoEncontradoError } from '../../errors/arrecadacao/recebedor-nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';
import {
  type ExecutarTransacaoArrecadacao,
  executarTransacaoSequencial,
} from './executar-transacao-arrecadacao.js';

export interface AlterarDadosRecebedorCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly clock: () => Date;
  readonly gerarIdRecebedor?: () => IdRecebedor;
  readonly executarTransacao?: ExecutarTransacaoArrecadacao;
  readonly observability: Observability;
}

/**
 * Altera os dados PIX do recebedor: desativa o recebedor ativo e cria novo recebedor para a mesma campanha.
 */
export async function alterarDadosRecebedorCampanha(
  deps: AlterarDadosRecebedorCampanhaDeps,
  input: AlterarDadosRecebedorCampanhaInput,
): Promise<Campanha> {
  const {
    campanhaRepository,
    recebedorRepository,
    clock,
    gerarIdRecebedor = randomUUID,
    executarTransacao = executarTransacaoSequencial,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('alterarDadosRecebedorCampanha', async (span) => {
    try {
      const parsed = AlterarDadosRecebedorCampanhaInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha, dadosRecebedor } = parsed.data;

      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.recebedor.tipoChavePix', dadosRecebedor.tipoChavePix);

      const existing = await campanhaRepository.findById(idCampanha);
      if (!existing) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(idCampanha);
      }

      const ativo = await recebedorRepository.findAtivoByCampanhaId(idCampanha);
      if (!ativo) {
        throw new ArrecadacaoRecebedorNaoEncontradoError(idCampanha);
      }

      const desativado = desativarRecebedor(ativo);
      const novo = criarNovoRecebedor({
        idCampanha,
        dadosRecebedor,
        gerarId: gerarIdRecebedor,
        criadaEm: clock(),
      });

      await executarTransacao(async (ctx) => {
        await recebedorRepository.save(desativado, ctx);
        await recebedorRepository.save(novo, ctx);
      });

      const updated = campanhaComRecebedorAtivo(existing, novo);

      span.setAttribute('arrecadacao.recebedor.id', updated.idRecebedor);

      logger.info('arrecadacao.campanha.recebedor_alterado', {
        idCampanha,
        idRecebedor: updated.idRecebedor,
        tipoChavePix: dadosRecebedor.tipoChavePix,
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
