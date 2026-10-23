import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { IdContaUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { Database } from '../database.js';
import type {
  PendenciaDesativacao,
  PendenciasDesativacaoRepository,
} from './pendencias-desativacao.js';

const tracer = trace.getTracer('frame');

/**
 * Repasse ainda não concluído pela plataforma. `falhou` entra porque aguarda
 * retentativa ou cancelamento do admin; `enviado_ao_banco`, `pago` e
 * `cancelado` são terminais.
 */
const STATUS_REPASSE_PENDENTE = ['solicitado', 'aprovado', 'transferindo', 'verificando', 'falhou'];

export class PendenciasDesativacaoPostgres implements PendenciasDesativacaoRepository {
  constructor(private readonly db: Database) {}

  async listarPendencias(idConta: IdContaUsuario): Promise<readonly PendenciaDesativacao[]> {
    return tracer.startActiveSpan('db.lancamentos_financeiros.listarPendencias', async (span) => {
      span.setAttributes({
        'db.system': 'postgresql',
        'db.operation.name': 'SELECT',
        'db.collection.name': 'lancamentos_financeiros',
      });
      try {
        // Saldo: crédito do recebedor não transferido, não estornado e não
        // reservado por um repasse (cancelar um repasse limpa id_repasse).
        const { rows } = await sql<{ saldo: boolean; resgate: boolean }>`
          WITH owned AS (
            SELECT campanha_id FROM campanha_membros_permissoes
            WHERE id_conta = ${idConta} AND papel = 'owner'
          )
          SELECT
            EXISTS (
              SELECT 1 FROM lancamentos_financeiros
              WHERE id_campanha IN (SELECT campanha_id FROM owned)
                AND tipo = 'credito_saldo_recebedor'
                AND transferido_em IS NULL AND cancelado_em IS NULL AND id_repasse IS NULL
            ) AS saldo,
            EXISTS (
              SELECT 1 FROM repasses_recebedor
              WHERE id_campanha IN (SELECT campanha_id FROM owned)
                AND status IN (${sql.join(STATUS_REPASSE_PENDENTE)})
            ) AS resgate
        `.execute(this.db);
        const row = rows[0];
        const pendencias: PendenciaDesativacao[] = [];
        if (row?.saldo) pendencias.push('saldo_a_sacar');
        if (row?.resgate) pendencias.push('resgate_em_andamento');
        span.setAttribute('pendencias.count', pendencias.length);
        span.setStatus({ code: SpanStatusCode.OK });
        return pendencias;
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
