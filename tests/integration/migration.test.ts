import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, Migrator, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigrationProvider } from '../helpers/migration-provider.js';

describe('Migration round-trip', () => {
  let container: StartedPostgreSqlContainer;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('frame')
      .withUsername('frame')
      .withPassword('frame')
      .start();

    db = new Kysely({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: container.getConnectionUri() }),
      }),
    });
  }, 60000);

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it('should migrate up and down cleanly', async () => {
    const migrator = new Migrator({
      db,
      provider: createMigrationProvider(),
    });

    const upResult = await migrator.migrateToLatest();
    expect(upResult.error).toBeUndefined();
    expect(upResult.results?.every((result) => result.status === 'Success')).toBe(true);

    const tableNames = await listTableNames(db);
    expect(tableNames).toContain('cats');
    expect(tableNames).toContain('campanhas');
    expect(tableNames).toContain('recebedores');
    expect(tableNames).toContain('usuarios');
    expect(tableNames).toContain('contas');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('accounts');
    expect(tableNames).toContain('verifications');
    expect(tableNames).toContain('rate_limit');
    expect(tableNames).toContain('pagamentos');
    expect(tableNames).toContain('payment_webhook_events');
    expect(tableNames).toContain('lancamentos_financeiros');
    expect(tableNames).toContain('repasses_recebedor');
    expect(tableNames).toContain('eventos');
    expect(tableNames).toContain('convites');
    expect(tableNames).toContain('listas_de_convidados');
    expect(tableNames).toContain('convidados');

    const usuarioIndexes = await listIndexNames(db, 'usuarios');
    expect(usuarioIndexes).toContain('usuarios_plataforma_criado_em_id_idx');
    expect(usuarioIndexes).toContain('usuarios_plataforma_nome_id_idx');

    const sessionIpCol = await getColumn(db, 'sessions', 'ip_address');
    expect(sessionIpCol?.character_maximum_length).toBe(128);

    const webhookConstraint = await getConstraintDef(
      db,
      'payment_webhook_events_provider_event_id_uniq',
    );
    expect(webhookConstraint).toContain('UNIQUE');

    const pagamentoPiCol = await getColumn(
      db,
      'pagamentos',
      'intencao_payment_intent_external_ref',
    );
    expect(pagamentoPiCol?.data_type).toBe('text');
    expect(pagamentoPiCol?.is_nullable).toBe('YES');

    const pagamentoChargeCol = await getColumn(db, 'pagamentos', 'intencao_charge_external_ref');
    expect(pagamentoChargeCol?.data_type).toBe('text');
    expect(pagamentoChargeCol?.is_nullable).toBe('YES');

    const pagamentoAvailableOnCol = await getColumn(
      db,
      'pagamentos',
      'intencao_balance_transaction_available_on',
    );
    expect(pagamentoAvailableOnCol?.data_type).toBe('timestamp with time zone');
    expect(pagamentoAvailableOnCol?.is_nullable).toBe('YES');

    const pagamentoIndexes = await listIndexNames(db, 'pagamentos');
    expect(pagamentoIndexes).toContain('pagamentos_intencao_pi_ref_idx');
    expect(pagamentoIndexes).toContain('pagamentos_intencao_ch_ref_idx');
    expect(pagamentoIndexes).toContain('pagamentos_aprovado_por_contribuicao_idx');

    const transferidoEmCol = await getColumn(db, 'lancamentos_financeiros', 'transferido_em');
    expect(transferidoEmCol?.data_type).toBe('timestamp with time zone');
    expect(transferidoEmCol?.is_nullable).toBe('YES');

    const canceladoEmCol = await getColumn(db, 'lancamentos_financeiros', 'cancelado_em');
    expect(canceladoEmCol?.data_type).toBe('timestamp with time zone');
    expect(canceladoEmCol?.is_nullable).toBe('YES');

    const idRepasseCol = await getColumn(db, 'lancamentos_financeiros', 'id_repasse');
    expect(idRepasseCol?.data_type).toBe('uuid');
    expect(idRepasseCol?.is_nullable).toBe('YES');

    const maturaEmCol = await getColumn(db, 'lancamentos_financeiros', 'matura_em');
    expect(maturaEmCol).toBeUndefined();

    const lancamentoIndexes = await listIndexNames(db, 'lancamentos_financeiros');
    expect(lancamentoIndexes).toContain('lancamentos_pendentes_idx');
    expect(lancamentoIndexes).toContain('lancamentos_transferidos_por_pagamento_idx');
    expect(lancamentoIndexes).toContain('lancamentos_financeiros_id_repasse_idx');
    expect(lancamentoIndexes).not.toContain('lancamentos_pendentes_maturos_idx');

    const repasseAprovadoEmCol = await getColumn(db, 'repasses_recebedor', 'aprovado_em');
    expect(repasseAprovadoEmCol?.data_type).toBe('timestamp with time zone');
    expect(repasseAprovadoEmCol?.is_nullable).toBe('YES');

    const repasseBankTransferRefCol = await getColumn(
      db,
      'repasses_recebedor',
      'bank_transfer_ref',
    );
    expect(repasseBankTransferRefCol?.data_type).toBe('text');
    expect(repasseBankTransferRefCol?.is_nullable).toBe('YES');

    const repasseConstraint = await getConstraintDef(db, 'repasses_recebedor_status_check');
    expect(repasseConstraint).toContain('solicitado');
    expect(repasseConstraint).toContain('aprovado');

    const repasseIndexes = await listIndexNames(db, 'repasses_recebedor');
    expect(repasseIndexes).toContain('repasses_um_solicitado_por_campanha');

    const downEvento = await migrator.migrateDown();
    expect(downEvento.error).toBeUndefined();

    const tablesAfterEventoDown = await listTableNames(db);
    expect(tablesAfterEventoDown).not.toContain('eventos');
    expect(tablesAfterEventoDown).not.toContain('convites');
    expect(tablesAfterEventoDown).not.toContain('listas_de_convidados');
    expect(tablesAfterEventoDown).not.toContain('convidados');

    const downRepasseFsm = await migrator.migrateDown();
    expect(downRepasseFsm.error).toBeUndefined();

    expect(await getColumn(db, 'lancamentos_financeiros', 'id_repasse')).toBeUndefined();
    expect(await getColumn(db, 'repasses_recebedor', 'aprovado_em')).toBeUndefined();
    expect(await getColumn(db, 'repasses_recebedor', 'bank_transfer_ref')).toBeUndefined();
    const repasseConstraintAfterDown = await getConstraintDef(
      db,
      'repasses_recebedor_status_check',
    );
    expect(repasseConstraintAfterDown).toContain('solicitado');
    expect(repasseConstraintAfterDown).not.toContain('aprovado');
    const repasseIndexesAfterDown = await listIndexNames(db, 'repasses_recebedor');
    expect(repasseIndexesAfterDown).not.toContain('repasses_um_solicitado_por_campanha');

    const downAvailableOn = await migrator.migrateDown();
    expect(downAvailableOn.error).toBeUndefined();

    expect(
      await getColumn(db, 'pagamentos', 'intencao_balance_transaction_available_on'),
    ).toBeUndefined();

    const downCollapseStateMachines = await migrator.migrateDown();
    expect(downCollapseStateMachines.error).toBeUndefined();

    const restoredMaturaEmCol = await getColumn(db, 'lancamentos_financeiros', 'matura_em');
    expect(restoredMaturaEmCol?.data_type).toBe('timestamp with time zone');
    expect(restoredMaturaEmCol?.is_nullable).toBe('NO');
    expect(await getColumn(db, 'lancamentos_financeiros', 'transferido_em')).toBeUndefined();
    expect(await getColumn(db, 'lancamentos_financeiros', 'cancelado_em')).toBeUndefined();
    expect(await getColumn(db, 'contribuicoes', 'status')).toBeDefined();
    expect(await getColumn(db, 'contribuicoes', 'contribuinte_nome')).toBeDefined();
    expect(await getColumn(db, 'contribuicoes', 'contribuinte_email')).toBeDefined();
    const lancamentoIndexesAfter019Down = await listIndexNames(db, 'lancamentos_financeiros');
    expect(lancamentoIndexesAfter019Down).toContain('lancamentos_pendentes_maturos_idx');
    expect(lancamentoIndexesAfter019Down).not.toContain('lancamentos_pendentes_idx');

    const downPiCh = await migrator.migrateDown();
    expect(downPiCh.error).toBeUndefined();

    expect(
      await getColumn(db, 'pagamentos', 'intencao_payment_intent_external_ref'),
    ).toBeUndefined();
    expect(await getColumn(db, 'pagamentos', 'intencao_charge_external_ref')).toBeUndefined();

    const downMaturaEm = await migrator.migrateDown();
    expect(downMaturaEm.error).toBeUndefined();

    expect(await getColumn(db, 'lancamentos_financeiros', 'matura_em')).toBeUndefined();

    const downWebhookEvents = await migrator.migrateDown();
    expect(downWebhookEvents.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('payment_webhook_events');

    const downPassthroughTipo = await migrator.migrateDown();
    expect(downPassthroughTipo.error).toBeUndefined();
    const tipoConstraintAfterDown = await getConstraintDef(
      db,
      'lancamentos_financeiros_tipo_check',
    );
    expect(tipoConstraintAfterDown).not.toContain('credito_passthrough_surcharge');
    expect(tipoConstraintAfterDown).toContain('credito_saldo_recebedor');

    const downIpAddressWiden = await migrator.migrateDown();
    expect(downIpAddressWiden.error).toBeUndefined();
    const ipColAfterDown = await getColumn(db, 'sessions', 'ip_address');
    expect(ipColAfterDown?.character_maximum_length).toBe(45);

    const downPaginatedIndexes = await migrator.migrateDown();
    expect(downPaginatedIndexes.error).toBeUndefined();
    const indexesAfterDown = await listIndexNames(db, 'usuarios');
    expect(indexesAfterDown).not.toContain('usuarios_plataforma_criado_em_id_idx');
    expect(indexesAfterDown).not.toContain('usuarios_plataforma_nome_id_idx');

    const downFinanceiro = await migrator.migrateDown();
    expect(downFinanceiro.error).toBeUndefined();

    const downPagamentos = await migrator.migrateDown();
    expect(downPagamentos.error).toBeUndefined();

    const downSlug = await migrator.migrateDown();
    expect(downSlug.error).toBeUndefined();

    const downBetterAuth = await migrator.migrateDown();
    expect(downBetterAuth.error).toBeUndefined();

    const downUsuario = await migrator.migrateDown();
    expect(downUsuario.error).toBeUndefined();

    const downGrupoContribuicoes = await migrator.migrateDown();
    expect(downGrupoContribuicoes.error).toBeUndefined();

    const downImagemUrlContribuicoes = await migrator.migrateDown();
    expect(downImagemUrlContribuicoes.error).toBeUndefined();

    const downCampanhasIdPlataforma = await migrator.migrateDown();
    expect(downCampanhasIdPlataforma.error).toBeUndefined();

    const downRecebedoresIdCarteira = await migrator.migrateDown();
    expect(downRecebedoresIdCarteira.error).toBeUndefined();

    const downRecebedores = await migrator.migrateDown();
    expect(downRecebedores.error).toBeUndefined();

    const downArrecadacaoAlter = await migrator.migrateDown();
    expect(downArrecadacaoAlter.error).toBeUndefined();

    const downArrecadacaoCreate = await migrator.migrateDown();
    expect(downArrecadacaoCreate.error).toBeUndefined();

    const tablesAfterArrecadacao = await listTableNames(db);
    expect(tablesAfterArrecadacao).not.toContain('campanhas');
    expect(tablesAfterArrecadacao).toContain('cats');

    const downCats = await migrator.migrateDown();
    expect(downCats.error).toBeUndefined();

    const tablesAfterCats = await listTableNames(db);
    expect(tablesAfterCats).not.toContain('cats');
  });
});

