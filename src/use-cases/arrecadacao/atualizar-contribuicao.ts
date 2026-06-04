import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  contribuicaoAtualizada,
  NomeContribuicaoSchema,
} from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  IdCampanhaSchema,
  IdContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../domain/money.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoNaoAutorizadoError } from '../../errors/arrecadacao/nao-autorizado.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Patch genérico de uma contribuição existente (aperture-d6atj). Substitui o
 * caso de uso single-campo `alterarValorContribuicao` quando o caller precisa
 * atualizar múltiplos campos administrativos em uma única chamada (ex.: form
 * de edição no painel).
 *
 * Multi-tenant boundary: o caller é OBRIGADO a passar `idCampanhaEsperada`,
 * derivada da sessão do usuário. A use-case rejeita com
 * `ArrecadacaoNaoAutorizadoError` se a contribuição alvo pertence a OUTRA
 * campanha — fecha o cross-tenant write surface explicitamente, na camada
 * de domínio (procedure fica thin).
 *
**Plan 0015 (aperture-ucgok):** o guard `contribuicaoDisponivel` foi
 * removido. Sem status na contribuição, o admin pode editar a qualquer
 * momento. Uma slot com pagamento aprovado pode ter nome/valor editados;
 * o snapshot do pagamento existente preserva o valor que o contribuinte
 * pagou (composicaoValores é imutável). Trade-off com a operadora:
 * editar pode confundir admins que esperavam o guard antigo, mas o
 * modelo collapsed reflete que contribuição é uma slot — não o ato de
 * pagamento.
 */
export const AtualizarContribuicaoInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
  /**
   * Campanha-do-caller (derivada da sessão pelo adapter HTTP, NUNCA enviada
   * pelo cliente). A use-case compara contra `target.idCampanha` antes de
   * qualquer escrita — se divergir, é cross-tenant access e levanta
   * `ArrecadacaoNaoAutorizadoError`.
   */
  idCampanhaEsperada: IdCampanhaSchema,
  nome: NomeContribuicaoSchema.optional(),
  valor: MoneyCentsSchema.optional(),
  // See criar-contribuicao.ts for the rationale: engine is consumer-agnostic
  // on imagemUrl shape; consumers enforce format at their API edge.
  imagemUrl: z.string().trim().min(1).max(500).nullable().optional(),
  grupo: z.string().trim().min(1).max(60).nullable().optional(),
});

export type AtualizarContribuicaoInput = z.infer<typeof AtualizarContribuicaoInputSchema>;

export interface AtualizarContribuicaoDeps {
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly observability: Observability;
}

export async function atualizarContribuicao(
  deps: AtualizarContribuicaoDeps,
  input: AtualizarContribuicaoInput,
): Promise<Contribuicao> {
  const { contribuicaoRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('atualizarContribuicao', async (span) => {
    try {
      const parsed = AtualizarContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idContribuicao, idCampanhaEsperada, nome, valor, imagemUrl, grupo } = parsed.data;
      span.setAttribute('arrecadacao.contribuicao.id', idContribuicao);
      span.setAttribute('arrecadacao.campanha.id', idCampanhaEsperada);

      const existing = await contribuicaoRepository.findById(idContribuicao);
      if (!existing) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(idContribuicao);
      }

      // Cross-tenant guard FIRST — a request whose session resolves to
      // campanha A must NEVER cause a state change on a contribuição
      // belonging to campanha B, regardless of status. Order matters:
      // checking authorization before status leaks less than checking
      // status first (both errors are UNAUTHORIZED at the HTTP boundary,
      // but the authz check is conceptually upstream of the invariant).
      if (existing.idCampanha !== idCampanhaEsperada) {
        throw new ArrecadacaoNaoAutorizadoError(
          `Contribuicao ${idContribuicao} pertence a outra campanha`,
        );
      }

      // Plan 0015: no more status guard. Slot edits allowed at any time.

      const updated = contribuicaoAtualizada(existing, {
        nome,
        valor,
        imagemUrl,
        grupo,
      });

      await contribuicaoRepository.save(updated);

      logger.info('arrecadacao.contribuicao.atualizada', {
        idContribuicao,
        idCampanha: idCampanhaEsperada,
        camposAlterados: {
          nome: nome !== undefined,
          valor: valor !== undefined,
          imagemUrl: imagemUrl !== undefined,
          grupo: grupo !== undefined,
        },
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
