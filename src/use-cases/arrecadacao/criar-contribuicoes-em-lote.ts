import { randomUUID } from 'node:crypto';
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
  type IdCampanha,
  IdCampanhaSchema,
  type IdContribuicao,
  type IdOpcaoContribuicao,
  IdOpcaoContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../domain/money.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoLimiteOpcaoExcedidoError } from '../../errors/arrecadacao/limite-opcao-excedido.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Item de catálogo persisted como UMA contribuição com `quantidade=N`.
 * O caller (tRPC `contribuicao.createBulk`) já resolveu `idCampanha` +
 * `idOpcaoContribuicao` da sessão — itens só carregam o shape + quantidade.
 *
 * Plan 0016 (aperture-putz5 / aperture-1l37i): pre-0016, "qty: 8 fraldas"
 * expandia em 8 linhas de quantidade=1 (o workaround do modelo single-unit).
 * Pós-0016, "quantidade: 8 fraldas" é UMA linha — locked decision #1.
 * O cap `LIMITE_CONTRIBUICOES_POR_OPCAO` agora é sobre número de slots
 * distintos por opção, não sobre soma de unidades.
 */
export const ItemLoteSchema = z.object({
  nome: NomeContribuicaoSchema,
  valor: MoneyCentsSchema,
  // See criar-contribuicao.ts for the rationale: engine is consumer-agnostic
  // on imagemUrl shape; consumers enforce format at their API edge.
  imagemUrl: z.string().trim().min(1).max(500).nullable().optional(),
  grupo: z.string().trim().min(1).max(60).nullable().optional(),
  /**
   * Slot capacity for this contribuição. Defaults to 1 if omitted (single
   * unit, e.g. "kit chá de bebê" presets where each item is qty=1).
   */
  quantidade: z.number().int().min(1).max(100).optional(),
});

export type ItemLote = z.infer<typeof ItemLoteSchema>;

export const CriarContribuicoesEmLoteInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idOpcaoContribuicao: IdOpcaoContribuicaoSchema,
  items: z.array(ItemLoteSchema).min(1).max(50),
});

export type CriarContribuicoesEmLoteInput = z.infer<typeof CriarContribuicoesEmLoteInputSchema>;

export interface CriarContribuicoesEmLoteDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface CriarContribuicoesEmLoteResult {
  readonly ids: IdContribuicao[];
}

/**
 * Cria N slots de contribuição em UM único INSERT (aperture-d6atj fix-up;
 * Plan 0016 aperture-putz5 single-row + quantidade migration).
 *
 * Operator clarification post-shape-review: "Pacote de Fraldas RN
 * quantidade=8" ou "kit chá de bebê" (10 items, each quantidade=1) precisam
 * virar UMA query SQL, não 8 ou 10 round-trips. Pós-0016 cada item produz
 * UMA linha com `quantidade=N` (não N linhas com `quantidade=1`); o use-case
 * faz `items.length` linhas e chama `saveBulk` uma única vez.
 *
 * Invariantes preservadas:
 *   - Cap `LIMITE_CONTRIBUICOES_POR_OPCAO` é sobre número de slots
 *     distintos por opção (rows), não soma de unidades. Verificado contra
 *     o total PÓS-inserção (count atual + items.length). Se estourar,
 *     nenhuma linha persiste.
 *   - Mesma validação de campanha + opção que `criarContribuicao` (single).
 *   - `saveBulk` é atomic — se uma linha falha (FK, unique), nenhuma
 *     persiste.
 *
 * Diferenças deliberadas vs `criarContribuicao`:
 *   - Não recebe `id` no input (use-case minta UUID por contribuição).
 *   - Não checa duplicação prévia por id (ids são frescos, colisão ~0).
 *   - Não loga por contribuição (1 log de batch com size).
 */
export async function criarContribuicoesEmLote(
  deps: CriarContribuicoesEmLoteDeps,
  input: CriarContribuicoesEmLoteInput,
): Promise<CriarContribuicoesEmLoteResult> {
  const { campanhaRepository, contribuicaoRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarContribuicoesEmLote', async (span) => {
    try {
      const parsed = CriarContribuicoesEmLoteInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha, idOpcaoContribuicao, items } = parsed.data;

      // Plan 0016 (aperture-putz5): one row per item with `quantidade=N`.
      // The cap below counts rows in the opção, not units across rows.
      const totalSlots = items.length;
      const totalUnidades = items.reduce((sum, item) => sum + (item.quantidade ?? 1), 0);

      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.contribuicoes.items_count', totalSlots);
      span.setAttribute('arrecadacao.contribuicoes.total_unidades', totalUnidades);

      const campanha = await campanhaRepository.findById(idCampanha as IdCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(idCampanha as IdCampanha);
      }

      const opcao = encontrarOpcaoContribuicao(
        campanha,
        idOpcaoContribuicao as IdOpcaoContribuicao,
      );
      if (!opcao) {
        throw new ArrecadacaoOpcaoContribuicaoNaoEncontradaError(
          idCampanha as IdCampanha,
          idOpcaoContribuicao as IdOpcaoContribuicao,
        );
      }

      const totalAtual = await contribuicaoRepository.countByOpcao(
        idCampanha as IdCampanha,
        idOpcaoContribuicao as IdOpcaoContribuicao,
      );
      if (totalAtual + totalSlots > LIMITE_CONTRIBUICOES_POR_OPCAO) {
        throw new ArrecadacaoLimiteOpcaoExcedidoError(
          idCampanha as IdCampanha,
          idOpcaoContribuicao as IdOpcaoContribuicao,
          LIMITE_CONTRIBUICOES_POR_OPCAO,
          totalAtual + totalSlots,
        );
      }

      const criadaEm = clock();
      const contribuicoes: Contribuicao[] = [];
      const ids: IdContribuicao[] = [];

      // Plan 0016 (aperture-putz5): one row per item, quantidade=N.
      // Pre-0016 looped `for (let i=0; i<item.qty; i++)` emitting N
      // identical rows; locked decision #1 retires that pattern.
      for (const item of items) {
        const id = randomUUID() as IdContribuicao;
        ids.push(id);
        contribuicoes.push(
          criarContribuicaoEntity({
            id,
            idCampanha: idCampanha as IdCampanha,
            idOpcaoContribuicao: idOpcaoContribuicao as IdOpcaoContribuicao,
            nome: item.nome,
            valor: item.valor,
            imagemUrl: item.imagemUrl ?? null,
            grupo: item.grupo ?? null,
            quantidade: item.quantidade ?? 1,
            criadaEm,
          }),
        );
      }

      await contribuicaoRepository.saveBulk(contribuicoes);

      logger.info('arrecadacao.contribuicoes.lote_criado', {
        idCampanha,
        idOpcaoContribuicao,
        itemsCount: totalSlots,
        totalUnidades,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { ids };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
