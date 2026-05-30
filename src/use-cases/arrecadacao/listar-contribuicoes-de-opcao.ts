import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  IdCampanhaSchema,
  IdOpcaoContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Lista as contribuições de uma (campanha, opção) (aperture-d6atj). Thin
 * wrapper sobre `ContribuicaoRepository.findByOpcao` que centraliza a regra
 * de "uma opção pertence sempre a uma única campanha" no input + adiciona o
 * span de use-case para observabilidade end-to-end (a procedure tRPC
 * `contribuicao.list` aparece como `listarContribuicoesDeOpcao` no Tempo).
 *
 * Autorização: o caller (eunenem-server tRPC) já resolveu a opção a partir
 * da sessão antes de chamar — esta use-case NÃO valida que o usuário tem
 * acesso à opção. É puramente leitura sobre par válido `(idCampanha,
 * idOpcao)` derivado upstream.
 */
export const ListarContribuicoesDeOpcaoInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idOpcaoContribuicao: IdOpcaoContribuicaoSchema,
});

export type ListarContribuicoesDeOpcaoInput = z.infer<typeof ListarContribuicoesDeOpcaoInputSchema>;

export interface ListarContribuicoesDeOpcaoDeps {
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly observability: Observability;
}

export async function listarContribuicoesDeOpcao(
  deps: ListarContribuicoesDeOpcaoDeps,
  input: ListarContribuicoesDeOpcaoInput,
): Promise<readonly Contribuicao[]> {
  const { contribuicaoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('listarContribuicoesDeOpcao', async (span) => {
    try {
      const parsed = ListarContribuicoesDeOpcaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha, idOpcaoContribuicao } = parsed.data;
      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.opcao.id', idOpcaoContribuicao);

      const contribuicoes = await contribuicaoRepository.findByOpcao(
        idCampanha,
        idOpcaoContribuicao,
      );

      span.setAttribute('arrecadacao.contribuicoes.count', contribuicoes.length);
      span.setStatus({ code: SpanStatusCode.OK });
      return contribuicoes;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
