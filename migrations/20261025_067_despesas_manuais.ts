import { type Kysely, sql } from 'kysely';

/**
 * aperture-0ngn4 — despesas recorrentes/manuais (aditiva).
 *
 * Mensal: cai no `dia_cobranca` (1–28) de cada mês, de `inicio` a `fim`
 * (inclusivo, opcional). Única: cai em `data`. Datas são locais de SP.
 * O valor é versionado em `despesas_manuais_valores`: cada linha vale a
 * partir de `vigente_desde`; mudar o valor insere linha nova e não reescreve
 * ocorrências anteriores.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE despesas_manuais (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_plataforma uuid NOT NULL,
      nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 120),
      categoria text CHECK (categoria IS NULL OR length(btrim(categoria)) BETWEEN 1 AND 60),
      recorrencia text NOT NULL CHECK (recorrencia IN ('mensal','unica')),
      dia_cobranca smallint,
      inicio date,
      fim date,
      data date,
      criado_em timestamptz NOT NULL DEFAULT now(),
      encerrado_em timestamptz,
      CONSTRAINT despesas_manuais_forma CHECK (
        (recorrencia = 'mensal'
          AND dia_cobranca BETWEEN 1 AND 28
          AND inicio IS NOT NULL
          AND (fim IS NULL OR fim >= inicio)
          AND data IS NULL)
        OR
        (recorrencia = 'unica'
          AND data IS NOT NULL
          AND dia_cobranca IS NULL
          AND inicio IS NULL
          AND fim IS NULL)
      )
    );
    CREATE INDEX despesas_manuais_plataforma ON despesas_manuais(id_plataforma);
    CREATE TABLE despesas_manuais_valores (
      -- Histórico financeiro: RESTRICT intencional, nunca apagar em cascata.
      despesa_id uuid NOT NULL REFERENCES despesas_manuais(id) ON DELETE RESTRICT,
      vigente_desde date NOT NULL,
      amount_cents bigint NOT NULL CHECK (amount_cents > 0),
      criado_em timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (despesa_id, vigente_desde)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE despesas_manuais_valores; DROP TABLE despesas_manuais;`.execute(db);
}
