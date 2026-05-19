import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type {
  Campanha,
  CriarCampanhaInput,
  IdRecebedor,
} from '../../domain/arrecadacao/campanha.js';
import { CriarCampanhaInputSchema } from '../../domain/arrecadacao/campanha.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export interface CriarCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly clock: () => Date;
  readonly gerarIdRecebedor?: () => IdRecebedor;
  readonly observability: Observability;
}

/**
 * Cria uma campanha de arrecadação (agregado vazio de opções).
 */
export async function criarCampanha(
  deps: CriarCampanhaDeps,
  input: CriarCampanhaInput,
): Promise<Campanha> {
  const { campanhaRepository, clock, gerarIdRecebedor = randomUUID, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarCampanha', async (span) => {
    try {
      const parsed = CriarCampanhaInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      span.setAttribute('arrecadacao.campanha.id', parsed.data.id);
      span.setAttribute('arrecadacao.campanha.titulo.length', parsed.data.titulo.length);
      span.setAttribute(
        'arrecadacao.campanha.administradores.count',
        parsed.data.idsAdministradores.length,
      );
      span.setAttribute(
        'arrecadacao.recebedor.tipoChavePix',
        parsed.data.dadosRecebedor.tipoChavePix,
      );

      const idRecebedor = gerarIdRecebedor();

      const campanha: Campanha = {
        id: parsed.data.id,
        idsAdministradores: parsed.data.idsAdministradores,
        idRecebedor,
        dadosRecebedor: parsed.data.dadosRecebedor,
        titulo: parsed.data.titulo,
        opcoes: [],
        criadaEm: clock(),
      };

      await campanhaRepository.save(campanha);

      logger.info('arrecadacao.campanha.criada', {
        idCampanha: campanha.id,
        idRecebedor: campanha.idRecebedor,
        tipoChavePix: campanha.dadosRecebedor.tipoChavePix,
        tituloLength: campanha.titulo.length,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return campanha;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
