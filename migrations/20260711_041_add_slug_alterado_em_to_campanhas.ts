import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Limita a troca do slug PRÓPRIO da campanha (aperture-aphk8, `campanhas.slug`)
 * a uma única vez quando feita pelo PerfilBody (painel do criador).
 *
 * `slug_alterado_em` codifica "já usou a troca?" + "quando":
 *   - NULL      → a campanha ainda não trocou seu slug pelo PerfilBody.
 *   - non-NULL  → já usou a única troca; `campanhas.definirSlug` com
 *                 `origem: 'perfil'` rejeita novas tentativas.
 *
 * Distinção importante (ver campanhas-router.ts `definirSlug`): o modal de
 * SETUP inicial da campanha (`SetupCampanhaWizard`) também chama
 * `definirSlug`, mas com `origem: 'setup'` — essas chamadas NUNCA leem nem
 * gravam esta coluna, só a troca feita pelo painel de perfil consome a
 * única alteração permitida.
 *
 * Default NULL — toda campanha existente pode trocar seu slug uma vez
 * pelo perfil, mesmo que já tenha um slug definido via setup.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE campanhas
      ADD COLUMN slug_alterado_em TIMESTAMPTZ NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE campanhas
      DROP COLUMN slug_alterado_em
  `.execute(db);
}
