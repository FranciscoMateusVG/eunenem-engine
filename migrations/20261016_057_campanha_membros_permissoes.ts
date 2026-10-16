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
 * TRIGGER — campanhas novas: o PRIMEIRO administrador inserido numa campanha
 * que ainda não tem nenhuma linha de papel vira owner. Vale para qualquer
 * caminho de criação (signup saga, campanhas.criar) sem depender da ordem de
 * merge do código. Administradores adicionados depois NÃO ganham linha
 * automática: o fluxo de convite insere 'membro' explicitamente; sem linha =
 * sem direitos (fail-closed).
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

  await sql`
    CREATE FUNCTION campanha_membros_permissoes_owner_inicial() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO campanha_membros_permissoes (campanha_id, id_conta, papel)
      SELECT NEW.campanha_id, NEW.id_usuario, 'owner'
      WHERE NOT EXISTS (
        SELECT 1 FROM campanha_membros_permissoes p WHERE p.campanha_id = NEW.campanha_id
      )
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END;
    $$
  `.execute(db);

  await sql`
    CREATE TRIGGER campanha_administradores_owner_inicial
    AFTER INSERT ON campanha_administradores
    FOR EACH ROW EXECUTE FUNCTION campanha_membros_permissoes_owner_inicial()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS campanha_administradores_owner_inicial ON campanha_administradores`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS campanha_membros_permissoes_owner_inicial()`.execute(db);
  await db.schema.dropTable('campanha_membros_permissoes').execute();
}
