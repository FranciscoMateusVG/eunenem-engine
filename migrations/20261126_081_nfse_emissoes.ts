import { type Kysely, sql } from 'kysely';

/**
 * aperture-wp6j6 — emissão real da NFS-e mensal (Sistema Nacional).
 *
 *   - `nfse_numeracao`: próximo nDPS por (ambiente, série). Homologação e
 *     produção têm sequências separadas; o número é reservado ANTES do envio
 *     e nunca reaproveitado para outra nota.
 *   - `nfse_emissoes`: uma linha por (ambiente, competência, CPF do tomador).
 *     A unicidade é a idempotência: a mesma nota nunca é emitida duas vezes.
 *     Todas as notas da competência são gravadas juntas antes do primeiro
 *     envio (valor + campanhas de origem): é a competência FIXADA, contra a
 *     qual qualquer recálculo posterior é conferido.
 *     Guarda o XML assinado enviado e o XML da NFS-e devolvido.
 *
 * Só acrescenta tabelas; nada existente muda.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE nfse_numeracao (
      ambiente char(1) NOT NULL CHECK (ambiente IN ('1', '2')),
      serie text NOT NULL,
      proximo bigint NOT NULL CHECK (proximo > 0),
      PRIMARY KEY (ambiente, serie)
    )
  `.execute(db);
  await sql`
    CREATE TABLE nfse_emissoes (
      id uuid PRIMARY KEY,
      ambiente char(1) NOT NULL CHECK (ambiente IN ('1', '2')),
      competencia text NOT NULL CHECK (competencia ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
      tomador_cpf text NOT NULL CHECK (tomador_cpf ~ '^[0-9]{11}$'),
      tomador_nome text NOT NULL,
      valor_cents bigint NOT NULL CHECK (valor_cents > 0),
      campanhas uuid[] NOT NULL CHECK (cardinality(campanhas) > 0),
      serie text NOT NULL,
      n_dps bigint NOT NULL,
      id_dps text NOT NULL,
      status text NOT NULL CHECK (status IN ('pendente', 'enviando', 'incerta', 'rejeitada', 'autorizada', 'cancelada')),
      tentativas integer NOT NULL DEFAULT 0,
      dps_xml_assinado text,
      chave_acesso text CHECK (chave_acesso ~ '^[0-9]{50}$'),
      numero_nfse text,
      nfse_xml text,
      erros jsonb,
      cancelamento_status text CHECK (cancelamento_status IN ('incerto', 'rejeitado')),
      cancelamento_motivo char(1) CHECK (cancelamento_motivo IN ('1', '2', '9')),
      cancelamento_texto text,
      cancelamento_evento_xml text,
      solicitada_por uuid NOT NULL,
      cancelada_por uuid,
      criada_em timestamptz NOT NULL,
      atualizada_em timestamptz NOT NULL,
      enviada_em timestamptz,
      autorizada_em timestamptz,
      cancelada_em timestamptz,
      UNIQUE (ambiente, competencia, tomador_cpf),
      UNIQUE (ambiente, serie, n_dps),
      UNIQUE (ambiente, id_dps),
      UNIQUE (ambiente, chave_acesso)
    )
  `.execute(db);
  await sql`CREATE INDEX nfse_emissoes_competencia_idx ON nfse_emissoes (ambiente, competencia)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE nfse_emissoes`.execute(db);
  await sql`DROP TABLE nfse_numeracao`.execute(db);
}
