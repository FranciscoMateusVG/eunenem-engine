import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { RecebedorRepository } from '../../adapters/arrecadacao/recebedor-repository.js';
import {
  type Campanha,
  campanhaComRecebedorInicial,
} from '../../domain/arrecadacao/entities/campanha.js';
import { criarRecebedorInicial } from '../../domain/arrecadacao/entities/recebedor.js';
import { DadosRecebedorSchema } from '../../domain/arrecadacao/value-objects/dados-recebedor.js';
import { IdCampanhaSchema, type IdRecebedor } from '../../domain/arrecadacao/value-objects/ids.js';
import { IdsAdministradoresSchema } from '../../domain/arrecadacao/value-objects/ids-administradores.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';
import {
  type ExecutarTransacaoArrecadacao,
  executarTransacaoSequencial,
} from './executar-transacao-arrecadacao.js';

export const CriarCampanhaInputSchema = z.object({
  id: IdCampanhaSchema,
  idsAdministradores: IdsAdministradoresSchema,
  dadosRecebedor: DadosRecebedorSchema,
  titulo: z.string().trim().min(1, 'Titulo nao pode ser vazio').max(200),
});

export type CriarCampanhaInput = z.infer<typeof CriarCampanhaInputSchema>;

export interface CriarCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly clock: () => Date;
  readonly gerarIdRecebedor?: () => IdRecebedor;
  readonly executarTransacao?: ExecutarTransacaoArrecadacao;
  readonly observability: Observability;
}

/**
 * Cria uma campanha de arrecadação (agregado vazio de opções) e o recebedor inicial ativo.
 */
export async function criarCampanha(
  deps: CriarCampanhaDeps,
  input: CriarCampanhaInput,
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

      const criadaEm = clock();
      const recebedor = criarRecebedorInicial({
        id: gerarIdRecebedor(),
        idCampanha: parsed.data.id,
        dadosRecebedor: parsed.data.dadosRecebedor,
        criadaEm,
      });

      const campanha = campanhaComRecebedorInicial({
        id: parsed.data.id,
        idsAdministradores: parsed.data.idsAdministradores,
        titulo: parsed.data.titulo,
        opcoes: [],
        criadaEm,
        recebedor,
      });

      await executarTransacao(async (ctx) => {
        await campanhaRepository.save(campanha, ctx);
        await recebedorRepository.save(recebedor, ctx);
      });

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
