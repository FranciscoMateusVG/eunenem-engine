import { type Kysely, sql } from 'kysely';

/**
 * Papéis + permissões por membro de campanha compartilhada (aperture-1z18g).
 *
 * Tabela IRMÃ de `campanha_administradores` (não colunas nela): o `save` do
 * agregado Campanha historicamente apaga e reinsere as linhas de
 * administradores, o que apagaria papel/permissões a cada gravação. Uma linha
 * aqui só confere direitos se a conta TAMBÉM estiver em
 * `campanha_administradores` (checado pelo helper de autorização). Sem FK para
 * `campanha_administradores` pelo mesmo motivo; a remoção explícita de membro
 * apaga as duas linhas na mesma transação.
 *
 * `papel`:
 *   - 'owner'  → todas as permissões, inclusive gerenciar membros.
 *   - 'membro' → só as ações listadas em `permissoes` (padrão: nenhuma).
 *
 * BACKFILL — owner = criador da campanha. Evidência procurada: `campanhas` não
 * tem coluna de criador e `campanha_administradores` não tem timestamp nem
 * ordem de inserção; nenhuma outra tabela registra quem criou a campanha. Como
 * o criador NÃO está registrado, TODO administrador atual vira owner (regra do
 * operador: ninguém perde direitos). Até aqui toda campanha era criada com um
 * único administrador (o criador) e não havia rota de produto para adicionar
 * administradores, então na prática owner = criador.
 *
 * Campanhas NOVAS: o `save` do agregado grava o(s) criador(es) como owner ao
 * inserir uma campanha nova; o fluxo de convite grava 'membro' explicitamente.
 * Administrador sem linha aqui = sem direitos (fail-closed). Sem trigger de
 * propósito: um convite aceito numa campanha sem papéis nunca pode virar owner.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('campanha_membros_permissoes')
    .addColumn('campanha_id', 'uuid', (col) =>
      col.notNull().references('campanhas.id').onDelete('cascade'),
    )
    .addColumn('id_conta', 'uuid', (col) => col.notNull())
    .addColumn('papel', 'varchar(10)', (col) => col.notNull())
    .addColumn('permissoes', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('campanha_membros_permissoes_pkey', ['campanha_id', 'id_conta'])
    .addCheckConstraint(
      'campanha_membros_permissoes_papel_check',
      sql`papel IN ('owner', 'membro')`,
    )
    .addCheckConstraint(
      'campanha_membros_permissoes_permissoes_check',
      sql`permissoes <@ ARRAY['recebedor:gerenciar', 'saque:solicitar', 'presentes:gerenciar']::text[]`,
    )
    .execute();

  await sql`
    INSERT INTO campanha_membros_permissoes (campanha_id, id_conta, papel)
    SELECT ca.campanha_id, ca.id_usuario, 'owner'
    FROM campanha_administradores ca
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('campanha_membros_permissoes').execute();
}
