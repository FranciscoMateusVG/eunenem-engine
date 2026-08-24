import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, Migrator, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import catalogSnapshot from '../../migrations/seed/20260727_045_catalog.json';
import listasSnapshot from '../../migrations/seed/20260727_045_listas-prontas.json';
import { createMigrationProvider } from '../helpers/migration-provider.js';

const CATALOG_CATEGORY_LABELS = [
  ['fraldas', 'fraldas'],
  ['higiene', 'higiene'],
  ['roupa', 'roupinhas'],
  ['soninho', 'soninho'],
  ['alimentacao', 'alimentação'],
  ['passeio', 'passeio'],
  ['brinquedo', 'brinquedos'],
  ['outros', 'outros'],
] as const;

const CATALOG_SNAPSHOT_SHA256 = '31345d2e3c1580f49186f311efedd8379f405c7064ed70690fc8c651553157b7';
const LISTAS_SNAPSHOT_SHA256 = '450b7404db7c38af67d30d04cfff778605139d1e93a76487a81cc7f7517c1c2a';

async function sha256(url: URL): Promise<string> {
  return createHash('sha256')
    .update(await readFile(url))
    .digest('hex');
}

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

  it('pins immutable catalog seed snapshot bytes', async () => {
    expect(
      await sha256(new URL('../../migrations/seed/20260727_045_catalog.json', import.meta.url)),
    ).toBe(CATALOG_SNAPSHOT_SHA256);
    expect(
      await sha256(
        new URL('../../migrations/seed/20260727_045_listas-prontas.json', import.meta.url),
      ),
    ).toBe(LISTAS_SNAPSHOT_SHA256);
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
    // dados_recebimento_usuario (028) was DROPPED by migration 039 (recebedor-
    // per-campanha unification) — no longer expected to exist post-migrateToLatest.
    expect(tableNames).not.toContain('dados_recebimento_usuario');
    expect(tableNames).toContain('resgates_pendentes');
    // 038 resgates_pendentes_por_campanha: PK is id_campanha now, not id_usuario.
    expect(await getColumn(db, 'resgates_pendentes', 'id_campanha')).toBeDefined();
    expect(await getColumn(db, 'resgates_pendentes', 'id_usuario')).toBeUndefined();

    // 035 create_perfil_campanhas (aperture-aphk8): table + campanhas.slug.
    expect(tableNames).toContain('perfil_campanhas');
    const campanhaSlugCol = await getColumn(db, 'campanhas', 'slug');
    expect(campanhaSlugCol?.data_type).toBe('character varying');
    expect(campanhaSlugCol?.character_maximum_length).toBe(60);
    expect(campanhaSlugCol?.is_nullable).toBe('YES');

    // 040 add_personalizacao_to_perfil_campanhas (aperture-hsxim): the actual
    //   TIP now (20260710_040 sorts last). Adds three nullable TweaksPanel
    //   ("Personalizar") columns to perfil_campanhas — papais (varchar 120),
    //   cor_primaria + cor_acento (varchar 20). All nullable free text/hex.
    const papaisCol = await getColumn(db, 'perfil_campanhas', 'papais');
    expect(papaisCol?.data_type).toBe('character varying');
    expect(papaisCol?.character_maximum_length).toBe(120);
    expect(papaisCol?.is_nullable).toBe('YES');
    expect((await getColumn(db, 'perfil_campanhas', 'cor_primaria'))?.is_nullable).toBe('YES');
    expect((await getColumn(db, 'perfil_campanhas', 'cor_acento'))?.is_nullable).toBe('YES');

    // 041 add_slug_alterado_em_to_campanhas (aperture-aphk8): the actual TIP
    //   now (20260711_041 sorts last). Adds nullable campanhas.slug_alterado_em
    //   (timestamptz) — the "already used the one-time perfil slug swap?" flag.
    const slugAlteradoCol = await getColumn(db, 'campanhas', 'slug_alterado_em');
    expect(slugAlteradoCol?.data_type).toBe('timestamp with time zone');
    expect(slugAlteradoCol?.is_nullable).toBe('YES');

    // 20260716_042_repasse_transfer (aperture-vvh2j): the actual TIP now.
    //   Adds the transfer bookkeeping columns to repasses_recebedor + the
    //   append-only repasse_transfer_attempts audit table, and widens the
    //   status CHECK to the full 7-state transfer FSM.
    expect(tableNames).toContain('repasse_transfer_attempts');
    expect((await getColumn(db, 'repasses_recebedor', 'transfer_referencia'))?.is_nullable).toBe(
      'YES',
    );
    expect((await getColumn(db, 'repasses_recebedor', 'transfer_attempts'))?.is_nullable).toBe(
      'NO',
    );
    expect(await getColumn(db, 'repasses_recebedor', 'inter_codigo_solicitacao')).toBeDefined();
    expect(await getColumn(db, 'repasses_recebedor', 'last_transfer_error')).toBeDefined();

    // 20260716_043_repasse_manual_resolution (aperture-477nz): the actual TIP
    //   now. Adds repasses_recebedor.needs_manual_resolution (NOT NULL default
    //   false) + the repasse_reconciliacao_candidatos table (masked-chave
    //   search candidates for admin manual resolution).
    expect(tableNames).toContain('repasse_reconciliacao_candidatos');
    expect(
      (await getColumn(db, 'repasses_recebedor', 'needs_manual_resolution'))?.is_nullable,
    ).toBe('NO');

    // 20260727_045_catalogo_admin (aperture-ldo5d): immutable JSON snapshots
    // become the platform-global catalog. Assert full field equivalence rather
    // than only "migration returned success": an empty/partial backfill is a
    // broken catalog even when its tables exist.
    expect(tableNames).toContain('catalogo_categorias');
    expect(tableNames).toContain('catalogo_produtos');
    expect(tableNames).toContain('catalogo_listas');
    expect(tableNames).toContain('catalogo_lista_itens');

    const categoryRows = await sql<{
      slug: string;
      label: string;
      position: number;
    }>`SELECT slug, label, position
       FROM catalogo_categorias
       ORDER BY position`.execute(db);
    expect(categoryRows.rows).toEqual(
      CATALOG_CATEGORY_LABELS.map(([slug, label], position) => ({ slug, label, position })),
    );

    const productRows = await sql<{
      id_legado: string;
      nome: string;
      preco_cents: string;
      quantidade_sugerida: number;
      emoji: string;
      bg_color: string;
      category_slug: string;
      position: number;
      image_url: string | null;
      popularidade: number | null;
      ativo: boolean;
    }>`SELECT
         p.id_legado, p.nome, p.preco_cents, p.quantidade_sugerida,
         p.emoji, p.bg_color, c.slug AS category_slug, p.position,
         p.image_url, p.popularidade, p.ativo
       FROM catalogo_produtos p
       JOIN catalogo_categorias c ON c.id = p.id_categoria
       ORDER BY c.position, p.position`.execute(db);

    const expectedProducts = [];
    const nextPositionByCategory = new Map<string, number>();
    for (const product of catalogSnapshot) {
      const position = nextPositionByCategory.get(product.category) ?? 0;
      nextPositionByCategory.set(product.category, position + 1);
      expectedProducts.push({
        id_legado: product.id,
        nome: product.name,
        preco_cents: String(Math.round(product.price * 100)),
        quantidade_sugerida: product.suggestedQty,
        emoji: product.emoji,
        bg_color: product.bgColor,
        category_slug: product.category,
        position,
        image_url: product.imageUrl,
        popularidade: 'popularity' in product ? product.popularity : null,
        ativo: true,
      });
    }
    const categoryRank = new Map<string, number>(
      CATALOG_CATEGORY_LABELS.map(([slug], position) => [slug, position]),
    );
    expectedProducts.sort(
      (left, right) =>
        (categoryRank.get(left.category_slug) ?? -1) -
          (categoryRank.get(right.category_slug) ?? -1) || left.position - right.position,
    );
    expect(productRows.rows).toHaveLength(501);
    expect(productRows.rows).toEqual(expectedProducts);

    const listRows = await sql<{
      slug: string;
      nome: string;
      descricao: string | null;
      image_url: string | null;
      position: number;
      ativo: boolean;
    }>`SELECT slug, nome, descricao, image_url, position, ativo
       FROM catalogo_listas
       ORDER BY position`.execute(db);
    expect(listRows.rows).toEqual(
      listasSnapshot.map((lista, position) => ({
        slug: lista.id,
        nome: lista.title,
        descricao: lista.description,
        image_url: lista.imageUrl,
        position,
        ativo: true,
      })),
    );

    const listItemRows = await sql<{
      list_slug: string;
      product_legacy_id: string;
      quantidade: number;
      position: number;
    }>`SELECT
         l.slug AS list_slug,
         p.id_legado AS product_legacy_id,
         li.quantidade,
         li.position
       FROM catalogo_lista_itens li
       JOIN catalogo_listas l ON l.id = li.id_lista
       JOIN catalogo_produtos p ON p.id = li.id_produto
       ORDER BY l.position, li.position`.execute(db);
    expect(listItemRows.rows).toHaveLength(77);
    expect(listItemRows.rows).toEqual(
      listasSnapshot.flatMap((lista) =>
        lista.items.map((item, position) => ({
          list_slug: lista.id,
          product_legacy_id: item.id,
          quantidade: item.suggestedQty,
          position,
        })),
      ),
    );

    const conviteRemetenteCol = await getColumn(db, 'convites', 'remetente');
    expect(conviteRemetenteCol?.data_type).toBe('character varying');
    expect(conviteRemetenteCol?.character_maximum_length).toBe(120);
    expect(conviteRemetenteCol?.is_nullable).toBe('NO');

    // 035 eventos_data_hora_nullable: data_hora is optional post-migration.
    const eventoDataHoraCol = await getColumn(db, 'eventos', 'data_hora');
    expect(eventoDataHoraCol?.is_nullable).toBe('YES');

    // 20260805_048_add_pix_cobranca_reconciliation: persisted PIX expiry plus
    // an operational worker lease. Both are nullable so legacy rows remain
    // valid; the partial index covers only deterministic due-PIX candidates.
    const pixExpiraEmCol = await getColumn(db, 'pagamentos', 'intencao_expira_em');
    expect(pixExpiraEmCol?.data_type).toBe('timestamp with time zone');
    expect(pixExpiraEmCol?.is_nullable).toBe('YES');
    const pixClaimedUntilCol = await getColumn(db, 'pagamentos', 'pix_reconciliacao_claimed_until');
    expect(pixClaimedUntilCol?.data_type).toBe('timestamp with time zone');
    expect(pixClaimedUntilCol?.is_nullable).toBe('YES');
    expect(await listIndexNames(db, 'pagamentos')).toContain(
      'pagamentos_pix_reconciliacao_due_idx',
    );

    // 20260805_049_add_inter_pix_refunds: Inter refund state is durable
    // because devolucao is asynchronous. Provider identifiers only; no PII.
    expect(tableNames).toContain('pix_cobranca_devolucoes');
    const e2eExternalRefCol = await getColumn(db, 'pagamentos', 'intencao_e2e_external_ref');
    expect(e2eExternalRefCol?.data_type).toBe('text');
    expect(e2eExternalRefCol?.is_nullable).toBe('YES');
    expect(await listIndexNames(db, 'pagamentos')).toContain('pagamentos_intencao_e2e_ref_uniq');
    const e2eExternalRefIndex = await getIndexDefinition(db, 'pagamentos_intencao_e2e_ref_uniq');
    expect(e2eExternalRefIndex).toContain('CREATE UNIQUE INDEX');
    expect(e2eExternalRefIndex).toContain('WHERE (intencao_e2e_external_ref IS NOT NULL)');

    const refundIdCol = await getColumn(db, 'pix_cobranca_devolucoes', 'id_devolucao');
    expect(refundIdCol?.data_type).toBe('character varying');
    expect(refundIdCol?.character_maximum_length).toBe(35);
    expect(refundIdCol?.is_nullable).toBe('NO');
    expect((await getColumn(db, 'pix_cobranca_devolucoes', 'amount_cents'))?.data_type).toBe(
      'bigint',
    );
    expect((await getColumn(db, 'pix_cobranca_devolucoes', 'status'))?.is_nullable).toBe('NO');
    expect((await getColumn(db, 'pix_cobranca_devolucoes', 'rtr_id'))?.is_nullable).toBe('YES');
    expect(await listIndexNames(db, 'pix_cobranca_devolucoes')).toEqual(
      expect.arrayContaining([
        'pix_cobranca_devolucoes_pkey',
        'pix_cobranca_devolucoes_id_pagamento_uniq',
        'pix_cobranca_devolucoes_e2e_id_id_devolucao_uniq',
        'pix_cobranca_devolucoes_rtr_id_idx',
      ]),
    );

    const refundIdConstraint = await getConstraintDefinition(
      db,
      'pix_cobranca_devolucoes_id_devolucao_check',
    );
    expect(refundIdConstraint).toContain('^[A-Za-z0-9]+$');
    expect(refundIdConstraint).toContain('char_length');
    expect(refundIdConstraint).toContain('26');
    expect(refundIdConstraint).toContain('35');
    const refundE2eConstraint = await getConstraintDefinition(
      db,
      'pix_cobranca_devolucoes_e2e_id_check',
    );
    expect(refundE2eConstraint).toContain('char_length');
    expect(refundE2eConstraint).toContain('32');
    expect(refundE2eConstraint).toContain('^[A-Za-z0-9]+$');
    expect(
      await getConstraintDefinition(db, 'pix_cobranca_devolucoes_amount_cents_check'),
    ).toContain('amount_cents > 0');
    const refundStatusConstraint = await getConstraintDefinition(
      db,
      'pix_cobranca_devolucoes_status_check',
    );
    for (const status of ['em_processamento', 'devolvida', 'nao_realizada', 'rejeitada']) {
      expect(refundStatusConstraint).toContain(status);
    }
    expect(refundStatusConstraint).not.toContain('cancelada');

    // The DB backstop accepts both identifier boundaries and rejects values
    // outside them, non-ASCII-alphanumeric ids, and non-positive amounts.
    await insertRefundConstraintFixture(db);
    await expectInsertRefund(db, 'A'.repeat(26), 1, true, 'E'.repeat(32));
    await expectInsertRefund(db, 'Z'.repeat(35), 1, true);
    await expectInsertRefund(db, 'A'.repeat(25), 1, false);
    await expectInsertRefund(db, 'A'.repeat(36), 1, false);
    await expectInsertRefund(db, `${'A'.repeat(25)}-`, 1, false);
    await expectInsertRefund(db, 'A'.repeat(26), 0, false);
    await expectInsertRefund(db, 'A'.repeat(26), 1, false, 'E'.repeat(31));
    await expectInsertRefund(db, 'A'.repeat(26), 1, false, 'E'.repeat(33));
    await expectInsertRefund(db, 'A'.repeat(26), 1, false, `${'E'.repeat(31)}-`);
    await sql`DELETE FROM pagamentos WHERE id = '20000000-0000-4000-8000-000000000049'`.execute(db);
    await sql`DELETE FROM campanhas WHERE id = '10000000-0000-4000-8000-000000000049'`.execute(db);

    // 037 unify_evento_data_single_source (aperture-mu1v9): eventos rows may
    // be PARTIAL — modalidade AND tipo_evento are optional post-migration.
    expect((await getColumn(db, 'eventos', 'modalidade'))?.is_nullable).toBe('YES');
    expect((await getColumn(db, 'eventos', 'tipo_evento'))?.is_nullable).toBe('YES');

    // ── Roll back the post-evento migrations first (latest → earliest),
    //    so the subsequent evento down-step actually targets the evento
    //    migration. Each migrateDown() unwinds exactly the current tip, so
    //    this sequence must start at the LATEST migration and walk earlier.
    //    Adding a new migration on top REQUIRES prepending its down-step here.

    // 20260805_049_add_inter_pix_refunds (aperture-2nbg6) → the actual TIP.
    // Its down() removes the refund table, e2e reference, and lookup index.
    const downInterPixRefunds = await migrator.migrateDown();
    expect(downInterPixRefunds.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('pix_cobranca_devolucoes');
    expect(await getColumn(db, 'pagamentos', 'intencao_e2e_external_ref')).toBeUndefined();
    expect(await listIndexNames(db, 'pagamentos')).not.toContain(
      'pagamentos_intencao_e2e_ref_uniq',
    );
    expect(await getColumn(db, 'pagamentos', 'intencao_expira_em')).toBeDefined();

    // 20260805_048_add_pix_cobranca_reconciliation (aperture-fpd0j) → the
    // TIP after 049. Its down() removes the partial candidate index and both
    // nullable reconciliation columns without touching payment rows.
    const downPixCobrancaReconciliation = await migrator.migrateDown();
    expect(downPixCobrancaReconciliation.error).toBeUndefined();
    expect(await getColumn(db, 'pagamentos', 'intencao_expira_em')).toBeUndefined();
    expect(await getColumn(db, 'pagamentos', 'pix_reconciliacao_claimed_until')).toBeUndefined();
    expect(await listIndexNames(db, 'pagamentos')).not.toContain(
      'pagamentos_pix_reconciliacao_due_idx',
    );
    expect(await getColumn(db, 'convites', 'assinatura')).toBeDefined();

    // ── aperture-hdftp CI repair (2026-07-07): the three convite-feature
    //    migrations below (032/033/034) landed on staging without prepending
    //    their down-steps here — the exact off-by-one this block warns about,
    //    now its THIRD occurrence. Prepended to restore alignment; the real
    //    tip is 20260705_034.

    // ── aperture-3vc12 CI repair (2026-07-09): 20260708_035_eventos_data_
    //    hora_nullable landed on staging in parallel with #359 WITHOUT
    //    prepending its down-step — the FOURTH occurrence of this off-by-one.
    //    Worse, it DUPLICATES the 035 number ('..._035_eventos...' sorts
    //    after '..._035_create_perfil...' so kysely ordering stays defined,
    //    but the numeric prefix collision is a naming smell — see the 023
    //    note above; renaming a DEPLOYED migration is forbidden because
    //    kysely_migration keys on the filename and would re-run it).

    // ── aperture-d3tlf CI repair (2026-08-05): 20260801_047_add_assinatura_
    //    to_convites (PR #55) landed on staging WITHOUT prepending its
    //    down-step here — the TWELFTH occurrence of the off-by-one this block
    //    warns about. Every staging PR inherited the red until this prepend.

    // 20260801_047_add_assinatura_to_convites (aperture-zy4uo) → the actual
    // TIP. Its down() drops only convites.assinatura.
    const downAssinatura = await migrator.migrateDown();
    expect(downAssinatura.error).toBeUndefined();
    expect(await getColumn(db, 'convites', 'assinatura')).toBeUndefined();
    expect(await listTableNames(db)).toContain('catalogo_admin_audit_events');

    // 20260727_046_catalogo_admin_audit (aperture-1bity) → the TIP after 047.
    // Its down() removes only the immutable audit trail and leaves the catalog.
    const downCatalogoAdminAudit = await migrator.migrateDown();
    expect(downCatalogoAdminAudit.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('catalogo_admin_audit_events');
    expect(await listTableNames(db)).toContain('catalogo_produtos');

    // 20260727_045_catalogo_admin (aperture-ldo5d) → the TIP after 046.
    // Its down() drops all four catalog tables in FK-safe order.
    const downCatalogoAdmin = await migrator.migrateDown();
    expect(downCatalogoAdmin.error).toBeUndefined();
    const tablesAfterCatalogoDown = await listTableNames(db);
    expect(tablesAfterCatalogoDown).not.toContain('catalogo_lista_itens');
    expect(tablesAfterCatalogoDown).not.toContain('catalogo_listas');
    expect(tablesAfterCatalogoDown).not.toContain('catalogo_produtos');
    expect(tablesAfterCatalogoDown).not.toContain('catalogo_categorias');

    // 20260718_044_add_onboarding_concluido_em_to_usuarios (aperture-lrl1h) →
    //   the actual TIP after 045. Prepended per the contract above (ELEVENTH
    //   occurrence of the off-by-one this block warns about). Its down() drops
    //   usuarios.onboarding_concluido_em. THIS is the true first migrateDown.
    const downOnboardingConcluido = await migrator.migrateDown();
    expect(downOnboardingConcluido.error).toBeUndefined();
    expect(await getColumn(db, 'usuarios', 'onboarding_concluido_em')).toBeUndefined();

    // 20260716_043_repasse_manual_resolution (aperture-477nz) → the TIP after
    //   the 044 down-step above. Its down() drops the
    //   repasse_reconciliacao_candidatos table + the needs_manual_resolution
    //   column.
    const downManualResolution = await migrator.migrateDown();
    expect(downManualResolution.error).toBeUndefined();
    expect(await getColumn(db, 'repasses_recebedor', 'needs_manual_resolution')).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('repasse_reconciliacao_candidatos');

    // 20260716_042_repasse_transfer (aperture-vvh2j) → now the tip after the
    //   043 down-step above. Its down() drops repasse_transfer_attempts + the
    //   4 transfer columns and restores the 2-state status CHECK.
    const downRepasseTransfer = await migrator.migrateDown();
    expect(downRepasseTransfer.error).toBeUndefined();
    expect(await getColumn(db, 'repasses_recebedor', 'transfer_referencia')).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('repasse_transfer_attempts');

    // 20260711_041_add_slug_alterado_em_to_campanhas (aperture-aphk8) → now
    //   the SECOND migrateDown. Its down() drops campanhas.slug_alterado_em.
    const downSlugAlteradoEm = await migrator.migrateDown();
    expect(downSlugAlteradoEm.error).toBeUndefined();
    expect(await getColumn(db, 'campanhas', 'slug_alterado_em')).toBeUndefined();

    // 20260710_040_add_personalizacao_to_perfil_campanhas (aperture-hsxim) →
    //   now the SECOND migrateDown (EIGHTH occurrence of the off-by-one —
    //   also landed on top without prepending its down-step). Its down() drops
    //   the three TweaksPanel columns from perfil_campanhas.
    const downPersonalizacao = await migrator.migrateDown();
    expect(downPersonalizacao.error).toBeUndefined();
    expect(await getColumn(db, 'perfil_campanhas', 'papais')).toBeUndefined();
    expect(await getColumn(db, 'perfil_campanhas', 'cor_primaria')).toBeUndefined();
    expect(await getColumn(db, 'perfil_campanhas', 'cor_acento')).toBeUndefined();

    // 20260710_039_drop_dados_recebimento_usuario → now the SECOND migrateDown.
    //   Its down() recreates dados_recebimento_usuario
    //   (recebedor-per-campanha unification retired the usuario-level store).
    const downDropDadosRecebimento = await migrator.migrateDown();
    expect(downDropDadosRecebimento.error).toBeUndefined();
    expect(await listTableNames(db)).toContain('dados_recebimento_usuario');

    // 20260710_038_resgates_pendentes_por_campanha → the SECOND migrateDown.
    //   Its down() recreates resgates_pendentes keyed by id_usuario (the
    //   pre-recebedor-per-campanha shape).
    const downResgatesPorCampanha = await migrator.migrateDown();
    expect(downResgatesPorCampanha.error).toBeUndefined();
    expect(await getColumn(db, 'resgates_pendentes', 'id_usuario')).toBeDefined();
    expect(await getColumn(db, 'resgates_pendentes', 'id_campanha')).toBeUndefined();

    // 20260709_036_require_cpf_titular_on_pix_recebedor → the THIRD
    //   migrateDown. Its down() reverts the two variant CHECK constraints
    //   (recebedores + dados_recebimento_usuario) back to the pre-036 shape
    //   (cpf_titular required on conta rows only).
    const downRequireCpfTitularPix = await migrator.migrateDown();
    expect(downRequireCpfTitularPix.error).toBeUndefined();

    // 037 unify_evento_data_single_source (aperture-mu1v9) → the actual TIP
    //   (20260710_037 sorts last), so the FIRST migrateDown unwinds it:
    //   modalidade + tipo_evento back to NOT NULL (shape-only/lossy down —
    //   see the migration's comment).
    const downUnifyEventoData = await migrator.migrateDown();
    expect(downUnifyEventoData.error).toBeUndefined();
    expect((await getColumn(db, 'eventos', 'modalidade'))?.is_nullable).toBe('NO');
    expect((await getColumn(db, 'eventos', 'tipo_evento'))?.is_nullable).toBe('NO');

    // 035 eventos_data_hora_nullable → the SECOND migrateDown ('e' sorts
    //   after 'c'): data_hora back to NOT NULL.
    const downEventosDataHora = await migrator.migrateDown();
    expect(downEventosDataHora.error).toBeUndefined();
    expect((await getColumn(db, 'eventos', 'data_hora'))?.is_nullable).toBe('NO');

    // 035 create_perfil_campanhas (aperture-aphk8) → the THIRD migrateDown.
    //   Its down() drops the perfil_campanhas table, the campanhas_slug_idx
    //   index, and the campanhas.slug column.
    const downPerfilCampanhas = await migrator.migrateDown();
    expect(downPerfilCampanhas.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('perfil_campanhas');
    expect(await getColumn(db, 'campanhas', 'slug')).toBeUndefined();
    expect(await listIndexNames(db, 'campanhas')).not.toContain('campanhas_slug_idx');

    // 034 drop_link_confirmacao_from_listas_de_convidados → previously the
    //   tip; now the SECOND migrateDown. Its down() restores the
    //   link_confirmacao column as nullable text (shape only — the dropped
    //   data is unrecoverable by design).
    const downDropLinkConfirmacao = await migrator.migrateDown();
    expect(downDropLinkConfirmacao.error).toBeUndefined();
    const linkConfirmacaoCol = await getColumn(db, 'listas_de_convidados', 'link_confirmacao');
    expect(linkConfirmacaoCol?.data_type).toBe('text');

    // 033 add_formato_mensagem_convite_to_listas_de_convidados → down()
    //   drops the formato CHECK constraint + the column.
    const downFormatoMensagem = await migrator.migrateDown();
    expect(downFormatoMensagem.error).toBeUndefined();
    expect(await getColumn(db, 'listas_de_convidados', 'formato_mensagem_convite')).toBeUndefined();

    // 032 expand_convidados_presenca_check → CHECK-constraint swap only
    //   (no table/column change observable via information_schema.columns);
    //   the error-undefined assertion is the observable here.
    const downExpandPresenca = await migrator.migrateDown();
    expect(downExpandPresenca.error).toBeUndefined();

    // create_cha_rifa_waitlist (landed 2026-06-29) → now the FOURTH
    //   migrateDown (the convite migrations above sort after it). Its
    //   filename (20260629_030_create_cha_rifa_waitlist) sorts AFTER
    //   20260628_031_add_genero_to_perfil_criador, so kysely's file-ordered
    //   runner applies it later — this down drops the cha_rifa_waitlist
    //   table. (Historical note: it too originally landed without
    //   prepending its down-step — same off-by-one, second occurrence.)
    const downChaRifaWaitlist = await migrator.migrateDown();
    expect(downChaRifaWaitlist.error).toBeUndefined();
    expect(await listTableNames(db)).not.toContain('cha_rifa_waitlist');

    // 031 add_genero_to_perfil_criador (aperture-neiwx) → now the SECOND
    //   migrateDown (cha_rifa_waitlist above is the true tip). Its down() drops
    //   the perfil_criadores.genero column + its CHECK (the table itself
    //   survives until the 026 down below).
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

async function getConstraintDefinition(
  db: Kysely<unknown>,
  constraintName: string,
): Promise<string | undefined> {
  const result = (await db
    .selectFrom('pg_constraint' as never)
    .select((_eb) => [
      // biome-ignore lint/suspicious/noExplicitAny: pg_constraint is not in generated DB types
      sql<string>`pg_get_constraintdef(oid)`.as('definition') as any,
    ])
    .where('conname' as never, '=', constraintName as never)
    .executeTakeFirst()) as { definition: string } | undefined;

  return result?.definition;
}

async function getIndexDefinition(
  db: Kysely<unknown>,
  indexName: string,
): Promise<string | undefined> {
  const result = (await db
    .selectFrom('pg_indexes' as never)
    .select('indexdef' as never)
    .where('schemaname' as never, '=', 'public' as never)
    .where('indexname' as never, '=', indexName as never)
    .executeTakeFirst()) as { indexdef: string } | undefined;

  return result?.indexdef;
}

async function insertRefundConstraintFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO campanhas (id, titulo, id_plataforma, criada_em)
    VALUES (
      '10000000-0000-4000-8000-000000000049',
      'Migration 049 constraint fixture',
      '50000000-0000-4000-8000-000000000049',
      now()
    )
  `.execute(db);

  await sql`
    INSERT INTO pagamentos (
      id,
      status,
      criado_em,
      atualizado_em,
      intencao_id,
      intencao_criada_em,
      intencao_id_campanha,
      intencao_metodo,
      intencao_total_paid_cents,
      intencao_total_contribution_cents,
      intencao_total_fee_cents,
      intencao_total_receiver_cents,
      intencao_total_surcharge_cents
    ) VALUES (
      '20000000-0000-4000-8000-000000000049',
      'pendente',
      now(),
      now(),
      '30000000-0000-4000-8000-000000000049',
      now(),
      '10000000-0000-4000-8000-000000000049',
      'pix',
      1,
      1,
      0,
      1,
      0
    )
  `.execute(db);
}

async function expectInsertRefund(
  db: Kysely<unknown>,
  idDevolucao: string,
  amountCents: number,
  shouldSucceed: boolean,
  e2eId = 'E1234567890123456789012345678901',
): Promise<void> {
  const insert = () =>
    sql`
    INSERT INTO pix_cobranca_devolucoes (
      id,
      id_pagamento,
      e2e_id,
      id_devolucao,
      amount_cents,
      status
    ) VALUES (
      '40000000-0000-4000-8000-000000000049',
      '20000000-0000-4000-8000-000000000049',
      ${e2eId},
      ${idDevolucao},
      ${amountCents},
      'em_processamento'
    )
  `.execute(db);

  if (shouldSucceed) {
    await expect(insert()).resolves.toBeDefined();
    await sql`
      DELETE FROM pix_cobranca_devolucoes
      WHERE id = '40000000-0000-4000-8000-000000000049'
    `.execute(db);
    return;
  }

  await expect(insert()).rejects.toThrow();
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
