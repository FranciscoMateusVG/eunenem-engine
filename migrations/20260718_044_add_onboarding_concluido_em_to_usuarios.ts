import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * aperture-lrl1h — onboarding-completed latch on usuarios.
 *
 * The post-login onboarding gate (auth.me.needsOnboarding) is derived from
 * whether the user has any NAMED campanha (a campanha whose perfil has a
 * non-empty nomeBebe). That alone fixes the "oldest campanha empty but newer
 * lists named" false-wizard bug. But nomeBebe is an editable profile field, so
 * clearing it on a single-campanha user would re-fire the wizard.
 *
 * This column is the latch that decouples "has this user ever onboarded" from
 * the editable field. auth.me sets it lazily (first-write-wins) the first time
 * it observes a named campanha for the user; once set, clearing nomeBebe can no
 * longer un-onboard them. No backfill needed — existing onboarded users read as
 * not-needing-onboarding via the named-campanha derivation, and the latch fills
 * in on their next auth.me. Mirrors tutorial_completado_em (migration 024).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE usuarios
      ADD COLUMN onboarding_concluido_em TIMESTAMPTZ NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE usuarios
      DROP COLUMN onboarding_concluido_em
  `.execute(db);
}
