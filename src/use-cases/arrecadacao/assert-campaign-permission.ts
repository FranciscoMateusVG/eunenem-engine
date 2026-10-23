import { SpanStatusCode } from '@opentelemetry/api';
import type { CampanhaMembrosRepository } from '../../adapters/arrecadacao/campanha-membros-repository.js';
import type { ArrecadacaoRepositoryContext } from '../../adapters/arrecadacao/repository-context.js';
import type { IdCampanha, IdConta } from '../../domain/arrecadacao/value-objects/ids.js';
import {
  type AcaoCampanha,
  type AcessoMembroCampanha,
  acessoPermite,
} from '../../domain/arrecadacao/value-objects/permissao-campanha.js';
import { CampanhaPermissaoNegadaError } from '../../errors/arrecadacao/permissao-negada.error.js';
import type { Observability } from '../../observability/observability.js';

export interface AssertCampaignPermissionDeps {
  readonly campanhaMembrosRepository: CampanhaMembrosRepository;
  readonly observability: Observability;
}

export interface AssertCampaignPermissionInput {
  readonly idCampanha: IdCampanha;
  readonly idConta: IdConta;
  readonly acao: AcaoCampanha;
}

/**
 * ÚNICO ponto de autorização por ação em campanhas compartilhadas
 * (aperture-1z18g). Passa só se a conta é administradora da campanha E
 * (é owner OU recebeu a permissão `acao`). Sem papel registrado = sem
 * direitos (fail-closed). Lê o estado atual a cada chamada, então uma
 * revogação vale na próxima requisição.
 *
 * Passe `context.trx` para checar dentro da mesma transação da escrita.
 *
 * @returns o acesso efetivo da conta (útil para quem precisa do papel)
 * @throws CampanhaPermissaoNegadaError
 */
export async function assertCampaignPermission(
  deps: AssertCampaignPermissionDeps,
  input: AssertCampaignPermissionInput,
  context?: ArrecadacaoRepositoryContext,
): Promise<AcessoMembroCampanha> {
  const { campanhaMembrosRepository, observability } = deps;
  return observability.tracer.startActiveSpan('assertCampaignPermission', async (span) => {
    try {
      span.setAttribute('arrecadacao.campanha.id', input.idCampanha);
      span.setAttribute('arrecadacao.permissao.acao', input.acao);
      const acesso = await campanhaMembrosRepository.obterAcesso(
        input.idCampanha,
        input.idConta,
        context,
      );
      if (!acesso || !acessoPermite(acesso, input.acao)) {
        throw new CampanhaPermissaoNegadaError(input.acao);
      }
      span.setAttribute('arrecadacao.permissao.papel', acesso.papel);
      span.setStatus({ code: SpanStatusCode.OK });
      return acesso;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
