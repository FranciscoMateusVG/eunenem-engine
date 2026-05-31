import { type Kysely, sql } from 'kysely';

/**
 * Create the `pagamentos` table (aperture-xaha2).
 *
 * The Pagamento aggregate (BC Pagamentos) has been in-memory-only until
 * now. Wiring eunenem-server's visitor checkout to Stripe requires
 * durable persistence so that webhook → finalize round-trips survive
 * tsx-watch reloads + production deploys.
 *
 * Schema mirrors the aggregate shape from src/domain/pagamentos/entities/pagamento.ts:
 *   - Root identity + lifecycle: id, status, criado_em, atualizado_em
 *   - IntencaoPagamento (embedded entity): id, id_contribuicao, amount_cents,
 *     metodo, composicao_valores (jsonb snapshot), external_ref (nullable,
 *     populated only for CheckoutSessionProvider flows), criada_em
 *   - TransacaoExterna (embedded entity, post-settlement): jsonb (nullable
 *     until status transitions to aprovado/rejeitado)
 *
 * The composition value-objects are stored as JSONB (single column) rather
 * than promoted to dedicated columns — they're loaded/saved atomically
 * with the aggregate root and never queried individually. Same pattern as
 * other aggregates in this engine.
 *
 * `external_ref` has a UNIQUE constraint via a partial index (only the
 * non-null values are unique — multiple non-checkout-session pagamentos
 * may all carry null without colliding). Adapter's
 * `findByExternalRef(externalRef: string)` query uses this index.
 *
 * `intencao_id` is also UNIQUE — by convention every Pagamento has exactly
 * one Intencao, and the existing in-memory adapter throws
 * PagamentoJaExisteError on (idPagamento, idIntencaoPagamento) collision.
 * The Postgres adapter surfaces the same error via the
 * `pagamentos_intencao_id_uniq` constraint.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('pagamentos')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    // Lifecycle + audit
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull())
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull())
    // IntencaoPagamento (embedded entity)
    .addColumn('intencao_id', 'uuid', (col) => col.notNull())
    .addColumn('intencao_id_contribuicao', 'uuid', (col) => col.notNull())
    .addColumn('intencao_amount_cents', 'integer', (col) => col.notNull())
    .addColumn('intencao_metodo', 'text', (col) => col.notNull())
    .addColumn('intencao_composicao_valores', 'jsonb', (col) => col.notNull())
    .addColumn('intencao_external_ref', 'text') // nullable
    .addColumn('intencao_criada_em', 'timestamptz', (col) => col.notNull())
    // TransacaoExterna (embedded entity, post-settlement)
    .addColumn('transacao_externa', 'jsonb') // nullable until aprovado/rejeitado
    .execute();

  // Unique-by-design intencao id — surfaces PagamentoJaExisteError on collision.
  await db.schema
    .alterTable('pagamentos')
    .addUniqueConstraint('pagamentos_intencao_id_uniq', ['intencao_id'])
    .execute();

  // Partial unique index on external_ref — only enforces uniqueness on
  // non-null values, so the sync-topology pagamentos (null externalRef)
  // don't collide with each other. The adapter's findByExternalRef uses
  // this index for O(log n) lookups.
  await sql`
    CREATE UNIQUE INDEX pagamentos_intencao_external_ref_uniq
    ON pagamentos (intencao_external_ref)
    WHERE intencao_external_ref IS NOT NULL
  `.execute(db);

  // Lookup index for finalize-aprovado/rejeitado round-trips that load by
  // id_contribuicao when correlating the contribuicao mural insert with
  // the pagamento (read-side flexibility — costs little, helps debug).
  await db.schema
    .createIndex('pagamentos_intencao_id_contribuicao_idx')
    .on('pagamentos')
    .column('intencao_id_contribuicao')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('pagamentos').execute();
}
