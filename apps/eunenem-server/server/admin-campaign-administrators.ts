import { sql } from "kysely";
import type { Database } from "../../../src/adapters/database.js";

/**
 * Admin read model — administradores reais de campanhas (aperture-9bpre).
 *
 * Fonte: `campanha_administradores` (PK campanha_id + id_usuario, sem papel;
 * `id_usuario` guarda `usuarios.id_conta`) com LEFT JOIN em `usuarios` na
 * plataforma. Administrador NÃO é pagador nem titular bancário.
 *
 * Duas garantias do contrato:
 *   - EXIBIÇÃO LIMITADA, ELEGIBILIDADE NA TOTALIDADE: `publicOwnerSlug` é
 *     escolhido sobre TODOS os administradores da campanha (primeiro por
 *     id_conta que tenha linha em `usuarios` na plataforma), nunca sobre a
 *     lista truncada.
 *   - SEM N+1: uma consulta por lote de campanhas.
 *
 * Aceita `Database` ou uma transação (que é um `Database`), para que o
 * dashboard de receita leia os administradores no MESMO snapshot.
 */

export const ADMINISTRADORES_EXIBIDOS = 5;

export interface CampaignAdministrator {
  readonly idConta: string;
  readonly displayName: string | null;
  readonly email: string | null;
  /** False quando não há linha em `usuarios` na plataforma para esta conta. */
  readonly hasUserRow: boolean;
}

export interface CampaignAdministrators {
  readonly rows: readonly CampaignAdministrator[];
  /** Total real de administradores da campanha, independente de `rows`. */
  readonly total: number;
  readonly publicOwnerSlug: string | null;
}

export const NO_CAMPAIGN_ADMINISTRATORS: CampaignAdministrators = {
  rows: [],
  total: 0,
  publicOwnerSlug: null,
};

interface AdministratorDbRow {
  campanha_id: string;
  id_conta: string;
  nome_exibicao: string | null;
  email: string | null;
  has_user_row: boolean;
  total: string | number;
  public_owner_slug: string | null;
}

function countFromDb(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("invalid_campaign_administrators_count");
  }
  return parsed;
}

/**
 * Administradores de um lote de campanhas da plataforma.
 *
 * `perCampaignLimit` limita apenas as linhas devolvidas por campanha; `total`
 * e `publicOwnerSlug` são sempre calculados sobre a campanha inteira. `null`
 * devolve a lista completa.
 */
export async function loadCampaignAdministrators(
  db: Database,
  input: {
    readonly platformId: string;
    readonly campaignIds: readonly string[];
    readonly perCampaignLimit: number | null;
  },
): Promise<Map<string, CampaignAdministrators>> {
  const out = new Map<string, CampaignAdministrators>();
  const campaignIds = [...new Set(input.campaignIds)];
  if (campaignIds.length === 0) return out;

  const limit = input.perCampaignLimit;
  const result = await sql<AdministratorDbRow>`
    WITH admins AS (
      SELECT
        ca.campanha_id,
        ca.id_usuario AS id_conta,
        u.nome_exibicao,
        u.email,
        u.slug,
        (u.id IS NOT NULL) AS has_user_row,
        ROW_NUMBER() OVER (
          PARTITION BY ca.campanha_id ORDER BY ca.id_usuario
        ) AS posicao,
        COUNT(*) OVER (PARTITION BY ca.campanha_id) AS total
      FROM campanha_administradores ca
      INNER JOIN campanhas c
        ON c.id = ca.campanha_id
       AND c.id_plataforma = ${input.platformId}
      LEFT JOIN usuarios u
        ON u.id_conta = ca.id_usuario
       AND u.id_plataforma = ${input.platformId}
      WHERE ca.campanha_id = ANY(${campaignIds}::uuid[])
    ),
    elegivel AS (
      SELECT DISTINCT ON (campanha_id) campanha_id, slug
      FROM admins
      WHERE has_user_row
      ORDER BY campanha_id, id_conta
    )
    SELECT
      a.campanha_id,
      a.id_conta,
      a.nome_exibicao,
      a.email,
      a.has_user_row,
      a.total,
      e.slug AS public_owner_slug
    FROM admins a
    LEFT JOIN elegivel e ON e.campanha_id = a.campanha_id
    WHERE ${limit}::int IS NULL OR a.posicao <= ${limit}::int
    ORDER BY a.campanha_id, a.posicao
  `.execute(db);

  const grouped = new Map<
    string,
    { rows: CampaignAdministrator[]; total: number; publicOwnerSlug: string | null }
  >();
  for (const row of result.rows) {
    const entry = grouped.get(row.campanha_id) ?? {
      rows: [],
      total: countFromDb(row.total),
      publicOwnerSlug: row.public_owner_slug,
    };
    entry.rows.push({
      idConta: row.id_conta,
      displayName: row.has_user_row ? row.nome_exibicao : null,
      email: row.has_user_row ? row.email : null,
      hasUserRow: row.has_user_row === true,
    });
    grouped.set(row.campanha_id, entry);
  }
  for (const [campaignId, entry] of grouped) out.set(campaignId, entry);
  return out;
}
