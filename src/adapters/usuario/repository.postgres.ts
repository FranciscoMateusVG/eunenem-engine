import { SpanStatusCode, trace } from '@opentelemetry/api';
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
import type { UsuarioRepository } from './repository.js';

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
