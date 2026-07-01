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

    // Migrations layered ON TOP of the evento migration (026 create_evento):
    //   - 20260615_023_expand_convites_fonte_check (CHECK only, no table)
    //   - 20260623_026_create_perfil_criador → perfil_criadores
    //   - 20260623_027_recebedores_dados_conta (recebedores ALTER, no table)
    //   - 20260623_028_create_dados_recebimento_usuario → dados_recebimento_usuario
    //
    // NOTE (duplicate migration-number smell): the migration set contains
    // TWO files numbered "026" (20260611_026_create_evento and
    // 20260623_026_create_perfil_criador) and TWO numbered "023"
    // (20260608_023_lancamentos_financeiros_per_item and
    // 20260615_023_expand_convites_fonte_check). The kysely migration
    // provider keys on the FULL filename (basename without extension) and
    // sorts lexically, so the dates disambiguate them and ordering is
    // well-defined — but the colliding numeric prefixes are a real naming
    // smell. Renaming production migration files is out of scope/risky;
    // this test is made correct against the current files instead.
    expect(tableNames).toContain('perfil_criadores');
    expect(tableNames).toContain('dados_recebimento_usuario');
    expect(tableNames).toContain('resgates_pendentes');

    const conviteRemetenteCol = await getColumn(db, 'convites', 'remetente');
    expect(conviteRemetenteCol?.data_type).toBe('character varying');
    expect(conviteRemetenteCol?.character_maximum_length).toBe(120);
    expect(conviteRemetenteCol?.is_nullable).toBe('NO');

    // ── Roll back the post-evento migrations first (latest → earliest),
    //    so the subsequent evento down-step actually targets the evento
    //    migration. Each migrateDown() unwinds exactly the current tip, so
    //    this sequence must start at the LATEST migration and walk earlier.
    //    Adding a new migration on top REQUIRES prepending its down-step here.

    // 031 add_genero_to_perfil_criador (aperture-neiwx) → the migration TIP
    //   (landed after 030). migrateToLatest applied through it, so the FIRST
    //   migrateDown unwinds 031 — its down() drops the perfil_criadores.genero
    //   column + its CHECK (the table itself survives until the 026 down below).
    //   Without this step the whole sequence is off-by-one.
    const downAddGenero = await migrator.migrateDown();
    expect(downAddGenero.error).toBeUndefined();
    expect(await listTableNames(db)).toContain('perfil_criadores'); // table still here

    // 030 create_resgates_pendentes (aperture-kj9el #4b) → landed before 031.
    //   Its down() drops the resgates_pendentes table. Without this step the
    //   next assertions target 029/028 while 030 is still applied → off-by-one
    //   false failures.
    const downResgatesPendentes = await migrator.migrateDown();
    expect(downResgatesPendentes.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('resgates_pendentes');

    // 029 expand_convites_modelo_check (aperture-ypmyb) → its down() reverts
    //   the convites_modelo CHECK from the expanded 38-value list to the prior
    //   13-value list (no table delta; convites still exists, dropped only by
    //   the evento down below). Without this step the next assertion targets
    //   028's table while 028 is still applied → false failure.
    const downExpandConvitesModelo = await migrator.migrateDown();
    expect(downExpandConvitesModelo.error).toBeUndefined();
    const modeloConstraintAfterDown = (await db
      .selectFrom('pg_constraint' as never)
      .select((_eb) => [
        // biome-ignore lint/suspicious/noExplicitAny: pg_constraint not in DB types
        sql<string>`pg_get_constraintdef(oid)`.as('def') as any,
      ])
      .where('conname' as never, '=', 'convites_modelo_check' as never)
      .executeTakeFirst()) as { def: string } | undefined;
    // After down(): a 38-list-only literal is gone; a 13-list literal remains.
    expect(modeloConstraintAfterDown?.def).not.toContain('xadrez-azul-suave');
    expect(modeloConstraintAfterDown?.def).toContain('elefantinho');

    // 028 create_dados_recebimento_usuario → drops dados_recebimento_usuario
    const downDadosRecebimento = await migrator.migrateDown();
    expect(downDadosRecebimento.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('dados_recebimento_usuario');

    // 027 recebedores_dados_conta → recebedores ALTER (no table delta)
    const downRecebedoresDadosConta = await migrator.migrateDown();
    expect(downRecebedoresDadosConta.error).toBeUndefined();

    // 20260623_026 create_perfil_criador → drops perfil_criadores
    const downPerfilCriador = await migrator.migrateDown();
    expect(downPerfilCriador.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('perfil_criadores');

    // 20260615_023 expand_convites_fonte_check → CHECK swap (no table delta);
    // convites still exists here (dropped only by the evento down below).
    const downExpandConvitesFonte = await migrator.migrateDown();
    expect(downExpandConvitesFonte.error).toBeUndefined();

    // 20260611_026 create_evento → drops the four evento-domain tables.
    const downEvento = await migrator.migrateDown();
    expect(downEvento.error).toBeUndefined();

    const tablesAfterEventoDown = await listTableNames(db);
    expect(tablesAfterEventoDown).not.toContain('eventos');
    expect(tablesAfterEventoDown).not.toContain('convites');
    expect(tablesAfterEventoDown).not.toContain('listas_de_convidados');
    expect(tablesAfterEventoDown).not.toContain('convidados');

    // ── Roll back migrations 025 → 019, which sit BETWEEN the evento
    //    migration (026) and the pi/ch migration (018). These are all
    //    column add/alter migrations (no table create/drop), so we assert
    //    on the column delta. Without unwinding these first, the
    //    subsequent `downPiCh` step would actually be rolling back 025,
    //    not 018, and every assertion below would be off-by-seven.

    // 025 add_mensagem_lida_em_to_pagamentos → drops pagamentos.mensagem_lida_em
    const downMensagemLida = await migrator.migrateDown();
    expect(downMensagemLida.error).toBeUndefined();
    expect(await getColumn(db, 'pagamentos', 'mensagem_lida_em')).toBeUndefined();

    // 024 add_tutorial_completado_em_to_usuarios → drops usuarios.tutorial_completado_em
    const downTutorialCompletado = await migrator.migrateDown();
    expect(downTutorialCompletado.error).toBeUndefined();
    expect(await getColumn(db, 'usuarios', 'tutorial_completado_em')).toBeUndefined();

    // 20260609_023 lancamentos_financeiros_per_item → drops
    // lancamentos_financeiros.id_item_pagamento
    const downLancamentosPerItem = await migrator.migrateDown();
    expect(downLancamentosPerItem.error).toBeUndefined();
    expect(await getColumn(db, 'lancamentos_financeiros', 'id_item_pagamento')).toBeUndefined();

    // 022 multi_item_pagamento_and_quantidade → drops intencao_items table,
    // restores the single-item pagamentos shape, drops contribuicoes.quantidade
    const downMultiItem = await migrator.migrateDown();
    expect(downMultiItem.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('intencao_items');
    expect(await getColumn(db, 'contribuicoes', 'quantidade')).toBeUndefined();
    // down() of 022 restores the retired per-pagamento contribuição column.
    expect(await getColumn(db, 'pagamentos', 'intencao_id_contribuicao')).toBeDefined();

    // 021 extend_repasse_recebedor_fsm → drops repasses_recebedor.bank_transfer_ref
    const downRepasseFsm = await migrator.migrateDown();
    expect(downRepasseFsm.error).toBeUndefined();
    expect(await getColumn(db, 'repasses_recebedor', 'bank_transfer_ref')).toBeUndefined();

    // 020 add_balance_transaction_available_on_to_pagamentos → drops that column
    const downBalanceTxn = await migrator.migrateDown();
    expect(downBalanceTxn.error).toBeUndefined();
    expect(
      await getColumn(db, 'pagamentos', 'intencao_balance_transaction_available_on'),
    ).toBeUndefined();

    // 019 collapse_state_machines → drops intencao_contribuinte_* columns
    const downCollapseStateMachines = await migrator.migrateDown();
    expect(downCollapseStateMachines.error).toBeUndefined();
    expect(await getColumn(db, 'pagamentos', 'intencao_contribuinte_email')).toBeUndefined();

    // aperture-qatwz added two paginated-browse indexes on usuarios (013).
    // Verify the indexes exist (no new tables here — pure index migration).
    const indexes = await db
      .selectFrom('pg_indexes' as never)
      .select('indexname' as never)
      .where('schemaname' as never, '=', 'public' as never)
      .where('tablename' as never, '=', 'usuarios' as never)
      .execute();
    const indexNames = indexes.map((i: Record<string, unknown>) => i.indexname);
    expect(indexNames).toContain('usuarios_plataforma_criado_em_id_idx');
    expect(indexNames).toContain('usuarios_plataforma_nome_id_idx');

    // aperture-vcen4 widened sessions.ip_address to varchar(128) on top
    // of the BetterAuth migration 009 default of varchar(45) (014).
    // Verify the widened length is in effect.
    const ipColBefore = (await db
      .selectFrom('information_schema.columns' as never)
      .select(['character_maximum_length' as never])
      .where('table_schema' as never, '=', 'public' as never)
      .where('table_name' as never, '=', 'sessions' as never)
      .where('column_name' as never, '=', 'ip_address' as never)
      .executeTakeFirst()) as { character_maximum_length: number } | undefined;
    expect(ipColBefore?.character_maximum_length).toBe(128);

    // aperture-bjshv added the passthrough_surcharge tipo CHECK extension
    // (015). Verify the constraint allows the new literal — Postgres
    // surfaces pg_constraint rows for CHECK constraints; we read the
    // definition via pg_get_constraintdef.
    const tipoConstraint = (await db
      .selectFrom('pg_constraint' as never)
      .select((_eb) => [
        // biome-ignore lint/suspicious/noExplicitAny: pg_constraint not in DB types
        sql<string>`pg_get_constraintdef(oid)`.as('def') as any,
      ])
      .where('conname' as never, '=', 'lancamentos_financeiros_tipo_check' as never)
      .executeTakeFirst()) as { def: string } | undefined;
    expect(tipoConstraint?.def).toContain('credito_passthrough_surcharge');

    // aperture-1n6u8 created the payment_webhook_events archive table
    // (016). Verify the table + UNIQUE constraint exist.
    expect(tableNames).toContain('payment_webhook_events');
    const webhookConstraints = await db
      .selectFrom('pg_constraint' as never)
      .select('conname' as never)
      .where(
        'conrelid' as never,
        '=',
        // biome-ignore lint/suspicious/noExplicitAny: pg_catalog oid regclass not in DB types
        sql`'payment_webhook_events'::regclass` as any,
      )
      .execute();
    const conNames = webhookConstraints.map((c: Record<string, unknown>) => c.conname);
    expect(conNames).toContain('payment_webhook_events_provider_event_id_uniq');

    // aperture-led0r added matura_em column + partial index (017).
    const maturaEmCol = (await db
      .selectFrom('information_schema.columns' as never)
      .select(['is_nullable' as never, 'data_type' as never])
      .where('table_schema' as never, '=', 'public' as never)
      .where('table_name' as never, '=', 'lancamentos_financeiros' as never)
      .where('column_name' as never, '=', 'matura_em' as never)
      .executeTakeFirst()) as { is_nullable: string; data_type: string } | undefined;
    expect(maturaEmCol?.data_type).toBe('timestamp with time zone');
    expect(maturaEmCol?.is_nullable).toBe('NO');
    const lancamentoIndexes = await db
      .selectFrom('pg_indexes' as never)
      .select('indexname' as never)
      .where('schemaname' as never, '=', 'public' as never)
      .where('tablename' as never, '=', 'lancamentos_financeiros' as never)
      .execute();
    const lancamentoIdxNames = lancamentoIndexes.map((i: Record<string, unknown>) => i.indexname);
    expect(lancamentoIdxNames).toContain('lancamentos_pendentes_maturos_idx');

    // aperture-wif8s added intencao_payment_intent_external_ref +
    // intencao_charge_external_ref + 2 partial indexes (018).
    const piCol = (await db
      .selectFrom('information_schema.columns' as never)
      .select(['data_type' as never, 'is_nullable' as never])
      .where('table_schema' as never, '=', 'public' as never)
      .where('table_name' as never, '=', 'pagamentos' as never)
      .where('column_name' as never, '=', 'intencao_payment_intent_external_ref' as never)
      .executeTakeFirst()) as { data_type: string; is_nullable: string } | undefined;
    expect(piCol?.data_type).toBe('text');
    expect(piCol?.is_nullable).toBe('YES');
    const chCol = (await db
      .selectFrom('information_schema.columns' as never)
      .select(['data_type' as never, 'is_nullable' as never])
      .where('table_schema' as never, '=', 'public' as never)
      .where('table_name' as never, '=', 'pagamentos' as never)
      .where('column_name' as never, '=', 'intencao_charge_external_ref' as never)
      .executeTakeFirst()) as { data_type: string; is_nullable: string } | undefined;
    expect(chCol?.data_type).toBe('text');
    expect(chCol?.is_nullable).toBe('YES');
    const pagamentoIndexes = await db
      .selectFrom('pg_indexes' as never)
      .select('indexname' as never)
      .where('schemaname' as never, '=', 'public' as never)
      .where('tablename' as never, '=', 'pagamentos' as never)
      .execute();
    const pagamentoIdxNames = pagamentoIndexes.map((i: Record<string, unknown>) => i.indexname);
    expect(pagamentoIdxNames).toContain('pagamentos_intencao_pi_ref_idx');
    expect(pagamentoIdxNames).toContain('pagamentos_intencao_ch_ref_idx');

    // Migrate down (latest migration first). aperture-wif8s added pi+ch
    // columns + indexes (018) on top of led0r matura_em (017), webhook
    // archive (016), bjshv passthrough (015), vcen4 ip widen (014),
    // paginated-indexes (013), financeiro (012), pagamentos (011), slug
    // (010), better-auth (009), usuario (008).
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

    // After down on 015, the constraint is back to the 2-literal enum.
    const tipoConstraintAfterDown = (await db
      .selectFrom('pg_constraint' as never)
      .select((_eb) => [
        // biome-ignore lint/suspicious/noExplicitAny: same
        sql<string>`pg_get_constraintdef(oid)`.as('def') as any,
      ])
      .where('conname' as never, '=', 'lancamentos_financeiros_tipo_check' as never)
      .executeTakeFirst()) as { def: string } | undefined;
    expect(tipoConstraintAfterDown?.def).not.toContain('credito_passthrough_surcharge');
    expect(tipoConstraintAfterDown?.def).toContain('credito_saldo_recebedor');

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
