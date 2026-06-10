import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Conta, Usuario } from '../../domain/usuario/entities/usuario.js';
import type { EmailUsuario } from '../../domain/usuario/value-objects/email-usuario.js';
import type {
  IdContaUsuario,
  IdPlataformaReferencia,
  IdUsuario,
} from '../../domain/usuario/value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import type { SlugUsuario } from '../../domain/usuario/value-objects/slug-usuario.js';
import { UsuarioEmailJaExisteError } from '../../errors/usuario/email-ja-existe.error.js';
import { UsuarioSlugJaExisteError } from '../../errors/usuario/slug-ja-existe.error.js';
import type {
  FindUsuariosPaginadosInput,
  FindUsuariosPaginadosOutput,
  UsuarioRepository,
} from './repository.js';
import {
  clampUsuariosPaginadosLimit,
  decodeUsuariosPaginadosCursor,
  encodeUsuariosPaginadosCursor,
  usuarioSortValue,
} from './repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'usuarios',
} as const;

/** Composite uniqueness key for email: `(idPlataforma, email)`. */
function emailKey(idPlataforma: IdPlataformaReferencia, email: EmailUsuario): string {
  return `${idPlataforma}::${email}`;
}

/** Composite uniqueness key for slug: `(idPlataforma, slug)` (aperture-khbow). */
function slugKey(idPlataforma: IdPlataformaReferencia, slug: SlugUsuario): string {
  return `${idPlataforma}::${slug}`;
}

export class UsuarioRepositoryMemory implements UsuarioRepository {
  private readonly usuarios = new Map<IdUsuario, Usuario>();
  private readonly contas = new Map<IdContaUsuario, Conta>();
  private readonly idUsuarioByEmail = new Map<string, IdUsuario>();
  private readonly idUsuarioBySlug = new Map<string, IdUsuario>();

  async saveRegistroDomain(bundle: {
    readonly usuario: Usuario;
    readonly conta: Conta;
  }): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.saveRegistroDomain', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const { usuario, conta } = bundle;

        if (conta.idUsuario !== usuario.id || conta.id !== usuario.idConta) {
          throw new Error('Invariante violada: conta deve referenciar usuario e usuario.idConta');
        }

        const emailIdx = emailKey(usuario.idPlataforma, usuario.email);
        if (this.idUsuarioByEmail.has(emailIdx)) {
          throw new UsuarioEmailJaExisteError(usuario.email);
        }

        const slugIdx = slugKey(usuario.idPlataforma, usuario.slug);
        if (this.idUsuarioBySlug.has(slugIdx)) {
          throw new UsuarioSlugJaExisteError(usuario.slug);
        }

        this.usuarios.set(usuario.id, usuario);
        this.contas.set(conta.id, conta);
        this.idUsuarioByEmail.set(emailIdx, usuario.id);
        this.idUsuarioBySlug.set(slugIdx, usuario.id);

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

