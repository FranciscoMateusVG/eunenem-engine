import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { Conta, Usuario } from '../../domain/usuario/entities/usuario.js';
import type { EmailUsuario } from '../../domain/usuario/value-objects/email-usuario.js';
import type {
  IdContaUsuario,
  IdPlataformaReferencia,
  IdUsuario,
} from '../../domain/usuario/value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import type { Permissao } from '../../domain/usuario/value-objects/permissao.js';
import type { SlugUsuario } from '../../domain/usuario/value-objects/slug-usuario.js';
import { UsuarioEmailJaExisteError } from '../../errors/usuario/email-ja-existe.error.js';
import { UsuarioSlugJaExisteError } from '../../errors/usuario/slug-ja-existe.error.js';
import type { Database } from '../database.js';
import type {
  FindUsuariosPaginadosInput,
  FindUsuariosPaginadosOutput,
  UsuarioPaginadoSortBy,
  UsuarioRepository,
} from './repository.js';
import {
  clampUsuariosPaginadosLimit,
  decodeUsuariosPaginadosCursor,
  encodeUsuariosPaginadosCursor,
  usuarioSortValue,
} from './repository.js';

const tracer = trace.getTracer('frame');

const DB_USUARIOS_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'usuarios',
} as const;

const DB_CONTAS_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'contas',
} as const;

/**
 * Constraint name from migration 20260530_008_create_usuario — matched
 * verbatim to surface `UsuarioEmailJaExisteError` instead of a raw
 * Postgres error on composite (id_plataforma, email) collision.
 */
const UNIQUE_PLATAFORMA_EMAIL = 'usuarios_plataforma_email_uniq';

/**
 * Constraint name from migration 20260530_010_add_slug_to_usuarios — matched
 * verbatim to surface `UsuarioSlugJaExisteError` (aperture-khbow). The
 * use-case `registrarContaUsuario` already walks suffixes pre-write so this
 * should only fire on a concurrent-registration race.
 */
const UNIQUE_PLATAFORMA_SLUG = 'usuarios_plataforma_slug_uniq';

type UsuarioRow = {
  id: string;
  id_plataforma: string;
  id_conta: string;
  email: string;
  nome_exibicao: string;
  slug: string;
  criado_em: Date;
  /** Plan 0018 Phase A (aperture-omswg / migration 024). */
  tutorial_completado_em: Date | null;
  onboarding_concluido_em: Date | null;
};

type ContaRow = {
  id: string;
  id_usuario: string;
  permissoes: string[];
  criada_em: Date;
};

interface PostgresError {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgErr = error as PostgresError;
  if (pgErr.code !== '23505') return false;
  // node-postgres surfaces the constraint name on `.constraint` when
  // available. Fall back to substring-matching the detail message if the
  // driver omits it.
  if (pgErr.constraint === constraint) return true;
  if (pgErr.detail?.includes(constraint)) return true;
  return false;
}

/**
 * PostgreSQL adapter for `UsuarioRepository` (aperture-xyhjr).
 *
 * Owns the engine-domain `usuarios` + `contas` tables only. The BetterAuth
 * `user/session/account/verification` tables — coming in aperture-g7f68 —
 * live separately and link by id (engine `usuarios.id` == BetterAuth
 * `user.id`).
 *
 * **Atomic registration**: `saveRegistroDomain` wraps both inserts in a
 * Kysely transaction so a usuarios success + contas failure cannot leave
 * a half-registered aggregate. The composite UNIQUE on
 * `(id_plataforma, email)` raises 23505 → mapped to
 * `UsuarioEmailJaExisteError` so callers see the same typed error the
 * memory adapter throws (port-conformance).
 */
export class UsuarioRepositoryPostgres implements UsuarioRepository {
  constructor(private readonly db: Database) {}

  async saveRegistroDomain(bundle: {
    readonly usuario: Usuario;
    readonly conta: Conta;
  }): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.saveRegistroDomain', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const { usuario, conta } = bundle;

        if (conta.idUsuario !== usuario.id || conta.id !== usuario.idConta) {
          throw new Error('Invariante violada: conta deve referenciar usuario e usuario.idConta');
        }

        await this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('usuarios')
            .values({
              id: usuario.id,
              id_plataforma: usuario.idPlataforma,
              id_conta: usuario.idConta,
              email: usuario.email,
              nome_exibicao: usuario.nomeExibicao,
              slug: usuario.slug,
              criado_em: usuario.criadoEm,
              // Plan 0018 Phase A (aperture-omswg / migration 024). Fresh
              // registrations start with tutorial_completado_em NULL so
              // the overlay fires on first visit.
              tutorial_completado_em: usuario.tutorialCompletadoEm,
              onboarding_concluido_em: usuario.onboardingConcluidoEm,
            })
            .execute();

