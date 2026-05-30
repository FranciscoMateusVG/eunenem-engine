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

  async findFirstByAdministrador(
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan(
      'db.arrecadacao_campanhas.findFirstByAdministrador',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          // Join through campanha_administradores; pick the oldest matching
          // campanha (criada_em ASC, then id ASC for tie-breaks). Today
          // each user has exactly one campanha, but the deterministic
          // ordering future-proofs the contract.
          const row = await executor
            .selectFrom('campanhas')
            .innerJoin(
              'campanha_administradores',
              'campanha_administradores.campanha_id',
              'campanhas.id',
            )
            .select([
              'campanhas.id',
              'campanhas.id_plataforma',
              'campanhas.titulo',
              'campanhas.criada_em',
            ])
            .where('campanha_administradores.id_usuario', '=', idConta)
            .orderBy('campanhas.criada_em', 'asc')
            .orderBy('campanhas.id', 'asc')
            .limit(1)
            .executeTakeFirst();

          if (!row) {
            span.setStatus({ code: SpanStatusCode.OK });
            return undefined;
          }

          const idCampanha = row.id as IdCampanha;

          const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(
            idCampanha,
            context,
          );

          const admins = await executor
            .selectFrom('campanha_administradores')
            .selectAll()
            .where('campanha_id', '=', idCampanha)
            .execute();

          const opcoes = await executor
            .selectFrom('opcoes_contribuicao')
            .selectAll()
            .where('campanha_id', '=', idCampanha)
            .execute();

          const base = {
            id: idCampanha,
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
      },
    );
  }

  async findByAdministrador(
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findByAdministrador', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        // 0..1 by today's invariant (one campanha per user). If/when the
        // relationship loosens, this becomes findMany; the port comment
        // documents the migration shape.
        const adminRow = await executor
          .selectFrom('campanha_administradores')
          .select('campanha_id')
          .where('id_usuario', '=', idConta)
          .limit(1)
          .executeTakeFirst();

        if (!adminRow) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }

        // Reuse findById to avoid duplicating the recebedor + opcoes +
        // admins assembly. Cheap second SELECT — this method is invoked
        // once per authenticated request, not per row.
        const campanha = await this.findById(adminRow.campanha_id as IdCampanha, context);
        span.setStatus({ code: SpanStatusCode.OK });
        return campanha;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async delete(idCampanha: IdCampanha, context?: ArrecadacaoRepositoryContext): Promise<void> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_campanhas.delete', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        // FKs ON DELETE CASCADE on campanha_administradores.campanha_id,
        // opcoes_contribuicao.campanha_id, recebedores.campanha_id all
        // clean up in one statement. Idempotent — affects zero rows for
        // unknown id.
        await executor.deleteFrom('campanhas').where('id', '=', idCampanha).execute();
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

function toOpcao(row: OpcaoRow): OpcaoContribuicao {
  return {
    id: row.id,
    tipo: row.tipo as TipoOpcaoContribuicao,
  };
}
