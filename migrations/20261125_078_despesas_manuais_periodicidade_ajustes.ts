import { type Kysely, sql } from 'kysely';

/**
 * aperture-9nmdo — despesas recorrentes a cada N meses + correção de um mês
 * (aditiva).
 *
 * `intervalo_meses`: mensal cobra no mês do `inicio` e a cada N meses depois
 * (1 = todo mês, padrão das linhas existentes). Única fica sempre 1.
 *
 * `despesas_manuais_ajustes`: corrige o valor de UMA cobrança (`competencia` =
 * data da cobrança) com nota obrigatória. Não reescreve nada: corrigir de novo
 * insere outra linha e a mais recente vale; o valor previsto continua sendo
 * derivado das vigências e exibido ao lado.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE despesas_manuais
      ADD COLUMN intervalo_meses smallint NOT NULL DEFAULT 1,
      ADD CONSTRAINT despesas_manuais_intervalo CHECK (
        intervalo_meses BETWEEN 1 AND 12
        AND (recorrencia = 'mensal' OR intervalo_meses = 1)
      );
    CREATE TABLE despesas_manuais_ajustes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Histórico financeiro: RESTRICT intencional, nunca apagar em cascata.
      despesa_id uuid NOT NULL REFERENCES despesas_manuais(id) ON DELETE RESTRICT,
      competencia date NOT NULL,
      amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
      nota text NOT NULL CHECK (length(btrim(nota)) BETWEEN 1 AND 500),
      -- Ator da sessão admin. Sem FK: auditoria sobrevive à remoção do usuário.
      criado_por uuid NOT NULL,
      -- clock_timestamp: ordem estável entre correções na mesma transação.
      criado_em timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX despesas_manuais_ajustes_despesa
      ON despesas_manuais_ajustes(despesa_id, competencia, criado_em);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE despesas_manuais_ajustes;
    ALTER TABLE despesas_manuais DROP CONSTRAINT despesas_manuais_intervalo,
      DROP COLUMN intervalo_meses;
  `.execute(db);
}
