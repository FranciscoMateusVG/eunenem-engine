import { type Kysely, sql } from 'kysely';

/**
 * Create the `lancamentos_financeiros` and `repasses_recebedor` tables
 * (aperture-id3ay).
 *
 * The Livro Financeiro aggregate (BC Financeiro) was in-memory-only after
 * Pagamentos landed (migration 011). Every successful checkout was
 * computing lancamentos and "saving" them to a Map — lost on the next
 * tsx-watch reload or production deploy. This wires the persistence so
 * platform revenue + recebedor saldo survive restarts.
 *
 * ───── lancamentos_financeiros ─────
 *
 * Schema mirrors `LancamentoFinanceiro` from
 * src/domain/financeiro/entities/lancamento-financeiro.ts:
 *   - id (uuid PK)
 *   - id_pagamento, id_contribuicao — cross-BC references (uuids; no FKs
 *     into pagamentos/contribuicoes to keep BCs loosely coupled at the
 *     storage layer)
 *   - id_campanha — NULLABLE: the factory
 *     `criarLancamentosParaPagamentoAprovado` populates idCampanha on the
 *     `credito_saldo_recebedor` row but omits it on the
 *     `credito_receita_plataforma` row (platform revenue isn't tied to a
 *     specific campanha at the lancamento level).
 *   - tipo — CHECK on the enum from TipoLancamentoFinanceiroSchema
 *   - amount_cents — integer (cents; matches Pagamentos convention)
 *   - status — CHECK on the enum from StatusLancamentoSchema
 *   - criado_em — timestamptz
 *
 * Idempotency: UNIQUE (id_pagamento, tipo). Each pagamento produces
 * exactly one lancamento per tipo. The saga's
 * finalizarPagamentoAprovado step 3 pre-checks via
 * findLancamentosByIdPagamento and short-circuits replay, so this
 * constraint is defense-in-depth. The adapter catches 23505 on this
 * constraint and surfaces FinanceiroPagamentoJaRegistradoError —
 * port-conformance with the memory adapter's preflight throw.
 *
 * Indexes:
 *   - The UNIQUE (id_pagamento, tipo) covers findLancamentosByIdPagamento
 *     queries (leftmost-prefix scan on id_pagamento).
 *   - Partial index on id_campanha (WHERE NOT NULL) — covers
 *     findLancamentosByIdCampanha. Partial because half the rows have
 *     id_campanha NULL (receita_plataforma); no point indexing NULLs we
 *     never query.
 *   - Partial index on receita_plataforma rows — covers
 *     findLancamentosReceitaPlataforma. Partial keeps the index small
 *     (only ~50% of rows match).
 *
 * ───── repasses_recebedor ─────
 *
 * Schema mirrors `RepasseRecebedor`:
 *   - id (uuid PK)
 *   - id_campanha (uuid; required — repasses are always campanha-scoped)
 *   - amount_cents (integer)
 *   - status — CHECK on StatusRepasseSchema (currently only 'solicitado')
 *   - solicitado_em — timestamptz
 *
 * One lookup index on id_campanha for findRepassesByIdCampanha.
 * No uniqueness invariant — a campanha may legitimately have multiple
 * repasses over time. The memory adapter's saveRepasse is a blind
 * Map.set; the postgres equivalent is a plain INSERT.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ───── lancamentos_financeiros ─────
  await db.schema
    .createTable('lancamentos_financeiros')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_pagamento', 'uuid', (col) => col.notNull())
    .addColumn('id_contribuicao', 'uuid', (col) => col.notNull())
    .addColumn('id_campanha', 'uuid') // NULLABLE — see header comment
    .addColumn('tipo', 'text', (col) => col.notNull())
    .addColumn('amount_cents', 'integer', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull())
    .execute();

  // Tipo + status CHECK constraints — match Zod enums.
  await sql`
    ALTER TABLE lancamentos_financeiros
    ADD CONSTRAINT lancamentos_financeiros_tipo_check
    CHECK (tipo IN ('credito_saldo_recebedor', 'credito_receita_plataforma'))
  `.execute(db);

  await sql`
    ALTER TABLE lancamentos_financeiros
    ADD CONSTRAINT lancamentos_financeiros_status_check
    CHECK (status IN ('pendente', 'disponivel'))
  `.execute(db);

  // Idempotency guard — one lancamento per (pagamento, tipo).
  await db.schema
    .alterTable('lancamentos_financeiros')
    .addUniqueConstraint('lancamentos_financeiros_id_pagamento_tipo_uniq', ['id_pagamento', 'tipo'])
    .execute();

  // Partial index for findLancamentosByIdCampanha — skips NULL rows.
  await sql`
    CREATE INDEX lancamentos_financeiros_id_campanha_idx
    ON lancamentos_financeiros (id_campanha)
    WHERE id_campanha IS NOT NULL
  `.execute(db);

  // Partial index for findLancamentosReceitaPlataforma — selective.
  await sql`
    CREATE INDEX lancamentos_financeiros_receita_plataforma_idx
    ON lancamentos_financeiros (criado_em)
    WHERE tipo = 'credito_receita_plataforma'
  `.execute(db);

  // ───── repasses_recebedor ─────
  await db.schema
    .createTable('repasses_recebedor')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_campanha', 'uuid', (col) => col.notNull())
    .addColumn('amount_cents', 'integer', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('solicitado_em', 'timestamptz', (col) => col.notNull())
    .execute();

  await sql`
    ALTER TABLE repasses_recebedor
    ADD CONSTRAINT repasses_recebedor_status_check
    CHECK (status IN ('solicitado'))
  `.execute(db);

  await db.schema
    .createIndex('repasses_recebedor_id_campanha_idx')
    .on('repasses_recebedor')
    .column('id_campanha')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('repasses_recebedor').execute();
  await db.schema.dropTable('lancamentos_financeiros').execute();
}
