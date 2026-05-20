import { SpanStatusCode } from '@opentelemetry/api';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import {
  type AlterarDadosRecebedorCampanhaInput,
  AlterarDadosRecebedorCampanhaInputSchema,
  type Campanha,
  campanhaComDadosRecebedor,
} from '../../domain/arrecadacao/campanha.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export interface AlterarDadosRecebedorCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly observability: Observability;
}

/**
 * Altera os dados PIX do recebedor de uma campanha existente (`idRecebedor` inalterado).
 */
export async function alterarDadosRecebedorCampanha(
  deps: AlterarDadosRecebedorCampanhaDeps,
  input: AlterarDadosRecebedorCampanhaInput,
): Promise<Campanha> {
  const { campanhaRepository, observability } = deps;
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

      const updated = campanhaComDadosRecebedor(existing, dadosRecebedor);

      await campanhaRepository.save(updated);

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
