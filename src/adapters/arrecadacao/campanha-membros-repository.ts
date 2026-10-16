import type { IdCampanha, IdConta } from '../../domain/arrecadacao/value-objects/ids.js';
import type {
  AcaoConcedivel,
  AcessoMembroCampanha,
} from '../../domain/arrecadacao/value-objects/permissao-campanha.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

export interface MembroCampanha extends AcessoMembroCampanha {
  readonly idConta: IdConta;
}

/**
 * Papéis + permissões dos administradores de uma campanha (porta,
 * aperture-1z18g). Persistidos na tabela irmã `campanha_membros_permissoes`;
 * só valem para contas que TAMBÉM estão em `campanha_administradores`.
 */
export interface CampanhaMembrosRepository {
  /**
   * Acesso da conta na campanha, ou `undefined` quando ela não é
   * administradora OU não tem linha de papel (fail-closed: sem direitos).
   */
  obterAcesso(
    idCampanha: IdCampanha,
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<AcessoMembroCampanha | undefined>;

  /** Todos os administradores da campanha que têm papel, owners primeiro. */
  listarMembros(
    idCampanha: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly MembroCampanha[]>;

  /**
   * Registra um novo membro com papel 'membro' e PERMISSOES_PADRAO_MEMBRO.
   * Idempotente: nunca rebaixa um owner nem zera permissões existentes.
   */
  adicionarMembro(
    idCampanha: IdCampanha,
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<void>;

  /** Remove o papel da conta (chamado junto com a remoção do administrador). */
  removerMembro(
    idCampanha: IdCampanha,
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<void>;

  /**
   * Substitui as permissões de um MEMBRO. Retorna `false` quando a conta não
   * tem papel 'membro' na campanha (owner ou inexistente) — nada é alterado.
   */
  definirPermissoes(
    idCampanha: IdCampanha,
    idConta: IdConta,
    permissoes: readonly AcaoConcedivel[],
    context?: ArrecadacaoRepositoryContext,
  ): Promise<boolean>;
}
