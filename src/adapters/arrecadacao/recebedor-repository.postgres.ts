import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Recebedor } from '../../domain/arrecadacao/entities/recebedor.js';
import type {
  DadosRecebedor,
  TipoChavePix,
  TipoConta,
} from '../../domain/arrecadacao/value-objects/dados-recebedor.js';
import type { IdCampanha, IdRecebedor } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Database } from '../database.js';
import type { RecebedorRepository } from './recebedor-repository.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'arrecadacao_recebedores',
} as const;

type RecebedorRow = {
  id: string;
  campanha_id: string;
  nome_titular: string;
  metodo: string;
  // pix variant (NULL on conta rows)
  tipo_chave_pix: string | null;
  chave_pix: string | null;
  // conta variant (NULL on pix rows)
  cpf_titular: string | null;
  celular_titular: string | null;
  codigo_banco: string | null;
  agencia: string | null;
  agencia_digito: string | null;
  conta: string | null;
  conta_digito: string | null;
  tipo_conta: string | null;
  is_active: boolean;
  criada_em: Date;
};

/**
 * Flattens a `DadosRecebedor` union member into the recebedores column set.
 * Exactly one variant's columns are populated; the other variant's columns
 * are NULL — enforced by the row-level CHECK (migration 027).
 */
function dadosRecebedorToColumns(dados: DadosRecebedor) {
  if (dados.metodo === 'pix') {
    return {
      metodo: 'pix' as const,
      nome_titular: dados.nomeTitular,
      tipo_chave_pix: dados.tipoChavePix,
      chave_pix: dados.chavePix,
      cpf_titular: null,
      celular_titular: null,
      codigo_banco: null,
      agencia: null,
      agencia_digito: null,
      conta: null,
      conta_digito: null,
      tipo_conta: null,
    };
  }
  return {
    metodo: 'conta' as const,
    nome_titular: dados.nomeTitular,
    tipo_chave_pix: null,
    chave_pix: null,
    cpf_titular: dados.cpfTitular,
    celular_titular: dados.celularTitular,
    codigo_banco: dados.codigoBanco,
    agencia: dados.agencia,
    agencia_digito: dados.agenciaDigito,
    conta: dados.conta,
    conta_digito: dados.contaDigito,
    tipo_conta: dados.tipoConta,
  };
}

export class RecebedorRepositoryPostgres implements RecebedorRepository {
  constructor(private readonly db: Database) {}

  async save(recebedor: Recebedor, context?: ArrecadacaoRepositoryContext): Promise<void> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_recebedores.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        const cols = dadosRecebedorToColumns(recebedor.dadosRecebedor);
        await executor
          .insertInto('recebedores')
          .values({
            id: recebedor.id,
            campanha_id: recebedor.idCampanha,
            ...cols,
            is_active: recebedor.isActive,
            criada_em: recebedor.criadaEm,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              is_active: recebedor.isActive,
              ...cols,
            }),
          )
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

  async findAtivoByCampanhaId(
    idCampanha: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<Recebedor | undefined> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan(
      'db.arrecadacao_recebedores.findAtivoByCampanhaId',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const row = await executor
            .selectFrom('recebedores')
            .selectAll()
            .where('campanha_id', '=', idCampanha)
            .where('is_active', '=', true)
            .executeTakeFirst();
          span.setStatus({ code: SpanStatusCode.OK });
          return row ? toRecebedor(row) : undefined;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async findByCampanhaId(
    idCampanha: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Recebedor[]> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_recebedores.findByCampanhaId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const rows = await executor
          .selectFrom('recebedores')
          .selectAll()
          .where('campanha_id', '=', idCampanha)
          .orderBy('criada_em', 'asc')
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
        return rows.map(toRecebedor);
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

function toRecebedor(row: RecebedorRow): Recebedor {
  const dadosRecebedor: DadosRecebedor =
    row.metodo === 'conta'
      ? {
          metodo: 'conta',
          nomeTitular: row.nome_titular,
          cpfTitular: row.cpf_titular as string,
          celularTitular: row.celular_titular as string,
          codigoBanco: row.codigo_banco as string,
          agencia: row.agencia as string,
          agenciaDigito: row.agencia_digito,
          conta: row.conta as string,
          contaDigito: row.conta_digito as string,
          tipoConta: row.tipo_conta as TipoConta,
        }
      : {
          metodo: 'pix',
          nomeTitular: row.nome_titular,
          tipoChavePix: row.tipo_chave_pix as TipoChavePix,
          chavePix: row.chave_pix as string,
        };

  return {
    id: row.id as IdRecebedor,
    idCampanha: row.campanha_id as IdCampanha,
    dadosRecebedor,
    isActive: row.is_active,
    criadaEm: row.criada_em,
  };
}
