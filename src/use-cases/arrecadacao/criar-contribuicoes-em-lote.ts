import { randomUUID } from 'node:crypto';
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
 * Item de catálogo expandido em N contribuições (qty cópias do mesmo shape).
 * O caller (tRPC `contribuicao.createBulk`) já resolveu `idCampanha` +
 * `idOpcaoContribuicao` da sessão — itens só carregam o shape + qty.
 */
export const ItemLoteSchema = z.object({
  nome: NomeContribuicaoSchema,
  valor: MoneyCentsSchema,
  // See criar-contribuicao.ts for the rationale: engine is consumer-agnostic
  // on imagemUrl shape; consumers enforce format at their API edge.
  imagemUrl: z.string().trim().min(1).max(500).nullable().optional(),
  grupo: z.string().trim().min(1).max(60).nullable().optional(),
  qty: z.number().int().min(1).max(100),
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
 * Cria N contribuições em UM único INSERT (aperture-d6atj fix-up).
 *
 * Operator clarification post-shape-review: "Pacote de Fraldas RN qty=8" ou
 * "kit chá de bebê" (10 items × qty) precisam virar UMA query SQL, não 8 ou
 * 30 round-trips. Este use-case expande `items × qty` → N contribuições com
 * UUIDs frescos e chama `saveBulk` uma única vez.
 *
 * Invariantes preservadas:
 *   - Cap `LIMITE_CONTRIBUICOES_POR_OPCAO` é verificado contra o total
 *     PÓS-inserção (count atual + N). Se estourar, nenhuma linha persiste.
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

      const totalContribuicoes = items.reduce((sum, item) => sum + item.qty, 0);

      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.contribuicoes.items_count', items.length);
      span.setAttribute('arrecadacao.contribuicoes.bulk_size', totalContribuicoes);

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
      if (totalAtual + totalContribuicoes > LIMITE_CONTRIBUICOES_POR_OPCAO) {
        throw new ArrecadacaoLimiteOpcaoExcedidoError(
          idCampanha as IdCampanha,
          idOpcaoContribuicao as IdOpcaoContribuicao,
          LIMITE_CONTRIBUICOES_POR_OPCAO,
          totalAtual + totalContribuicoes,
        );
      }

      const criadaEm = clock();
      const contribuicoes: Contribuicao[] = [];
      const ids: IdContribuicao[] = [];

      for (const item of items) {
        for (let i = 0; i < item.qty; i++) {
          const id = randomUUID() as IdContribuicao;
          ids.push(id);
          contribuicoes.push(
            criarContribuicaoDisponivel({
              id,
              idCampanha: idCampanha as IdCampanha,
              idOpcaoContribuicao: idOpcaoContribuicao as IdOpcaoContribuicao,
              nome: item.nome,
              valor: item.valor,
              imagemUrl: item.imagemUrl ?? null,
              grupo: item.grupo ?? null,
              criadaEm,
            }),
          );
        }
      }

      await contribuicaoRepository.saveBulk(contribuicoes);

      logger.info('arrecadacao.contribuicoes.lote_criado', {
        idCampanha,
        idOpcaoContribuicao,
        itemsCount: items.length,
        bulkSize: totalContribuicoes,
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
