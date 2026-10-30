import { sql } from 'kysely';
import type { Database } from '../../../src/adapters/database.js';
import { agregarEstatisticas, type DiaUsuarios } from '../pages/lib/estatisticas.js';

/** jbd25: current active 2.0 profiles, not historical acquisition. One SQL snapshot. */
export async function loadEstatisticas(db: Database, platformId: string, now: Date) {
  const {rows}=await sql<DiaUsuarios>`WITH usuarios_filtrados AS (
    SELECT criado_em, (
      lower(trim(email))='franciscomateusvg@gmail.com'
      OR lower(trim(email)) LIKE 'franciscomateusvg+%@%'
      OR lower(email) LIKE '%aperture%'
      OR lower(email) ~ ${'@(example\\.(com|org|net)|.*\\.test|.*\\.local)$'}
      OR lower(nome_exibicao) ~ '(aperture|fixture|sint.tic)'
    ) AS interno FROM usuarios
    WHERE id_plataforma=${platformId}::uuid AND desativado_em IS NULL AND criado_em<${now}
  ) SELECT to_char(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia,
    (count(*) FILTER(WHERE NOT interno))::int AS novos,
    (count(*) FILTER(WHERE interno))::int AS excluidos
    FROM usuarios_filtrados GROUP BY 1 ORDER BY 1`.execute(db);
  return agregarEstatisticas(rows,now);
}
