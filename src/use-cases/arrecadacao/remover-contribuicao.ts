import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  IdCampanhaSchema,
  IdContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoContribuicaoIndisponivelError } from '../../errors/arrecadacao/contribuicao-indisponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoNaoAutorizadoError } from '../../errors/arrecadacao/nao-autorizado.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Remove uma contribuição (aperture-d6atj). Use-case granular — a procedure
 * tRPC `contribuicao.delete` itera sobre uma lista de ids e chama esta
 * use-case por id (atomicidade por item; o `tx` por batch seria uma
 * mudança maior — ver §3 do recon, fora do escopo desta bead).
 *
 * Guards:
 *   - Cross-tenant: `target.idCampanha !== idCampanhaEsperada` → não-autorizado.
 *   - Pagamento-aprovado: a slot com pelo menos um pagamento aprovado NÃO
 *     pode ser deletada — preservar a integridade referencial dos
 *     lançamentos financeiros + a auditoria do contribuinte que pagou.
 *     Plan 0015 (aperture-ucgok): substitui o velho status-guard (gone)
 *     pelo EXISTS-predicate sobre pagamentos.
 */
export const RemoverContribuicaoInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
  idCampanhaEsperada: IdCampanhaSchema,
});

export type RemoverContribuicaoInput = z.infer<typeof RemoverContribuicaoInputSchema>;

export interface RemoverContribuicaoDeps {
  readonly contribuicaoRepository: ContribuicaoRepository;
  // Plan 0015: needed for the indisponivel EXISTS check.
  readonly pagamentoRepository: PagamentoRepository;
  readonly observability: Observability;
}

export async function removerContribuicao(
  deps: RemoverContribuicaoDeps,
  input: RemoverContribuicaoInput,
): Promise<void> {
  const { contribuicaoRepository, pagamentoRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('removerContribuicao', async (span) => {
    try {
      const parsed = RemoverContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idContribuicao, idCampanhaEsperada } = parsed.data;
      span.setAttribute('arrecadacao.contribuicao.id', idContribuicao);
      span.setAttribute('arrecadacao.campanha.id', idCampanhaEsperada);

      const existing = await contribuicaoRepository.findById(idContribuicao);
      if (!existing) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(idContribuicao);
      }

      if (existing.idCampanha !== idCampanhaEsperada) {
        throw new ArrecadacaoNaoAutorizadoError(
          `Contribuicao ${idContribuicao} pertence a outra campanha`,
        );
      }

      // Plan 0016 (aperture-eg1s2): refuse delete if ANY contribuição-tipo
      // item across aprovado pagamentos references this slot. Same
      // protective intent as the pre-0016 binary check; the new shape
      // sums quantidade per slot — any positive sum means the slot was
      // sold and must not be removed (the lançamento ledger still
      // references it).
      const sold = await pagamentoRepository.somarQuantidadesContribuicoesEmPagamentosAprovados([
        idContribuicao,
      ]);
      const quantidadeVendida = sold.get(idContribuicao) ?? 0;
      if (quantidadeVendida > 0) {
        throw new ArrecadacaoContribuicaoIndisponivelError(idContribuicao);
      }

      await contribuicaoRepository.deleteById(idContribuicao);

      logger.info('arrecadacao.contribuicao.removida', {
        idContribuicao,
        idCampanha: idCampanhaEsperada,
      });

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
