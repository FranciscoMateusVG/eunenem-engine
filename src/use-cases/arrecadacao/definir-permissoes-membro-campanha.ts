import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaMembrosRepository } from '../../adapters/arrecadacao/campanha-membros-repository.js';
import type { ArrecadacaoRepositoryContext } from '../../adapters/arrecadacao/repository-context.js';
import { IdCampanhaSchema, IdContaSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import { AcaoConcedivelSchema } from '../../domain/arrecadacao/value-objects/permissao-campanha.js';
import { ArrecadacaoAdministradorNaoEncontradoError } from '../../errors/arrecadacao/administrador-nao-encontrado.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';
import { assertCampaignPermission } from './assert-campaign-permission.js';

export const DefinirPermissoesMembroCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  /** Conta do caller (sessão) — precisa ser owner. */
  idContaCaller: IdContaSchema,
  /** Conta do membro cujas permissões serão substituídas. */
  idContaMembro: IdContaSchema,
  permissoes: z.array(AcaoConcedivelSchema).max(10),
});

export type DefinirPermissoesMembroCampanhaInput = z.infer<
  typeof DefinirPermissoesMembroCampanhaInputSchema
>;

export interface DefinirPermissoesMembroCampanhaDeps {
  readonly campanhaMembrosRepository: CampanhaMembrosRepository;
  readonly observability: Observability;
}

/**
 * Owner substitui o conjunto de permissões de um membro (aperture-1z18g).
 * Só o owner (`membros:gerenciar`); o alvo precisa ser um 'membro' da
 * campanha — owners não têm permissões configuráveis.
 *
 * Passe `context.trx` (com a linha da campanha travada FOR UPDATE, mesma
 * ordem de lock do fluxo de convites) para checar e gravar atomicamente.
 */
export async function definirPermissoesMembroCampanha(
  deps: DefinirPermissoesMembroCampanhaDeps,
  input: DefinirPermissoesMembroCampanhaInput,
  context?: ArrecadacaoRepositoryContext,
): Promise<void> {
  const { campanhaMembrosRepository, observability } = deps;
  const { logger, tracer } = observability;
  return tracer.startActiveSpan('definirPermissoesMembroCampanha', async (span) => {
    try {
      const parsed = DefinirPermissoesMembroCampanhaInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new ArrecadacaoInputInvalidoError(
          parsed.error.issues.map((i) => i.message).join('; '),
        );
      }
      const { idCampanha, idContaCaller, idContaMembro, permissoes } = parsed.data;
      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.permissao.count', permissoes.length);

      await assertCampaignPermission(
        deps,
        {
          idCampanha,
          idConta: idContaCaller,
          acao: 'membros:gerenciar',
        },
        context,
      );

      const alterado = await campanhaMembrosRepository.definirPermissoes(
        idCampanha,
        idContaMembro,
        permissoes,
        context,
      );
      if (!alterado) {
        throw new ArrecadacaoAdministradorNaoEncontradoError(idContaMembro);
      }

      logger.info('arrecadacao.campanha.permissoes_membro_definidas', {
        idCampanha,
        quantidade: permissoes.length,
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
