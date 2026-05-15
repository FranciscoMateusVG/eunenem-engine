import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { SessionToken, UserSession } from '../domain/user.js';
import type { UserSessionRepository } from './user-session-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'user_sessions',
} as const;

export class UserSessionRepositoryMemory implements UserSessionRepository {
  private readonly sessions = new Map<SessionToken, UserSession>();

  async save(session: UserSession): Promise<void> {
    return tracer.startActiveSpan('db.user_sessions.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        this.sessions.set(session.token, session);
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

  async findByToken(token: SessionToken): Promise<UserSession | undefined> {
    return tracer.startActiveSpan('db.user_sessions.findByToken', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.sessions.get(token);
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
