import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * recebedores: add the `'conta'` (bank-account) receiver variant alongside
 * the existing `'pix'` one (aperture-mcvyw).
 *
 * `DadosRecebedor` became a discriminated union by `metodo`:
 *   - `'pix'`   → tipo_chave_pix + chave_pix (today's shape).
 *   - `'conta'` → full Brazilian bank-account coords (cpf_titular,
 *                 celular_titular, codigo_banco, agencia[+digito],
 *                 conta+digito, tipo_conta).
 *
 * The pix columns become NULLABLE (a `'conta'` row has no PIX key) and a
 * row-level CHECK enforces the variant shape: pix ⇒ pix cols NOT NULL,
 * conta ⇒ bank cols NOT NULL. Existing rows backfill to `'pix'`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1) metodo: add nullable, backfill existing rows to 'pix', then NOT NULL + CHECK.
  await db.schema.alterTable('recebedores').addColumn('metodo', 'varchar(10)').execute();

  await sql`UPDATE recebedores SET metodo = 'pix' WHERE metodo IS NULL`.execute(db);

  await sql`ALTER TABLE recebedores ALTER COLUMN metodo SET NOT NULL`.execute(db);

  await sql`
    ALTER TABLE recebedores
    ADD CONSTRAINT recebedores_metodo_check
    CHECK (metodo IN ('pix', 'conta'))
  `.execute(db);

  // 2) pix columns become nullable (conta rows carry no PIX key).
  await sql`
    ALTER TABLE recebedores
    ALTER COLUMN tipo_chave_pix DROP NOT NULL,
    ALTER COLUMN chave_pix DROP NOT NULL
  `.execute(db);

  // The original tipo_chave_pix CHECK forbade NULL implicitly (NOT NULL did
  // the work); relax it to explicitly allow NULL for conta rows.
  await sql`
    ALTER TABLE recebedores DROP CONSTRAINT recebedores_tipo_chave_pix_check
  `.execute(db);
  await sql`
    ALTER TABLE recebedores
    ADD CONSTRAINT recebedores_tipo_chave_pix_check
    CHECK (tipo_chave_pix IS NULL OR tipo_chave_pix IN ('cpf', 'cnpj', 'email', 'telefone', 'aleatoria'))
  `.execute(db);

  // 3) bank-account columns (all nullable — only set on conta rows).
  await db.schema
    .alterTable('recebedores')
    .addColumn('cpf_titular', 'varchar(20)')
    .addColumn('celular_titular', 'varchar(20)')
    .addColumn('codigo_banco', 'varchar(3)')
    .addColumn('agencia', 'varchar(10)')
    .addColumn('agencia_digito', 'varchar(2)')
    .addColumn('conta', 'varchar(20)')
    .addColumn('conta_digito', 'varchar(2)')
    .addColumn('tipo_conta', 'varchar(4)')
    .execute();

  await sql`
    ALTER TABLE recebedores
    ADD CONSTRAINT recebedores_tipo_conta_check
    CHECK (tipo_conta IS NULL OR tipo_conta IN ('cc', 'cp', 'pg', 'csl'))
  `.execute(db);

  // 4) variant integrity: pix ⇒ pix cols NOT NULL; conta ⇒ bank cols NOT NULL.
  await sql`
    ALTER TABLE recebedores
    ADD CONSTRAINT recebedores_variante_check CHECK (
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
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE recebedores DROP CONSTRAINT IF EXISTS recebedores_variante_check
  `.execute(db);
  await sql`
    ALTER TABLE recebedores DROP CONSTRAINT IF EXISTS recebedores_tipo_conta_check
  `.execute(db);

  await db.schema
    .alterTable('recebedores')
    .dropColumn('cpf_titular')
    .dropColumn('celular_titular')
    .dropColumn('codigo_banco')
    .dropColumn('agencia')
    .dropColumn('agencia_digito')
    .dropColumn('conta')
    .dropColumn('conta_digito')
    .dropColumn('tipo_conta')
    .execute();

  // Restore the original (NULL-forbidding) pix CHECK + NOT NULL columns.
  // Any 'conta' rows would violate the NOT NULL restore; this down() assumes
  // a clean reversal on a pix-only dataset (greenfield for conta).
  await sql`
    ALTER TABLE recebedores DROP CONSTRAINT recebedores_tipo_chave_pix_check
  `.execute(db);
  await sql`
    ALTER TABLE recebedores
    ADD CONSTRAINT recebedores_tipo_chave_pix_check
    CHECK (tipo_chave_pix IN ('cpf', 'cnpj', 'email', 'telefone', 'aleatoria'))
  `.execute(db);
  await sql`
    ALTER TABLE recebedores
    ALTER COLUMN tipo_chave_pix SET NOT NULL,
    ALTER COLUMN chave_pix SET NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE recebedores DROP CONSTRAINT IF EXISTS recebedores_metodo_check
  `.execute(db);
  await db.schema.alterTable('recebedores').dropColumn('metodo').execute();
}
