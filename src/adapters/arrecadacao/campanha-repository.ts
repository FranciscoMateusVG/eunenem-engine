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
   * Resolve a Campanha onde `idConta` é administrador (aperture-d6atj). Hoje
   * a relação é 0..1 (um usuário admin de uma única campanha) — quando isso
   * mudar, este método precisa virar `findManyByAdministrador` e os callers
   * lidarem com seleção. Retorna `undefined` quando o usuário não administra
   * nenhuma campanha OU quando a campanha não tem recebedor ativo. Usado
   * pelo tRPC do eunenem-server (contribuicao-router) para resolver a
   * campanha-do-usuário a partir da sessão, exigindo recebedor ativo para
   * que contribuições possam ser criadas. Difere de `findFirstByAdministrador`
   * (p8i01) que retorna wrapper `campanhaSemRecebedor` nesse caso.
   */
  findByAdministrador(
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined>;

  /**
   * Returns ALL Campanhas where `idConta` is in `idsAdministradores`
   * (aperture-u2tko). The 1..N counterpart to `findFirstByAdministrador`
   * — used by the admin "Administra" tab on /admin/usuario/:idConta to
   * list every campanha the usuario owns, anticipating the future
   * model where a single user can administer multiple campanhas.
   *
   * Contract:
   *   - Returns ALL campanhas with `idConta` among administradores.
   *   - Ordered by `criadaEm` ASC, then `id` ASC for ties (matches
   *     `findFirstByAdministrador`).
   *   - Tenant-scoped implicitly via the join (`campanha_administradores`
   *     is per-campanha, which is per-plataforma). Callers MAY still
   *     want a belt-and-braces `idPlataforma` filter when surfacing
   *     across the tRPC tenant boundary.
   *   - Returns campanhas WITHOUT recebedor too — mirrors
   *     `findFirstByAdministrador` semantics, NOT `findByAdministrador`.
   *     The admin view needs to see ALL administered campanhas
   *     regardless of bank-info readiness.
   *   - Empty array (NOT undefined) when usuario administra nothing.
   *     The multi-result contract is "list" — empty list is a valid
   *     answer.
   *
   * Does NOT replace `findFirstByAdministrador` (still used by
   * `auth.me` + p8i01 backfill, which want exactly one row) or
   * `findByAdministrador` (still used by contribuicao-router, which
   * requires recebedor presence). This is the third sibling for the
   * admin-tier "show all administered" surface.
   */
  findCampanhasByAdministrador(
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Campanha[]>;

  /**
   * Returns the DISTINCT set of Campanhas this email-identified
   * contribuinte has given to (aperture-2ma52). Tenant-scoped. Includes
   * campanhas with any contribuicao status — paid, pending, failed all
   * count; the admin wants the full picture.
   *
   * NOTE — parameter shape: the bead originally proposed `(idPlataforma,
   * idConta)`, but the live `contribuicoes` schema has no
   * `id_conta_contribuinte` column. Visitor checkouts identify the
   * contribuinte by email only (`contribuinte_email`, `contribuinte_nome`).
   * Taking `emailContribuinte` directly keeps this port honest with the
   * schema; the caller (eunenem-v2 admin server action) resolves
   * `idConta → email` via `UsuarioRepository.findUsuarioById` first.
   *
   * MEMORY ADAPTER LIMITATION: the in-memory `CampanhaRepository` does
   * not own contribuicoes data (that's a separate aggregate). The
   * memory implementation returns `[]` — the JOIN is only meaningful
   * against the postgres adapter. Postgres-specific tests cover the
   * substantive behavior.
   */
  findCampanhasByContribuinte(
    idPlataforma: IdPlataformaReferencia,
    emailContribuinte: string,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Campanha[]>;

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
