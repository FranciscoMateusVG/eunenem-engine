import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Campanha } from '../../domain/arrecadacao/entities/campanha.js';
import {
  campanhaComRecebedorInicial,
  criarCampanhaSemRecebedor,
} from '../../domain/arrecadacao/entities/campanha.js';
import type {
  IdCampanha,
  IdConta,
  IdPlataformaReferencia,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type {
  OpcaoContribuicao,
  TipoOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/opcao-contribuicao.js';
import type { Database } from '../database.js';
import type { CampanhaRepository } from './campanha-repository.js';
import type { RecebedorRepository } from './recebedor-repository.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'arrecadacao_campanhas',
} as const;

type OpcaoRow = { id: string; campanha_id: string; tipo: string };

/**
 * PostgreSQL CampanhaRepository: upsert da campanha (incluindo `id_plataforma`),
 * sync de administradores (delete-all + insert) e upsert de opções por id.
 * Recebedor ativo resolvido via RecebedorRepository.
 */
export class CampanhaRepositoryPostgres implements CampanhaRepository {
  constructor(
    private readonly db: Database,
    private readonly recebedorRepository: RecebedorRepository,
  ) {}

  async save(campanha: Campanha, context?: ArrecadacaoRepositoryContext): Promise<void> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_campanhas.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        await executor
          .insertInto('campanhas')
          .values({
            id: campanha.id,
            id_plataforma: campanha.idPlataforma,
            titulo: campanha.titulo,
            criada_em: campanha.criadaEm,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              titulo: campanha.titulo,
              id_plataforma: campanha.idPlataforma,
            }),
          )
          .execute();

        await executor
          .deleteFrom('campanha_administradores')
          .where('campanha_id', '=', campanha.id)
          .execute();

        if (campanha.idsAdministradores.length > 0) {
          await executor
            .insertInto('campanha_administradores')
            .values(
              campanha.idsAdministradores.map((idUsuario) => ({
                campanha_id: campanha.id,
                id_usuario: idUsuario,
              })),
            )
            .execute();
        }

        for (const opcao of campanha.opcoes) {
          await executor
            .insertInto('opcoes_contribuicao')
            .values({
              id: opcao.id,
              campanha_id: campanha.id,
              tipo: opcao.tipo,
            })
            .onConflict((oc) =>
              oc.column('id').doUpdateSet({
                tipo: opcao.tipo,
                campanha_id: campanha.id,
              }),
            )
            .execute();
        }

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

  async findById(
    id: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await executor
          .selectFrom('campanhas')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();

        if (!row) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }

        const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(id, context);

        const admins = await executor
          .selectFrom('campanha_administradores')
          .selectAll()
          .where('campanha_id', '=', id)
          .execute();

        const opcoes = await executor
          .selectFrom('opcoes_contribuicao')
          .selectAll()
          .where('campanha_id', '=', id)
          .execute();

        const base = {
          id: row.id as IdCampanha,
          idPlataforma: row.id_plataforma as IdPlataformaReferencia,
          idsAdministradores: admins.map((a) => a.id_usuario as IdConta),
          titulo: row.titulo,
          opcoes: opcoes.map(toOpcao),
          criadaEm: row.criada_em,
        };

        span.setStatus({ code: SpanStatusCode.OK });
        return recebedorAtivo
          ? campanhaComRecebedorInicial({ ...base, recebedor: recebedorAtivo })
          : criarCampanhaSemRecebedor(base);
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByPlataforma(
    idPlataforma: IdPlataformaReferencia,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Campanha[]> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findByPlataforma', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const rows = await executor
          .selectFrom('campanhas')
          .selectAll()
          .where('id_plataforma', '=', idPlataforma)
          .execute();

        if (rows.length === 0) {
          span.setStatus({ code: SpanStatusCode.OK });
          return [];
        }

        const resultados: Campanha[] = [];
        for (const row of rows) {
          const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(
            row.id as IdCampanha,
            context,
          );

          const admins = await executor
            .selectFrom('campanha_administradores')
            .selectAll()
            .where('campanha_id', '=', row.id)
            .execute();

          const opcoes = await executor
            .selectFrom('opcoes_contribuicao')
            .selectAll()
            .where('campanha_id', '=', row.id)
            .execute();

          const base = {
            id: row.id as IdCampanha,
            idPlataforma: row.id_plataforma as IdPlataformaReferencia,
            idsAdministradores: admins.map((a) => a.id_usuario as IdConta),
            titulo: row.titulo,
            opcoes: opcoes.map(toOpcao),
            criadaEm: row.criada_em,
          };

          resultados.push(
            recebedorAtivo
              ? campanhaComRecebedorInicial({ ...base, recebedor: recebedorAtivo })
              : criarCampanhaSemRecebedor(base),
          );
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return resultados;
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

function toOpcao(row: OpcaoRow): OpcaoContribuicao {
  return {
    id: row.id,
    tipo: row.tipo as TipoOpcaoContribuicao,
  };
}
