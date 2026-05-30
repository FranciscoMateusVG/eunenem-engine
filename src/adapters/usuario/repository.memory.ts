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
import type { UsuarioRepository } from './repository.js';

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
}
