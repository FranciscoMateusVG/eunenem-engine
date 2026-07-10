import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * `cpf_titular` becomes required on `pix` rows too, not just `conta` rows
 * (aperture — pix payouts must also be traceable to the account holder's
 * CPF, matching `DadosRecebedorPixSchema`'s new `cpfTitular` field).
 *
 * Tightens the existing variant CHECK constraints on both `recebedores`
 * (migration 027) and `dados_recebimento_usuario` (migration 028) — the
 * `cpf_titular` column itself already exists (nullable, shared by both
 * variants); no column change needed, only the CHECK.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE recebedores DROP CONSTRAINT recebedores_variante_check
  `.execute(db);
  await sql`
    ALTER TABLE recebedores
    ADD CONSTRAINT recebedores_variante_check CHECK (
      cpf_titular IS NOT NULL
      AND (
        (
          metodo = 'pix'
          AND tipo_chave_pix IS NOT NULL
          AND chave_pix IS NOT NULL
        )
        OR
        (
          metodo = 'conta'
          AND codigo_banco IS NOT NULL
          AND agencia IS NOT NULL
          AND conta IS NOT NULL
          AND conta_digito IS NOT NULL
          AND tipo_conta IS NOT NULL
        )
      )
    )
  `.execute(db);

  await sql`
    ALTER TABLE dados_recebimento_usuario DROP CONSTRAINT dados_recebimento_usuario_variante_check
  `.execute(db);
  await sql`
    ALTER TABLE dados_recebimento_usuario
    ADD CONSTRAINT dados_recebimento_usuario_variante_check CHECK (
      cpf_titular IS NOT NULL
      AND (
        (
          metodo = 'pix'
          AND tipo_chave_pix IS NOT NULL
          AND chave_pix IS NOT NULL
        )
        OR
        (
          metodo = 'conta'
          AND codigo_banco IS NOT NULL
          AND agencia IS NOT NULL
          AND conta IS NOT NULL
          AND conta_digito IS NOT NULL
          AND tipo_conta IS NOT NULL
        )
      )
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE dados_recebimento_usuario DROP CONSTRAINT dados_recebimento_usuario_variante_check
  `.execute(db);
  await sql`
    ALTER TABLE dados_recebimento_usuario
    ADD CONSTRAINT dados_recebimento_usuario_variante_check CHECK (
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

  await sql`
    ALTER TABLE recebedores DROP CONSTRAINT recebedores_variante_check
  `.execute(db);
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
