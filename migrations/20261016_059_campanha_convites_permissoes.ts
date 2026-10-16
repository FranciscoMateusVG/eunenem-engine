import { type Kysely, sql } from 'kysely';

/**
 * Permissões escolhidas pelo owner no convite (aperture-m3vx4).
 *
 * Ao aceitar um convite verificado, o membro recebe EXATAMENTE este conjunto
 * (em vez de PERMISSOES_PADRAO_MEMBRO fixo). Mesmo CHECK da tabela
 * `campanha_membros_permissoes`: só ações concedíveis; `membros:gerenciar`
 * nunca pode ser concedida.
 *
 * BACKFILL — todo convite existente (pendente ou não) recebe
 * PERMISSOES_PADRAO_MEMBRO (lista literal abaixo, congelada nesta migration):
 * foi a regra sob a qual esses convites foram enviados, então aceitar um
 * convite antigo concede o mesmo de sempre. Depois do backfill a coluna fica
 * SEM default: todo insert precisa dizer as permissões.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE campanha_convites
      ADD COLUMN permissoes text[] NOT NULL DEFAULT ARRAY[
        'presentes:gerenciar', 'perfil:editar', 'mensagens:ver', 'mensagens:gerenciar',
        'convidados:ver', 'convite:editar'
      ]::text[],
      ADD CONSTRAINT campanha_convites_permissoes_check CHECK (permissoes <@ ARRAY[
        'presentes:gerenciar', 'perfil:editar', 'mensagens:ver', 'mensagens:gerenciar',
        'convidados:ver', 'convite:editar', 'link:editar', 'extrato:ver',
        'recebedor:gerenciar', 'saque:solicitar'
      ]::text[]);
    ALTER TABLE campanha_convites ALTER COLUMN permissoes DROP DEFAULT;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE campanha_convites DROP COLUMN permissoes`.execute(db);
}
