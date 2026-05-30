import type { Campanha } from '../../domain/arrecadacao/entities/campanha.js';
import type {
  IdCampanha,
  IdConta,
  IdPlataformaReferencia,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

/**
 * Persistência do agregado Campanha (porta).
 */
export interface CampanhaRepository {
  save(campanha: Campanha, context?: ArrecadacaoRepositoryContext): Promise<void>;
  findById(id: IdCampanha, context?: ArrecadacaoRepositoryContext): Promise<Campanha | undefined>;
  findByPlataforma(
    idPlataforma: IdPlataformaReferencia,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Campanha[]>;

  /**
   * Returns the first Campanha that has `idConta` in its `idsAdministradores`,
   * or undefined if none. Used by the `auth.me` tRPC procedure (and the
   * p8i01 backfill script) to resolve a logged-in user to their default
   * "Lista de presentes" campanha in one round-trip.
   *
   * Today each user has exactly one campanha (auto-created by the signup
   * saga in aperture-p8i01). "First" by `criadaEm ASC` keeps the contract
   * deterministic even if a future feature lets a user own multiple lists.
   */
  findFirstByAdministrador(
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined>;

  /**
   * Deletes the Campanha aggregate. Used by the `registrarContaUsuario`
   * saga as a T3 compensation when adding the initial 'presentes' opcao
   * fails after the campanha row has been written. Idempotent.
   *
   * Cascade behaviour (per migration 001 + 003): the FK constraints on
   * `campanha_administradores`, `opcoes_contribuicao`, and `recebedores`
   * all `ON DELETE CASCADE`. The compensation path therefore handles a
   * campanha with its initial opcao + admin row in one statement.
   *
   * NOTE: `contribuicoes.id_opcao_contribuicao ON DELETE RESTRICT` —
   * deleting a campanha that has contribuicoes will fail. That's intended:
   * compensation only runs at signup-time when no contribuicoes can yet
   * exist. For production lifecycle deletes, a higher-level use-case must
   * handle the contribuicoes first.
   */
  delete(idCampanha: IdCampanha, context?: ArrecadacaoRepositoryContext): Promise<void>;
}
