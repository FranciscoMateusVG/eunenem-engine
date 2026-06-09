import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import { encontrarOpcaoContribuicao } from '../../domain/arrecadacao/entities/campanha.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  criarContribuicao as criarContribuicaoEntity,
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
  // imagemUrl is a consumer-facing display reference — engine doesn't enforce
  // a URL shape because consumers may pass: absolute http(s) URLs (legacy/CDN),
  // same-origin paths (e.g. eunenem-server's /products/<id>.jpg), or future
  // opaque references (S3 keys, image-service ids). Length-bounded string only;
  // shape enforcement belongs at the consumer's API edge (e.g. eunenem-server's
  // tRPC router schema).
  imagemUrl: z.string().trim().min(1).max(500).nullable().optional(),
  grupo: z.string().trim().min(1).max(60).nullable().optional(),
  /**
   * Plan 0016 (aperture-putz5): slot capacity. Defaults to 1 (single-unit
   * slot, mirroring the pre-0016 default). The entity factory validates
   * `quantidade >= 1` at construction; a 5-of-Fralda-RN slot is one row
   * with quantidade=5, NOT five rows.
   */
  quantidade: z.number().int().min(1).max(100).optional(),
});

export type CriarContribuicaoInput = z.infer<typeof CriarContribuicaoInputSchema>;

export interface CriarContribuicaoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Administrador cria um slot de contribuição dentro de uma opção (sacola).
 *
 * Plan 0015 (aperture-ucgok): the entity factory was renamed from
 * `criarContribuicaoDisponivel` to `criarContribuicao` (the slot has no
 * status — there's nothing to qualify). Imported under the alias
 * `criarContribuicaoEntity` here so it doesn't collide with this
 * use-case's own export name.
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

      const { id, idCampanha, idOpcaoContribuicao, nome, valor, imagemUrl, grupo, quantidade } =
        parsed.data;

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

      const contribuicao = criarContribuicaoEntity({
        id,
        idCampanha,
        idOpcaoContribuicao,
        nome,
        valor,
        imagemUrl: imagemUrl ?? null,
        grupo: grupo ?? null,
        // exactOptionalPropertyTypes: only include quantidade when the
        // caller provided it; the entity factory defaults to 1.
        ...(quantidade !== undefined ? { quantidade } : {}),
        criadaEm: clock(),
      });

      await contribuicaoRepository.save(contribuicao);

      logger.info('arrecadacao.contribuicao.criada', {
        idContribuicao: id,
        idCampanha,
        idOpcaoContribuicao,
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
