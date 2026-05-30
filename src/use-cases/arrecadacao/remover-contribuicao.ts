import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import { contribuicaoDisponivel } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  IdCampanhaSchema,
  IdContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoContribuicaoNaoDisponivelError } from '../../errors/arrecadacao/contribuicao-nao-disponivel.error.js';
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
 *   - Status: apenas `disponivel` pode ser removida. Itens já reservados por
 *     um contribuinte NÃO podem ser deletados — preservar a evidência da
 *     reserva é parte da consistência da saga de checkout.
 */
export const RemoverContribuicaoInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
  idCampanhaEsperada: IdCampanhaSchema,
});

export type RemoverContribuicaoInput = z.infer<typeof RemoverContribuicaoInputSchema>;

export interface RemoverContribuicaoDeps {
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly observability: Observability;
}

export async function removerContribuicao(
  deps: RemoverContribuicaoDeps,
  input: RemoverContribuicaoInput,
): Promise<void> {
  const { contribuicaoRepository, observability } = deps;
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

      if (!contribuicaoDisponivel(existing)) {
        throw new ArrecadacaoContribuicaoNaoDisponivelError(idContribuicao);
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
