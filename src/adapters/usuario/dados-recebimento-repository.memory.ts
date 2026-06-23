import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { DadosRecebimentoUsuario } from '../../domain/usuario/entities/dados-recebimento-usuario.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { DadosRecebimentoRepository } from './dados-recebimento-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'dados_recebimento_usuario',
} as const;

export class DadosRecebimentoRepositoryMemory implements DadosRecebimentoRepository {
  private readonly registros = new Map<IdUsuario, DadosRecebimentoUsuario>();

  async save(registro: DadosRecebimentoUsuario): Promise<void> {
    return tracer.startActiveSpan('db.dados_recebimento_usuario.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        // 1:1 upsert keyed by idUsuario — stores the VO wholesale, so both
        // pix and conta variants round-trip unchanged.
        this.registros.set(registro.idUsuario, registro);
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

  async findByUsuarioId(idUsuario: IdUsuario): Promise<DadosRecebimentoUsuario | undefined> {
    return tracer.startActiveSpan('db.dados_recebimento_usuario.findByUsuarioId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.registros.get(idUsuario);
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
