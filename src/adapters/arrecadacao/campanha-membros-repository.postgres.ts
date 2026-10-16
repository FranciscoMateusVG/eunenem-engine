import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha, IdConta } from '../../domain/arrecadacao/value-objects/ids.js';
import {
  type AcaoConcedivel,
  AcaoConcedivelSchema,
  type AcessoMembroCampanha,
  PapelMembroCampanhaSchema,
  PERMISSOES_PADRAO_MEMBRO,
} from '../../domain/arrecadacao/value-objects/permissao-campanha.js';
import type { Database } from '../database.js';
import type { CampanhaMembrosRepository, MembroCampanha } from './campanha-membros-repository.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'campanha_membros_permissoes',
} as const;

function toAcesso(row: { papel: string; permissoes: string[] }): AcessoMembroCampanha {
  return {
    papel: PapelMembroCampanhaSchema.parse(row.papel),
    permissoes: row.permissoes.map((p) => AcaoConcedivelSchema.parse(p)),
  };
}

async function comSpan<T>(nome: string, operacao: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`db.campanha_membros_permissoes.${nome}`, async (span) => {
    span.setAttributes({ ...DB_ATTRS, 'db.operation.name': operacao });
    try {
      const result = await fn();
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

export class CampanhaMembrosRepositoryPostgres implements CampanhaMembrosRepository {
  constructor(private readonly db: Database) {}

  async obterAcesso(
    idCampanha: IdCampanha,
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<AcessoMembroCampanha | undefined> {
    const executor = context?.trx ?? this.db;
    return comSpan('obterAcesso', 'SELECT', async () => {
      const row = await executor
        .selectFrom('campanha_membros_permissoes as p')
        .innerJoin('campanha_administradores as ca', (join) =>
          join
            .onRef('ca.campanha_id', '=', 'p.campanha_id')
            .onRef('ca.id_usuario', '=', 'p.id_conta'),
        )
        .select(['p.papel', 'p.permissoes'])
        .where('p.campanha_id', '=', idCampanha)
        .where('p.id_conta', '=', idConta)
        .executeTakeFirst();
      return row ? toAcesso(row) : undefined;
    });
  }

  async listarMembros(
    idCampanha: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly MembroCampanha[]> {
    const executor = context?.trx ?? this.db;
    return comSpan('listarMembros', 'SELECT', async () => {
      const rows = await executor
        .selectFrom('campanha_membros_permissoes as p')
        .innerJoin('campanha_administradores as ca', (join) =>
          join
            .onRef('ca.campanha_id', '=', 'p.campanha_id')
            .onRef('ca.id_usuario', '=', 'p.id_conta'),
        )
        .select(['p.id_conta', 'p.papel', 'p.permissoes'])
        .where('p.campanha_id', '=', idCampanha)
        .execute();
      return rows
        .map((row) => ({ idConta: row.id_conta as IdConta, ...toAcesso(row) }))
        .sort(ordenarMembros);
    });
  }

  async adicionarMembro(
    idCampanha: IdCampanha,
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<void> {
    const executor = context?.trx ?? this.db;
    return comSpan('adicionarMembro', 'INSERT', async () => {
      await executor
        .insertInto('campanha_membros_permissoes')
        .values({
          campanha_id: idCampanha,
          id_conta: idConta,
          papel: 'membro',
          permissoes: [...PERMISSOES_PADRAO_MEMBRO],
        })
        .onConflict((oc) => oc.columns(['campanha_id', 'id_conta']).doNothing())
        .execute();
    });
  }

  async removerMembro(
    idCampanha: IdCampanha,
    idConta: IdConta,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<void> {
    const executor = context?.trx ?? this.db;
    return comSpan('removerMembro', 'DELETE', async () => {
      await executor
        .deleteFrom('campanha_membros_permissoes')
        .where('campanha_id', '=', idCampanha)
        .where('id_conta', '=', idConta)
        .execute();
    });
  }

  async definirPermissoes(
    idCampanha: IdCampanha,
    idConta: IdConta,
    permissoes: readonly AcaoConcedivel[],
    context?: ArrecadacaoRepositoryContext,
  ): Promise<boolean> {
    const executor = context?.trx ?? this.db;
    return comSpan('definirPermissoes', 'UPDATE', async () => {
      const result = await executor
        .updateTable('campanha_membros_permissoes')
        .set({ permissoes: [...new Set(permissoes)], atualizado_em: new Date() })
        .where('campanha_id', '=', idCampanha)
        .where('id_conta', '=', idConta)
        .where('papel', '=', 'membro')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    });
  }
}

/** Owners primeiro, depois por idConta — ordem estável para a UI. */
export function ordenarMembros(a: MembroCampanha, b: MembroCampanha): number {
  if (a.papel !== b.papel) return a.papel === 'owner' ? -1 : 1;
  return a.idConta.localeCompare(b.idConta);
}
