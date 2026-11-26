import { type Kysely, sql } from 'kysely';

/**
 * aperture-xdylg — endereço fiscal do recebedor (tomador da NFS-e mensal),
 * obrigatório para resgatar a partir de agora (decisão do contador).
 *
 *   - `recebedores.endereco_*`: colunas anuláveis (recebedores antigos não têm
 *     endereço); CHECK garante tudo-ou-nada (complemento é opcional).
 *   - `nfse_emissoes.tomador_endereco`: endereço gravado junto com a nota
 *     (mesma regra das demais notas gravadas: o envio usa o que foi gravado).
 *
 * Só acrescenta; nada existente muda.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE recebedores
      ADD COLUMN endereco_cep text,
      ADD COLUMN endereco_logradouro text,
      ADD COLUMN endereco_numero text,
      ADD COLUMN endereco_complemento text,
      ADD COLUMN endereco_bairro text,
      ADD COLUMN endereco_cidade text,
      ADD COLUMN endereco_uf char(2),
      ADD COLUMN endereco_codigo_municipio_ibge text,
      ADD CONSTRAINT recebedores_endereco_fiscal_completo CHECK (
        (endereco_cep IS NULL AND endereco_logradouro IS NULL AND endereco_numero IS NULL
          AND endereco_complemento IS NULL AND endereco_bairro IS NULL AND endereco_cidade IS NULL
          AND endereco_uf IS NULL AND endereco_codigo_municipio_ibge IS NULL)
        OR
        (endereco_cep IS NOT NULL AND endereco_cep ~ '^[0-9]{8}$'
          AND endereco_logradouro IS NOT NULL AND endereco_numero IS NOT NULL
          AND endereco_bairro IS NOT NULL AND endereco_cidade IS NOT NULL AND endereco_uf IS NOT NULL
          AND endereco_codigo_municipio_ibge IS NOT NULL AND endereco_codigo_municipio_ibge ~ '^[0-9]{7}$')
      )
  `.execute(db);
  await sql`ALTER TABLE nfse_emissoes ADD COLUMN tomador_endereco jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE nfse_emissoes DROP COLUMN tomador_endereco`.execute(db);
  await sql`
    ALTER TABLE recebedores
      DROP CONSTRAINT recebedores_endereco_fiscal_completo,
      DROP COLUMN endereco_cep,
      DROP COLUMN endereco_logradouro,
      DROP COLUMN endereco_numero,
      DROP COLUMN endereco_complemento,
      DROP COLUMN endereco_bairro,
      DROP COLUMN endereco_cidade,
      DROP COLUMN endereco_uf,
      DROP COLUMN endereco_codigo_municipio_ibge
  `.execute(db);
}