          await trx
            .insertInto('contas')
            .values({
              id: conta.id,
              id_usuario: conta.idUsuario,
              permissoes: [...conta.permissoes],
              criada_em: conta.criadaEm,
            })
            .execute();
        });

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        if (isUniqueViolation(error, UNIQUE_PLATAFORMA_EMAIL)) {
          const typed = new UsuarioEmailJaExisteError(bundle.usuario.email);
          span.recordException(typed);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw typed;
        }
        if (isUniqueViolation(error, UNIQUE_PLATAFORMA_SLUG)) {
          const typed = new UsuarioSlugJaExisteError(bundle.usuario.slug);
          span.recordException(typed);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw typed;
        }
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findUsuarioById(id: IdUsuario): Promise<Usuario | undefined> {
    return tracer.startActiveSpan('db.usuarios.findUsuarioById', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('usuarios')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toUsuario(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findUsuarioByEmail(
    idPlataforma: IdPlataformaReferencia,
    email: EmailUsuario,
  ): Promise<Usuario | undefined> {
    return tracer.startActiveSpan('db.usuarios.findUsuarioByEmail', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('usuarios')
          .selectAll()
          .where('id_plataforma', '=', idPlataforma)
          .where('email', '=', email)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toUsuario(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findUsuariosByEmailPrefix(
    idPlataforma: IdPlataformaReferencia,
    prefix: string,
    limit: number,
  ): Promise<readonly Usuario[]> {
    return tracer.startActiveSpan('db.usuarios.findUsuariosByEmailPrefix', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        if (prefix === '' || limit <= 0) {
          span.setStatus({ code: SpanStatusCode.OK });
          return [];
        }
        // Escape LIKE metacharacters in caller-supplied input so user
        // typing `%` or `_` doesn't smuggle a wildcard into the pattern.
        // The trailing `%` is the actual prefix wildcard.
        const escaped = escapeLikePattern(prefix);
        const pattern = `${escaped}%`;
        const rows = await this.db
          .selectFrom('usuarios')
          .selectAll()
          .where('id_plataforma', '=', idPlataforma)
          .where('email', 'ilike', pattern)
          .orderBy('email', 'asc')
          .limit(limit)
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
        return rows.map(toUsuario);
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findUsuariosPaginated(
    idPlataforma: IdPlataformaReferencia,
    input: FindUsuariosPaginadosInput,
  ): Promise<FindUsuariosPaginadosOutput> {
    return tracer.startActiveSpan('db.usuarios.findUsuariosPaginated', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const limit = clampUsuariosPaginadosLimit(input.limit);
        const { sortBy, sortDir } = input;
        const dbCol = sortColumnFor(sortBy);

        const hasFilter = typeof input.emailPrefix === 'string' && input.emailPrefix.length > 0;
        const pattern = hasFilter ? `${escapeLikePattern(input.emailPrefix as string)}%` : null;

        // ─── 1. Page query (limit+1 to detect "has more"). ────────────────
        let pageQb = this.db
          .selectFrom('usuarios')
          .selectAll()
          .where('id_plataforma', '=', idPlataforma);

        if (pattern !== null) {
          pageQb = pageQb.where('email', 'ilike', pattern);
        }

        if (input.cursor !== null) {
          const cursor = decodeUsuariosPaginadosCursor(input.cursor);
          // Tuple-comparison cursor: rows whose (sortColumn, id) tuple is
          // strictly AFTER the cursor in the current sort direction.
          // Postgres supports tuple comparison natively. The text-cast on
          // the cursor sortValue lets one parameter shape serve all sort
          // columns; criadoEm needs an explicit timestamptz cast because
          // the comparison with `criado_em timestamptz` requires matched
          // types (text <=> timestamptz is not implicit).
          const castType = sortBy === 'criadoEm' ? sql`::timestamptz` : sql`::text`;
          const op = sortDir === 'asc' ? sql`>` : sql`<`;
          pageQb = pageQb.where(
            sql<boolean>`(${sql.ref(dbCol)}, ${sql.ref('id')}) ${op} (${cursor.sortValue}${castType}, ${cursor.idUsuario}::uuid)`,
          );
        }

        const pageRows = await pageQb
          .orderBy(dbCol, sortDir)
          .orderBy('id', sortDir)
          .limit(limit + 1)
          .execute();

        const hasMore = pageRows.length > limit;
        const sliced = hasMore ? pageRows.slice(0, limit) : pageRows;
        const usuarios = sliced.map(toUsuario);

        const last = usuarios[usuarios.length - 1];
        const nextCursor =
          hasMore && last
            ? encodeUsuariosPaginadosCursor({
                sortValue: usuarioSortValue(last, sortBy),
                idUsuario: last.id,
              })
            : null;

        // ─── 2. Total count query (filter-aware, tenant-scoped). ──────────
        // Uses the (id_plataforma, ...) prefix on the sort indexes (or the
        // existing usuarios_plataforma_email_uniq) for an index-only scan.
        let countQb = this.db
          .selectFrom('usuarios')
          .select(({ fn }) => fn.countAll<string>().as('count'))
          .where('id_plataforma', '=', idPlataforma);
        if (pattern !== null) {
          countQb = countQb.where('email', 'ilike', pattern);
        }
        const countRow = await countQb.executeTakeFirstOrThrow();
        const totalCount = Number(countRow.count);

        span.setStatus({ code: SpanStatusCode.OK });
        return { usuarios, nextCursor, totalCount };
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findUsuarioBySlug(
    idPlataforma: IdPlataformaReferencia,
    slug: SlugUsuario,
  ): Promise<Usuario | undefined> {
    return tracer.startActiveSpan('db.usuarios.findUsuarioBySlug', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('usuarios')
          .selectAll()
          .where('id_plataforma', '=', idPlataforma)
          .where('slug', '=', slug)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toUsuario(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findContaById(id: IdContaUsuario): Promise<Conta | undefined> {
    return tracer.startActiveSpan('db.contas.findContaById', async (span) => {
      span.setAttributes({ ...DB_CONTAS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('contas')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toConta(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findUsuarioByConta(
    idConta: IdContaUsuario,
    idPlataforma: IdPlataformaReferencia,
  ): Promise<Usuario | undefined> {
    return tracer.startActiveSpan('db.usuarios.findUsuarioByConta', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        // aperture-lp9cw: single-query JOIN — collapses the legacy
        // 2-hop fetch (findContaById → findUsuarioById → tenant filter)
        // to one round-trip. Index coverage:
        //   - contas (PK on id) for the equality filter on contas.id
        //   - usuarios_plataforma_email_uniq (composite on
        //     (id_plataforma, email)) does NOT help here since we filter
        //     on usuarios.id_plataforma without email. Postgres falls
        //     back to a sequential scan on the usuarios join, which is
        //     fine for current scale (single-tenant; small contas table).
        //     If that ever matters, add an index on usuarios.id_plataforma.
        // Project only usuarios columns — we don't need conta fields here
        // (the caller is tenant-guarded admin lookups).
        const row = await this.db
          .selectFrom('contas')
          .innerJoin('usuarios', 'usuarios.id', 'contas.id_usuario')
          .select([
            'usuarios.id as id',
            'usuarios.id_plataforma as id_plataforma',
            'usuarios.id_conta as id_conta',
            'usuarios.email as email',
            'usuarios.nome_exibicao as nome_exibicao',
            'usuarios.slug as slug',
            'usuarios.criado_em as criado_em',
            // Plan 0018 Phase A (aperture-omswg / migration 024).
            'usuarios.tutorial_completado_em as tutorial_completado_em',
            'usuarios.onboarding_concluido_em as onboarding_concluido_em',
          ])
          .where('contas.id', '=', idConta)
          .where('usuarios.id_plataforma', '=', idPlataforma)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toUsuario(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async atualizarNomeExibicaoUsuario(
    idUsuario: IdUsuario,
    nomeExibicao: NomeExibicaoUsuario,
  ): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.atualizarNomeExibicaoUsuario', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        // Mirrors the memory adapter: silent no-op if the user does not
        // exist (no throw). Consumers that care about existence call
        // findUsuarioById first.
        await this.db
          .updateTable('usuarios')
          .set({ nome_exibicao: nomeExibicao })
          .where('id', '=', idUsuario)
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Edita o slug (aperture-2ztes). Mesma forma estrutural de
   * `atualizarNomeExibicaoUsuario` (UPDATE keyed em `id`, no-op silencioso
   * para id desconhecido), mas adiciona o mapeamento 23505 →
   * `UsuarioSlugJaExisteError` que hoje só existe no INSERT de
   * `saveRegistroDomain`. A constraint composta `usuarios_plataforma_slug_uniq`
   * levanta o 23505 quando o `novoSlug` já existe na mesma plataforma; sem
   * auto-sufixo — o use-case propaga o erro tipado para o utilizador
   * escolher outro slug.
   */
  async atualizarSlugUsuario(idUsuario: IdUsuario, novoSlug: SlugUsuario): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.atualizarSlugUsuario', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        // Silent no-op if the user does not exist (mirrors
        // atualizarNomeExibicaoUsuario). The use-case guards existence.
        await this.db
          .updateTable('usuarios')
          .set({ slug: novoSlug })
          .where('id', '=', idUsuario)
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        // Composite (id_plataforma, slug) collision — surface the same
        // typed error the INSERT path and the memory adapter throw so
        // callers see one consistent error regardless of adapter.
        if (isUniqueViolation(error, UNIQUE_PLATAFORMA_SLUG)) {
          const typed = new UsuarioSlugJaExisteError(novoSlug);
          span.recordException(typed);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw typed;
        }
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Plan 0018 Phase A (aperture-omswg / migration 024). First-write-wins
   * via the `WHERE tutorial_completado_em IS NULL` guard — already-completed
   * usuarios are skipped (UPDATE affects 0 rows, no error). Mirrors
   * `atualizarNomeExibicaoUsuario` shape: silent no-op for unknown id.
   */
  async marcarTutorialCompletado(idUsuario: IdUsuario, completadoEm: Date): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.marcarTutorialCompletado', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        await this.db
          .updateTable('usuarios')
          .set({ tutorial_completado_em: completadoEm })
          .where('id', '=', idUsuario)
          .where('tutorial_completado_em', 'is', null)
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * aperture-lrl1h. First-write-wins via the `WHERE onboarding_concluido_em
   * IS NULL` guard — already-onboarded usuarios are skipped (UPDATE affects
   * 0 rows, no error). Mirrors `atualizarNomeExibicaoUsuario` shape: silent
   * no-op for unknown id.
   */
  async marcarOnboardingConcluido(idUsuario: IdUsuario, concluidoEm: Date): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.marcarOnboardingConcluido', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        await this.db
          .updateTable('usuarios')
          .set({ onboarding_concluido_em: concluidoEm })
          .where('id', '=', idUsuario)
          .where('onboarding_concluido_em', 'is', null)
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async removeRegistroDomain(idUsuario: IdUsuario): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.removeRegistroDomain', async (span) => {
      span.setAttributes({ ...DB_USUARIOS_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        // FK `contas.id_usuario` references `usuarios.id ON DELETE CASCADE`
        // (migration 008 line 50), so a single DELETE on usuarios cleans
        // up the matching Conta row. Idempotent — affects zero rows for
        // an unknown id, no error thrown.
        await this.db.deleteFrom('usuarios').where('id', '=', idUsuario).execute();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

/**
 * Escape LIKE/ILIKE metacharacters (`%`, `_`, `\`) so caller-supplied
 * text becomes a literal match. The default escape character in Postgres
 * LIKE is backslash; we double-escape backslash first so existing
 * backslashes don't unintentionally activate the escape sequence.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => `\\${c}`);
}

/**
 * Map the port-level sort key to the snake_case db column name. Single
 * source of truth — used by both the page query (orderBy + cursor tuple)
 * and the conformance assertions.
 */
function sortColumnFor(sortBy: UsuarioPaginadoSortBy): 'criado_em' | 'email' | 'nome_exibicao' {
  switch (sortBy) {
    case 'criadoEm':
      return 'criado_em';
    case 'email':
      return 'email';
    case 'nomeExibicao':
      return 'nome_exibicao';
  }
}

function toUsuario(row: UsuarioRow): Usuario {
  return {
    id: row.id,
    idPlataforma: row.id_plataforma,
    idConta: row.id_conta,
    email: row.email,
    nomeExibicao: row.nome_exibicao,
    slug: row.slug,
    criadoEm: row.criado_em,
    // Plan 0018 Phase A (aperture-omswg / migration 024). null until
    // the user completes (or skips) the tutorial overlay.
    tutorialCompletadoEm: row.tutorial_completado_em,
    onboardingConcluidoEm: row.onboarding_concluido_em,
  };
}

function toConta(row: ContaRow): Conta {
  return {
    id: row.id,
    idUsuario: row.id_usuario,
    permissoes: row.permissoes as readonly Permissao[],
    criadaEm: row.criada_em,
  };
}
