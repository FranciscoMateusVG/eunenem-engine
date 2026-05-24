import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Conta, CredencialSimulada, Usuario } from '../../domain/usuario/entities/usuario.js';
import type { EmailUsuario } from '../../domain/usuario/value-objects/email-usuario.js';
import type { IdContaUsuario, IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import { UsuarioEmailJaExisteError } from '../../errors/usuario/email-ja-existe.error.js';
import type { UsuarioRepository } from './repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'usuarios',
} as const;

export class UsuarioRepositoryMemory implements UsuarioRepository {
  private readonly usuarios = new Map<IdUsuario, Usuario>();
  private readonly contas = new Map<IdContaUsuario, Conta>();
  private readonly credenciais = new Map<IdUsuario, CredencialSimulada>();
  private readonly idUsuarioByEmail = new Map<EmailUsuario, IdUsuario>();

  async saveRegistro(bundle: {
    readonly usuario: Usuario;
    readonly conta: Conta;
    readonly credencial: CredencialSimulada;
  }): Promise<void> {
    return tracer.startActiveSpan('db.usuarios.saveRegistro', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const { usuario, conta, credencial } = bundle;

        if (conta.idUsuario !== usuario.id || conta.id !== usuario.idConta) {
          throw new Error('Invariante violada: conta deve referenciar usuario e usuario.idConta');
        }

        if (credencial.idUsuario !== usuario.id) {
          throw new Error('Invariante violada: credencial deve referenciar usuario');
        }

        if (this.idUsuarioByEmail.has(usuario.email)) {
          throw new UsuarioEmailJaExisteError(usuario.email);
        }

        this.usuarios.set(usuario.id, usuario);
        this.contas.set(conta.id, conta);
        this.credenciais.set(usuario.id, credencial);
        this.idUsuarioByEmail.set(usuario.email, usuario.id);

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

  async findUsuarioByEmail(email: EmailUsuario): Promise<Usuario | undefined> {
    return tracer.startActiveSpan('db.usuarios.findUsuarioByEmail', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const idUsuario = this.idUsuarioByEmail.get(email);
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

  async findCredencialByIdUsuario(idUsuario: IdUsuario): Promise<CredencialSimulada | undefined> {
    return tracer.startActiveSpan('db.usuarios.findCredencialByIdUsuario', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.credenciais.get(idUsuario);
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
