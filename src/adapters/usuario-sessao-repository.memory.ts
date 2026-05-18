import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Sessao, TokenSessao } from '../domain/usuario.js';
import type { SessaoUsuarioRepository } from './usuario-sessao-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'usuario_sessoes',
} as const;

export class SessaoUsuarioRepositoryMemory implements SessaoUsuarioRepository {
  private readonly sessoes = new Map<TokenSessao, Sessao>();

  async save(sessao: Sessao): Promise<void> {
    return tracer.startActiveSpan('db.usuario_sessoes.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        this.sessoes.set(sessao.token, sessao);
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

  async findByToken(token: TokenSessao): Promise<Sessao | undefined> {
    return tracer.startActiveSpan('db.usuario_sessoes.findByToken', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.sessoes.get(token);
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
}
