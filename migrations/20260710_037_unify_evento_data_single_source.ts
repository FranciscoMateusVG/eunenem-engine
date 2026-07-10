import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * aperture-mu1v9 (fblrt W3-c, PR1) — `eventos` becomes the SINGLE SOURCE for
 * the event type + event date shown anywhere (painel page, public perfil,
 * convite). `perfil_campanhas.tipo_evento` / `data_evento` become display
 * legacy (columns dropped in PR2).
 *
 * Shape changes — eventos rows may now be PARTIAL (wizard-seeded, no convite
 * saved yet):
 *   - `modalidade` DROP NOT NULL (per spec).
 *   - `tipo_evento` DROP NOT NULL — ⚠️ EXTRA RELAX THE SPEC MISSED, flagged:
 *     reconciliation (b) below must insert an eventos row for a campanha
 *     whose perfil has ONLY `data_evento` set (tipo_evento NULL), and the
 *     wizard's write path (`perfilCampanha.atualizar` → upsertEventoParcial)
 *     accepts tipoEvento null with dataEvento set. Without relaxing, either
 *     insert would violate NOT NULL and the date would be silently lost.
 *     The CHECK constraints (`eventos_tipo_evento_check`,
 *     `eventos_modalidade_check`) still pin the VALUE vocabulary — a CHECK
 *     evaluates to NULL (passes) for NULL, so no constraint swap is needed.
 *   - `data_hora` is ALREADY nullable (20260708_035_eventos_data_hora_nullable)
 *     — deliberately NOT re-altered here.
 *
 * RECONCILIATION (same up, so no window where reads re-source to eventos
 * while perfil-only data exists):
 *   (a) campanha has BOTH an eventos row AND a perfil pair that DIFFERS →
 *       EVENTOS WINS (guest-facing convite data is authoritative; the perfil
 *       copy was display-only). Nothing is written; each drifted row is
 *       logged via RAISE NOTICE for the operator.
 *   (b) campanha has perfil tipo_evento OR data_evento set but NO eventos
 *       row → INSERT a partial evento carrying the perfil pair
 *       (modalidade/endereco NULL).
 *   (c) campanha with neither → untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('eventos')
    .alterColumn('modalidade', (col) => col.dropNotNull())
    .execute();

  await db.schema
    .alterTable('eventos')
    .alterColumn('tipo_evento', (col) => col.dropNotNull())
    .execute();

  // (a) Drift audit — eventos wins, log each divergent pair.
  await sql`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT
          e.id_campanha,
          e.tipo_evento AS evento_tipo,
          e.data_hora   AS evento_data,
          p.tipo_evento AS perfil_tipo,
          p.data_evento AS perfil_data
        FROM eventos e
        JOIN perfil_campanhas p ON p.id_campanha = e.id_campanha
        WHERE (p.tipo_evento IS NOT NULL OR p.data_evento IS NOT NULL)
          AND (
            p.tipo_evento IS DISTINCT FROM e.tipo_evento
            OR p.data_evento IS DISTINCT FROM e.data_hora
          )
      LOOP
        RAISE NOTICE
          'mu1v9 drift (eventos wins): campanha=% eventos(tipo=%, data=%) perfil(tipo=%, data=%)',
          r.id_campanha, r.evento_tipo, r.evento_data, r.perfil_tipo, r.perfil_data;
      END LOOP;
    END
    $$;
  `.execute(db);

  // (b) Perfil-only pairs → seed a PARTIAL eventos row so the re-sourced
  // reads keep showing the same tipo/data. perfil tipo_evento values are
  // CHECK-pinned to the same vocabulary eventos_tipo_evento_check allows
  // (both copied from the original list), so the insert cannot trip it.
  await sql`
    INSERT INTO eventos (
      id, id_campanha, tipo_evento, modalidade, data_hora, endereco,
      criado_em, atualizado_em
    )
    SELECT
      gen_random_uuid(), p.id_campanha, p.tipo_evento, NULL, p.data_evento, NULL,
      now(), now()
    FROM perfil_campanhas p
    LEFT JOIN eventos e ON e.id_campanha = p.id_campanha
    WHERE e.id IS NULL
      AND (p.tipo_evento IS NOT NULL OR p.data_evento IS NOT NULL)
  `.execute(db);
}

/**
 * ⚠️ SHAPE-ONLY / LOSSY down — reversible in theory, same caveat as the 035
 * twin. The partial rows inserted by up() cannot be reliably identified
 * afterwards (a later convite save legitimately fills them in), so they are
 * NOT deleted. Instead the NULLs are coerced to arbitrary defaults
 * ('presencial' / 'cha-bebe') purely so SET NOT NULL succeeds: running this
 * down after partial rows exist FABRICATES modalidade/tipo values.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE eventos SET modalidade = 'presencial' WHERE modalidade IS NULL`.execute(db);
  await sql`UPDATE eventos SET tipo_evento = 'cha-bebe' WHERE tipo_evento IS NULL`.execute(db);

  await db.schema
    .alterTable('eventos')
    .alterColumn('modalidade', (col) => col.setNotNull())
    .execute();

  await db.schema
    .alterTable('eventos')
    .alterColumn('tipo_evento', (col) => col.setNotNull())
    .execute();
}
