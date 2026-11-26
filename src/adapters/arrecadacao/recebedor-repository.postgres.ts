import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Recebedor } from '../../domain/arrecadacao/entities/recebedor.js';
import type {
  DadosRecebedor,
  TipoChavePix,
  TipoConta,
} from '../../domain/arrecadacao/value-objects/dados-recebedor.js';
import type { EnderecoFiscal } from '../../domain/arrecadacao/value-objects/endereco-fiscal.js';
import type { IdCampanha, IdRecebedor } from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoRecebedorAlteradoConcorrentementeError } from '../../errors/arrecadacao/recebedor-alterado-concorrentemente.error.js';
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
  // shared across both variants
  cpf_titular: string | null;
  // conta variant (NULL on pix rows)
  celular_titular: string | null;
  codigo_banco: string | null;
  agencia: string | null;
  agencia_digito: string | null;
  conta: string | null;
  conta_digito: string | null;
  tipo_conta: string | null;
  endereco_cep: string | null;
  endereco_logradouro: string | null;
  endereco_numero: string | null;
  endereco_complemento: string | null;
  endereco_bairro: string | null;
  endereco_cidade: string | null;
  endereco_uf: string | null;
  endereco_codigo_municipio_ibge: string | null;
  is_active: boolean;
  criada_em: Date;
};

/**
 * Flattens a `DadosRecebedor` union member into the recebedores column set.
 * `cpf_titular` is shared across both variants (migration 20260709 —
 * previously conta-only, extended to require it on pix too). The remaining
 * variant-specific columns follow the exactly-one-populated rule enforced by
 * the row-level CHECK (migration 027, updated to include cpf_titular for pix).
 */
function enderecoToColumns(e: EnderecoFiscal | undefined) {
  return {
    endereco_cep: e?.cep ?? null,
    endereco_logradouro: e?.logradouro ?? null,
    endereco_numero: e?.numero ?? null,
    endereco_complemento: e?.complemento ?? null,
    endereco_bairro: e?.bairro ?? null,
    endereco_cidade: e?.cidade ?? null,
    endereco_uf: e?.uf ?? null,
    endereco_codigo_municipio_ibge: e?.codigoMunicipioIbge ?? null,
  };
}

function enderecoFromRow(row: RecebedorRow): { enderecoFiscal?: EnderecoFiscal } {
  if (row.endereco_cep === null) return {};
  return {
    enderecoFiscal: {
      cep: row.endereco_cep,
      logradouro: row.endereco_logradouro as string,
      numero: row.endereco_numero as string,
      complemento: row.endereco_complemento,
      bairro: row.endereco_bairro as string,
      cidade: row.endereco_cidade as string,
      uf: row.endereco_uf as string,
      codigoMunicipioIbge: row.endereco_codigo_municipio_ibge as string,
    },
  };
}

function dadosRecebedorToColumns(dados: DadosRecebedor) {
  return { ...dadosRecebedorBaseColumns(dados), ...enderecoToColumns(dados.enderecoFiscal) };
}

function dadosRecebedorBaseColumns(dados: DadosRecebedor) {
  if (dados.metodo === 'pix') {
    return {
      metodo: 'pix' as const,
      nome_titular: dados.nomeTitular,
      tipo_chave_pix: dados.tipoChavePix,
      chave_pix: dados.chavePix,
      cpf_titular: dados.cpfTitular,
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
        // Índice parcial "um ativo por campanha": outra operação ativou um
        // recebedor primeiro (aperture-xdylg).
        const pg = error as { code?: string; constraint?: string };
        if (pg.code === '23505' && pg.constraint === 'recebedores_campanha_ativo_unique') {
          throw new ArrecadacaoRecebedorAlteradoConcorrentementeError(recebedor.idCampanha);
        }
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
          ...enderecoFromRow(row),
        }
      : {
          metodo: 'pix',
          nomeTitular: row.nome_titular,
          cpfTitular: row.cpf_titular as string,
          tipoChavePix: row.tipo_chave_pix as TipoChavePix,
          chavePix: row.chave_pix as string,
          ...enderecoFromRow(row),
        };

  return {
    id: row.id as IdRecebedor,
    idCampanha: row.campanha_id as IdCampanha,
    dadosRecebedor,
    isActive: row.is_active,
    criadaEm: row.criada_em,
  };
}
