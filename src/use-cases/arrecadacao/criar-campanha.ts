import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { RecebedorRepository } from '../../adapters/arrecadacao/recebedor-repository.js';
import type { PlataformaRepository } from '../../adapters/plataforma/repository.js';
import {
  type Campanha,
  campanhaComRecebedorInicial,
  criarCampanhaSemRecebedor,
} from '../../domain/arrecadacao/entities/campanha.js';
import { criarRecebedorInicial } from '../../domain/arrecadacao/entities/recebedor.js';
import { DadosRecebedorSchema } from '../../domain/arrecadacao/value-objects/dados-recebedor.js';
import {
  IdCampanhaSchema,
  IdPlataformaReferenciaSchema,
  type IdRecebedor,
} from '../../domain/arrecadacao/value-objects/ids.js';
import { IdsAdministradoresSchema } from '../../domain/arrecadacao/value-objects/ids-administradores.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoPlataformaNaoEncontradaError } from '../../errors/arrecadacao/plataforma-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';
import {
  type ExecutarTransacaoArrecadacao,
  executarTransacaoSequencial,
} from './executar-transacao-arrecadacao.js';

export const CriarCampanhaInputSchema = z.object({
  id: IdCampanhaSchema,
  idPlataforma: IdPlataformaReferenciaSchema,
  idsAdministradores: IdsAdministradoresSchema,
  /**
   * Recebedor é opcional: uma campanha pode existir sem dados PIX
   * (auto-create no signup, p.ex.). Só o repasse exige presença.
   */
  dadosRecebedor: DadosRecebedorSchema.optional(),
  titulo: z.string().trim().min(1, 'Titulo nao pode ser vazio').max(200),
});

export type CriarCampanhaInput = z.infer<typeof CriarCampanhaInputSchema>;

export interface CriarCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly plataformaRepository: PlataformaRepository;
  readonly clock: () => Date;
  readonly gerarIdRecebedor?: () => IdRecebedor;
  readonly executarTransacao?: ExecutarTransacaoArrecadacao;
  readonly observability: Observability;
}

/**
 * Cria uma campanha de arrecadação (agregado vazio de opções). Quando
 * `dadosRecebedor` é fornecido, o recebedor inicial ativo é criado na
 * mesma transação. Sem `dadosRecebedor`, a campanha nasce sem projeção
 * de Recebedor — válido para o ciclo de vida pré-bank-info.
 */
export async function criarCampanha(
  deps: CriarCampanhaDeps,
  input: CriarCampanhaInput,
): Promise<Campanha> {
  const {
    campanhaRepository,
    recebedorRepository,
    plataformaRepository,
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
      span.setAttribute('arrecadacao.plataforma.id', parsed.data.idPlataforma);
      span.setAttribute('arrecadacao.campanha.titulo.length', parsed.data.titulo.length);
      span.setAttribute(
        'arrecadacao.campanha.administradores.count',
        parsed.data.idsAdministradores.length,
      );
      span.setAttribute(
        'arrecadacao.campanha.com_recebedor',
        parsed.data.dadosRecebedor !== undefined,
      );
      const dadosRecebedorAttr = parsed.data.dadosRecebedor;
      if (dadosRecebedorAttr) {
        span.setAttribute('arrecadacao.recebedor.metodo', dadosRecebedorAttr.metodo);
      }
      if (dadosRecebedorAttr?.metodo === 'pix') {
        span.setAttribute('arrecadacao.recebedor.tipoChavePix', dadosRecebedorAttr.tipoChavePix);
      }

      const plataforma = await plataformaRepository.findById(parsed.data.idPlataforma);
      if (!plataforma) {
        throw new ArrecadacaoPlataformaNaoEncontradaError(parsed.data.idPlataforma);
      }

      const criadaEm = clock();

      const baseCampanha = {
        id: parsed.data.id,
        idPlataforma: parsed.data.idPlataforma,
        idsAdministradores: parsed.data.idsAdministradores,
        titulo: parsed.data.titulo,
        opcoes: [],
        criadaEm,
      };

      let campanha: Campanha;
      if (parsed.data.dadosRecebedor) {
        const recebedor = criarRecebedorInicial({
          id: gerarIdRecebedor(),
          idCampanha: parsed.data.id,
          dadosRecebedor: parsed.data.dadosRecebedor,
          criadaEm,
        });
        campanha = campanhaComRecebedorInicial({ ...baseCampanha, recebedor });

        await executarTransacao(async (ctx) => {
          await campanhaRepository.save(campanha, ctx);
          await recebedorRepository.save(recebedor, ctx);
        });
      } else {
        campanha = criarCampanhaSemRecebedor(baseCampanha);

        await executarTransacao(async (ctx) => {
          await campanhaRepository.save(campanha, ctx);
        });
      }

      logger.info('arrecadacao.campanha.criada', {
        idCampanha: campanha.id,
        idPlataforma: campanha.idPlataforma,
        idRecebedor: campanha.idRecebedor,
        metodo: campanha.dadosRecebedor?.metodo ?? null,
        tipoChavePix:
          campanha.dadosRecebedor?.metodo === 'pix' ? campanha.dadosRecebedor.tipoChavePix : null,
        tituloLength: campanha.titulo.length,
        comRecebedor: campanha.idRecebedor !== null,
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
