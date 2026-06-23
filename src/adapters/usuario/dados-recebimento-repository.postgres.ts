import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  DadosRecebedor,
  TipoChavePix,
  TipoConta,
} from '../../domain/arrecadacao/value-objects/dados-recebedor.js';
import type { DadosRecebimentoUsuario } from '../../domain/usuario/entities/dados-recebimento-usuario.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { Database } from '../database.js';
import type { DadosRecebimentoRepository } from './dados-recebimento-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'dados_recebimento_usuario',
} as const;

type DadosRecebimentoRow = {
  id: string;
  id_usuario: string;
  metodo: string;
  nome_titular: string;
  tipo_chave_pix: string | null;
  chave_pix: string | null;
  cpf_titular: string | null;
  celular_titular: string | null;
  codigo_banco: string | null;
  agencia: string | null;
  agencia_digito: string | null;
  conta: string | null;
  conta_digito: string | null;
  tipo_conta: string | null;
  atualizado_em: Date;
};

/**
 * Flattens a `DadosRecebedor` union member into the column set. Exactly one
 * variant's columns are populated; the other variant's columns are NULL —
 * enforced by the row-level CHECK (migration 028).
 */
function dadosToColumns(dados: DadosRecebedor) {
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

export class DadosRecebimentoRepositoryPostgres implements DadosRecebimentoRepository {
  constructor(private readonly db: Database) {}

  async save(registro: DadosRecebimentoUsuario): Promise<void> {
    return tracer.startActiveSpan('db.dados_recebimento_usuario.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        const cols = dadosToColumns(registro.dados);
        await this.db
          .insertInto('dados_recebimento_usuario')
          .values({
            id: randomUUID(),
            id_usuario: registro.idUsuario,
            ...cols,
            atualizado_em: registro.atualizadoEm,
          })
          // 1:1 upsert keyed by id_usuario. The existing row's `id` is
          // preserved (immutable identity); every variant column plus
          // `atualizado_em` is overwritten.
          .onConflict((oc) =>
            oc.column('id_usuario').doUpdateSet({
              ...cols,
              atualizado_em: registro.atualizadoEm,
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

  async findByUsuarioId(idUsuario: IdUsuario): Promise<DadosRecebimentoUsuario | undefined> {
    return tracer.startActiveSpan('db.dados_recebimento_usuario.findByUsuarioId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('dados_recebimento_usuario')
          .selectAll()
          .where('id_usuario', '=', idUsuario)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toDadosRecebimento(row) : undefined;
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

function toDadosRecebimento(row: DadosRecebimentoRow): DadosRecebimentoUsuario {
  const dados: DadosRecebedor =
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
    idUsuario: row.id_usuario as IdUsuario,
    dados,
    atualizadoEm: row.atualizado_em,
  };
}