  async findUsuarioById(id: IdUsuario): Promise<Usuario | undefined> {
    return tracer.startActiveSpan('db.usuarios.findUsuarioById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.usuarios.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const idUsuario = this.idUsuarioByEmail.get(emailKey(idPlataforma, email));
        const result = idUsuario ? this.usuarios.get(idUsuario) : undefined;
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        if (prefix === '' || limit <= 0) {
          span.setStatus({ code: SpanStatusCode.OK });
          return [];
        }
        const lowerPrefix = prefix.toLowerCase();
        const matches = [...this.usuarios.values()]
          .filter(
            (u) => u.idPlataforma === idPlataforma && u.email.toLowerCase().startsWith(lowerPrefix),
          )
          .sort((a, b) => a.email.localeCompare(b.email))
          .slice(0, limit);
        span.setStatus({ code: SpanStatusCode.OK });
        return matches;
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
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const limit = clampUsuariosPaginadosLimit(input.limit);
        const { sortBy, sortDir } = input;

        // 1. Tenant + filter (BEFORE pagination). LIKE-metachar escape is
        //    implicit here: we do a literal `startsWith` after lowercasing,
        //    so `%` and `_` in input are treated as literal chars (memory
        //    adapter has no pattern language to leak into).
        const filterPrefix = input.emailPrefix?.toLowerCase() ?? '';
        const allMatching = [...this.usuarios.values()].filter((u) => {
          if (u.idPlataforma !== idPlataforma) return false;
          if (filterPrefix === '') return true;
          return u.email.toLowerCase().startsWith(filterPrefix);
        });

        const totalCount = allMatching.length;

        // 2. Sort by (sortColumn, id) tuple in requested direction.
        const sorted = [...allMatching].sort((a, b) => {
          const av = usuarioSortValue(a, sortBy);
          const bv = usuarioSortValue(b, sortBy);
          let cmp = 0;
          if (av < bv) cmp = -1;
          else if (av > bv) cmp = 1;
          else if (a.id < b.id) cmp = -1;
          else if (a.id > b.id) cmp = 1;
          return sortDir === 'asc' ? cmp : -cmp;
        });

        // 3. Skip past cursor if present (filter rows strictly AFTER the
        //    cursor in the current sort direction).
        let postCursor = sorted;
        if (input.cursor !== null) {
          const cursor = decodeUsuariosPaginadosCursor(input.cursor);
          postCursor = sorted.filter((u) => {
            const sv = usuarioSortValue(u, sortBy);
            let cmp = 0;
            if (sv < cursor.sortValue) cmp = -1;
            else if (sv > cursor.sortValue) cmp = 1;
            else if (u.id < cursor.idUsuario) cmp = -1;
            else if (u.id > cursor.idUsuario) cmp = 1;
            // For ASC we want rows whose tuple > cursor; for DESC we want < cursor.
            return sortDir === 'asc' ? cmp > 0 : cmp < 0;
          });
        }

        // 4. Slice page + compute nextCursor from boundary row.
        const usuarios = postCursor.slice(0, limit);
        const hasMore = postCursor.length > limit;
        const last = usuarios[usuarios.length - 1];
        const nextCursor =
          hasMore && last
            ? encodeUsuariosPaginadosCursor({
                sortValue: usuarioSortValue(last, sortBy),
                idUsuario: last.id,
              })
            : null;

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
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const idUsuario = this.idUsuarioBySlug.get(slugKey(idPlataforma, slug));
        const result = idUsuario ? this.usuarios.get(idUsuario) : undefined;
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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
    return tracer.startActiveSpan('db.usuarios.findContaById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.contas.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        // aperture-lp9cw: in-memory equivalent of the postgres JOIN. The
        // tenant filter (idPlataforma match) is applied AFTER resolving
        // the Usuario — semantically identical to the WHERE clause on
        // usuarios.id_plataforma in the postgres query.
        const conta = this.contas.get(idConta);
        if (!conta) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        const usuario = this.usuarios.get(conta.idUsuario);
        if (!usuario || usuario.idPlataforma !== idPlataforma) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return usuario;
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
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const existing = this.usuarios.get(idUsuario);
        if (!existing) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        this.usuarios.set(idUsuario, {
          ...existing,
          nomeExibicao,
        });

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
   * Plan 0018 Phase A (aperture-omswg). First-write-wins; mirror of
   * the postgres adapter's `WHERE tutorial_completado_em IS NULL`
   * guard. Already-completed → no-op (the original timestamp is
   * preserved). Unknown id → no-op.
   */
  async marcarTutorialCompletado(idUsuario: IdUsuario, completadoEm: Date): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.marcarTutorialCompletado', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const existing = this.usuarios.get(idUsuario);
        if (!existing) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
        if (existing.tutorialCompletadoEm !== null) {
          // First-write-wins: do not overwrite a previously persisted
          // timestamp.
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
        this.usuarios.set(idUsuario, {
          ...existing,
          tutorialCompletadoEm: completadoEm,
        });
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
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        const usuario = this.usuarios.get(idUsuario);
        if (!usuario) {
          // Idempotent — no-op on unknown id.
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        // Cascade in the in-memory adapter: remove Conta + drop both
        // composite-uniqueness index entries so a fresh signup with the
        // same email/slug succeeds.
        this.contas.delete(usuario.idConta);
        this.idUsuarioByEmail.delete(emailKey(usuario.idPlataforma, usuario.email));
        this.idUsuarioBySlug.delete(slugKey(usuario.idPlataforma, usuario.slug));
        this.usuarios.delete(idUsuario);

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