async function listTableNames(db: Kysely<unknown>): Promise<string[]> {
  const tables = await db
    .selectFrom('information_schema.tables' as never)
    .select('table_name' as never)
    .where('table_schema' as never, '=', 'public' as never)
    .execute();

  return tables.map((table: Record<string, unknown>) => String(table.table_name));
}

async function listIndexNames(db: Kysely<unknown>, tableName: string): Promise<string[]> {
  const indexes = await db
    .selectFrom('pg_indexes' as never)
    .select('indexname' as never)
    .where('schemaname' as never, '=', 'public' as never)
    .where('tablename' as never, '=', tableName as never)
    .execute();

  return indexes.map((index: Record<string, unknown>) => String(index.indexname));
}

async function getColumn(
  db: Kysely<unknown>,
  tableName: string,
  columnName: string,
): Promise<
  | {
      data_type: string | null;
      is_nullable: string | null;
      character_maximum_length: number | null;
    }
  | undefined
> {
  return (await db
    .selectFrom('information_schema.columns' as never)
    .select(['data_type' as never, 'is_nullable' as never, 'character_maximum_length' as never])
    .where('table_schema' as never, '=', 'public' as never)
    .where('table_name' as never, '=', tableName as never)
    .where('column_name' as never, '=', columnName as never)
    .executeTakeFirst()) as
    | {
        data_type: string | null;
        is_nullable: string | null;
        character_maximum_length: number | null;
      }
    | undefined;
}

async function getConstraintDef(
  db: Kysely<unknown>,
  constraintName: string,
): Promise<string | undefined> {
  const row = (await db
    .selectFrom('pg_constraint' as never)
    .select(() => [
      // biome-ignore lint/suspicious/noExplicitAny: pg_catalog tables are outside DB types
      sql<string>`pg_get_constraintdef(oid)`.as('def') as any,
    ])
    .where('conname' as never, '=', constraintName as never)
    .executeTakeFirst()) as { def: string } | undefined;

  return row?.def;
}
