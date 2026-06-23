import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * DadosRecebimentoUsuario — user-level receiving-data store (aperture-mcvyw,
 * #4a-i).
 *
 * Receiving data must be editable at the USER level (settings) BEFORE any
 * campaign exists, then projected onto the active campaign's Recebedor. This
 * table is 1:1 with `usuarios`: `id_usuario` is UNIQUE with an FK to
 * `usuarios.id` ON DELETE CASCADE — same parent-link pattern as
 * `perfil_criadores` (migration 026).
 *
 * Reuses the SAME `DadosRecebedor` discriminated-union VO as Arrecadação's
 * Recebedor, so the column set mirrors the `recebedores` variant columns
 * (migration 027): `metodo` + pix cols + bank cols, with the same row-level
 * variant CHECK. Greenfield: no production data exists.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('dados_recebimento_usuario')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_usuario', 'uuid', (col) =>
      col.notNull().unique().references('usuarios.id').onDelete('cascade'),
    )
    .addColumn('metodo', 'varchar(10)', (col) => col.notNull())
    .addColumn('nome_titular', 'varchar(120)', (col) => col.notNull())
    // pix variant
    .addColumn('tipo_chave_pix', 'varchar(20)')
    .addColumn('chave_pix', 'varchar(140)')
    // conta variant
    .addColumn('cpf_titular', 'varchar(20)')
    .addColumn('celular_titular', 'varchar(20)')
    .addColumn('codigo_banco', 'varchar(3)')
    .addColumn('agencia', 'varchar(10)')
    .addColumn('agencia_digito', 'varchar(2)')
    .addColumn('conta', 'varchar(20)')
    .addColumn('conta_digito', 'varchar(2)')
    .addColumn('tipo_conta', 'varchar(4)')
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('dados_recebimento_usuario_metodo_check', sql`metodo IN ('pix', 'conta')`)
    .addCheckConstraint(
      'dados_recebimento_usuario_tipo_chave_pix_check',
      sql`tipo_chave_pix IS NULL OR tipo_chave_pix IN ('cpf', 'cnpj', 'email', 'telefone', 'aleatoria')`,
    )
    .addCheckConstraint(
      'dados_recebimento_usuario_tipo_conta_check',
      sql`tipo_conta IS NULL OR tipo_conta IN ('cc', 'cp', 'pg', 'csl')`,
    )
    .addCheckConstraint(
      'dados_recebimento_usuario_variante_check',
      sql`
        (
          metodo = 'pix'
          AND tipo_chave_pix IS NOT NULL
          AND chave_pix IS NOT NULL
        )
        OR
        (
          metodo = 'conta'
          AND cpf_titular IS NOT NULL
          AND codigo_banco IS NOT NULL
          AND agencia IS NOT NULL
          AND conta IS NOT NULL
          AND conta_digito IS NOT NULL
          AND tipo_conta IS NOT NULL
        )
      `,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('dados_recebimento_usuario').execute();
}
