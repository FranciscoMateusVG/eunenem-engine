import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../../../src/adapters/database.js";

const SAFE_QUERY = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]*$/u;
const OWNER_SLUG = /^[a-z][a-z0-9-]{2,29}$/;
const CAMPAIGN_SLUG = /^[a-z][a-z0-9-]{2,59}$/;

export const AdminUserQuerySchema = z.string().max(160).regex(SAFE_QUERY);
export const AdminCampaignQuerySchema = z.string().max(1024).regex(SAFE_QUERY);

export type AdminUserSortBy = "criadoEm" | "email" | "nomeExibicao";
export type AdminUserSortDir = "asc" | "desc";

export interface AdminUserRow {
  readonly id: string;
  readonly idConta: string;
  readonly email: string;
  readonly nomeExibicao: string;
  readonly slug: string;
  readonly criadoEm: string;
}

export interface AdminUserMatch {
  readonly idConta: string;
  readonly email: string;
  readonly nomeExibicao: string;
}

export interface CampaignFilterText {
  readonly kind: "text";
  readonly pattern: string;
}

export interface CampaignFilterSlug {
  readonly kind: "slug";
  readonly ownerSlug: string;
  readonly campaignSlug: string;
}

export interface CampaignFilterId {
  readonly kind: "id";
  readonly ownerSlug: string;
  readonly campaignId: string;
}

export type CampaignFilter = CampaignFilterText | CampaignFilterSlug | CampaignFilterId;

export class InvalidAdminSearchFilterError extends Error {
  constructor() {
    super("invalid_admin_search_filter");
    this.name = "InvalidAdminSearchFilterError";
  }
}

export class InvalidAdminUserCursorError extends Error {
  constructor() {
    super("invalid_admin_user_cursor");
    this.name = "InvalidAdminUserCursorError";
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function canonicalQuery(value: string | undefined, maxLength: number): string | null {
  const cleaned = value?.trim() ?? "";
  if (cleaned.length > maxLength || !SAFE_QUERY.test(cleaned)) {
    throw new InvalidAdminSearchFilterError();
  }
  return cleaned.length === 0 ? null : cleaned;
}

function canonicalSlug(value: string, pattern: RegExp): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new InvalidAdminSearchFilterError();
  }
  if (decoded !== value || !pattern.test(decoded)) {
    throw new InvalidAdminSearchFilterError();
  }
  return decoded;
}

export function parseAdminCampaignQuery(
  raw: string | undefined,
  publicOrigin: string,
): CampaignFilter | null {
  const cleaned = canonicalQuery(raw, 1024);
  if (cleaned === null) return null;

  let parsed: URL | null = null;
  try {
    parsed = new URL(cleaned);
  } catch {
    parsed = null;
  }

  if (parsed === null) {
    return { kind: "text", pattern: `%${escapeLike(cleaned)}%` };
  }

  let allowedOrigin: URL;
  try {
    allowedOrigin = new URL(publicOrigin);
  } catch {
    throw new InvalidAdminSearchFilterError();
  }
  if (
    parsed.origin !== allowedOrigin.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new InvalidAdminSearchFilterError();
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 3 && segments[0] === "pagina") {
    return {
      kind: "slug",
      ownerSlug: canonicalSlug(segments[1] ?? "", OWNER_SLUG),
      campaignSlug: canonicalSlug(segments[2] ?? "", CAMPAIGN_SLUG),
    };
  }
  if (
    segments.length === 4 &&
    segments[0] === "pagina" &&
    segments[2] === "c" &&
    z.string().uuid().safeParse(segments[3]).success
  ) {
    return {
      kind: "id",
      ownerSlug: canonicalSlug(segments[1] ?? "", OWNER_SLUG),
      campaignId: segments[3] as string,
    };
  }
  throw new InvalidAdminSearchFilterError();
}

function campaignExistsPredicate(
  platformId: string,
  filter: CampaignFilter,
): ReturnType<typeof sql<boolean>> {
  if (filter.kind === "text") {
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM campanha_administradores ca
      INNER JOIN campanhas c ON c.id = ca.campanha_id
      WHERE ca.id_usuario = u.id_conta
        AND c.id_plataforma = ${platformId}
        AND (
          c.titulo ILIKE ${filter.pattern} ESCAPE '\\'
          OR c.slug ILIKE ${filter.pattern} ESCAPE '\\'
        )
    )`;
  }
  if (filter.kind === "slug") {
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM campanha_administradores ca
      INNER JOIN campanhas c ON c.id = ca.campanha_id
      WHERE ca.id_usuario = u.id_conta
        AND c.id_plataforma = ${platformId}
        AND u.slug = ${filter.ownerSlug}
        AND c.slug = ${filter.campaignSlug}
    )`;
  }
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM campanha_administradores ca
    INNER JOIN campanhas c ON c.id = ca.campanha_id
    WHERE ca.id_usuario = u.id_conta
      AND c.id_plataforma = ${platformId}
      AND u.slug = ${filter.ownerSlug}
      AND c.id = ${filter.campaignId}::uuid
  )`;
}

function filtersDigest(secret: string, value: object): string {
  return createHmac("sha256", secret)
    .update("admin-user-search-cursor:v2\0")
    .update(JSON.stringify(value))
    .digest("base64url");
}

const AdminUserCursorSchema = z
  .object({
    version: z.literal(2),
    sortValue: z.string().max(320),
    id: z.string().uuid(),
    filtersDigest: z.string().length(43),
  })
  .strict();

function decodeCursor(encoded: string, expectedDigest: string) {
  try {
    if (encoded.length < 1 || encoded.length > 1024) throw new InvalidAdminUserCursorError();
    const cursor = AdminUserCursorSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (cursor.filtersDigest !== expectedDigest) throw new InvalidAdminUserCursorError();
    return cursor;
  } catch (error: unknown) {
    if (error instanceof InvalidAdminUserCursorError) throw error;
    throw new InvalidAdminUserCursorError();
  }
}

function encodeCursor(cursor: z.infer<typeof AdminUserCursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

interface UserDbRow {
  id: string;
  id_conta: string;
  email: string;
  nome_exibicao: string;
  slug: string;
  criado_em: Date;
}

export async function searchAdminUsers(
  db: Database,
  input: {
    readonly platformId: string;
    readonly query: string;
    readonly publicOrigin: string;
    readonly limit: number;
  },
): Promise<AdminUserMatch[]> {
  const query = canonicalQuery(input.query, 160);
  if (query === null) return [];
  const campaignFilter = parseAdminCampaignQuery(query, input.publicOrigin);
  const textPattern = campaignFilter?.kind === "text" ? campaignFilter.pattern : null;
  const campaignPredicate = campaignFilter
    ? campaignExistsPredicate(input.platformId, campaignFilter)
    : sql<boolean>`FALSE`;
  const rows = await sql<UserDbRow>`
    SELECT DISTINCT u.id, u.id_conta, u.email, u.nome_exibicao, u.slug, u.criado_em
    FROM usuarios u
    WHERE u.id_plataforma = ${input.platformId}
      AND (
        (${textPattern}::text IS NOT NULL AND (
          u.email ILIKE ${textPattern} ESCAPE '\\'
          OR u.nome_exibicao ILIKE ${textPattern} ESCAPE '\\'
        ))
        OR ${campaignPredicate}
      )
    ORDER BY u.email ASC, u.id ASC
    LIMIT ${Math.max(1, Math.min(50, Math.floor(input.limit)))}
  `.execute(db);
  return rows.rows.map((row) => ({
    idConta: row.id_conta,
    email: row.email,
    nomeExibicao: row.nome_exibicao,
  }));
}

export async function listAdminUsers(
  db: Database,
  input: {
    readonly platformId: string;
    readonly cursor: string | null;
    readonly limit: number;
    readonly sortBy: AdminUserSortBy;
    readonly sortDir: AdminUserSortDir;
    readonly emailPrefix?: string;
    readonly campaignQuery?: string;
    readonly publicOrigin: string;
    readonly cursorSecret: string;
  },
): Promise<{ readonly usuarios: AdminUserRow[]; readonly nextCursor: string | null; readonly totalCount: number }> {
  const emailPrefix = canonicalQuery(input.emailPrefix, 120);
  const emailPattern = emailPrefix === null ? null : `${escapeLike(emailPrefix)}%`;
  const campaignFilter = parseAdminCampaignQuery(input.campaignQuery, input.publicOrigin);
  const digest = filtersDigest(input.cursorSecret, {
    sortBy: input.sortBy,
    sortDir: input.sortDir,
    emailPrefix,
    campaignFilter,
  });
  const cursor = input.cursor === null ? null : decodeCursor(input.cursor, digest);
  const campaignPredicate = campaignFilter
    ? campaignExistsPredicate(input.platformId, campaignFilter)
    : sql<boolean>`TRUE`;
  const sortColumn =
    input.sortBy === "criadoEm"
      ? "u.criado_em"
      : input.sortBy === "email"
        ? "u.email"
        : "u.nome_exibicao";
  const sortReference = sql.ref(sortColumn);
  const cursorPredicate =
    cursor === null
      ? sql<boolean>`TRUE`
      : input.sortBy === "criadoEm"
        ? input.sortDir === "asc"
          ? sql<boolean>`(${sortReference}, u.id) > (${cursor.sortValue}::timestamptz, ${cursor.id}::uuid)`
          : sql<boolean>`(${sortReference}, u.id) < (${cursor.sortValue}::timestamptz, ${cursor.id}::uuid)`
        : input.sortDir === "asc"
          ? sql<boolean>`(${sortReference}, u.id) > (${cursor.sortValue}::text, ${cursor.id}::uuid)`
          : sql<boolean>`(${sortReference}, u.id) < (${cursor.sortValue}::text, ${cursor.id}::uuid)`;
  const orderDirection = input.sortDir === "asc" ? sql`ASC` : sql`DESC`;
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));

  const rowsResult = await sql<UserDbRow>`
    SELECT u.id, u.id_conta, u.email, u.nome_exibicao, u.slug, u.criado_em
    FROM usuarios u
    WHERE u.id_plataforma = ${input.platformId}
      AND (${emailPattern}::text IS NULL OR u.email ILIKE ${emailPattern} ESCAPE '\\')
      AND ${campaignPredicate}
      AND ${cursorPredicate}
    ORDER BY ${sortReference} ${orderDirection}, u.id ${orderDirection}
    LIMIT ${limit + 1}
  `.execute(db);
  const countResult = await sql<{ total_count: string | number }>`
    SELECT COUNT(DISTINCT u.id) AS total_count
    FROM usuarios u
    WHERE u.id_plataforma = ${input.platformId}
      AND (${emailPattern}::text IS NULL OR u.email ILIKE ${emailPattern} ESCAPE '\\')
      AND ${campaignPredicate}
  `.execute(db);

  const hasNext = rowsResult.rows.length > limit;
  const visible = rowsResult.rows.slice(0, limit);
  const usuarios = visible.map((row) => ({
    id: row.id,
    idConta: row.id_conta,
    email: row.email,
    nomeExibicao: row.nome_exibicao,
    slug: row.slug,
    criadoEm: row.criado_em.toISOString(),
  }));
  const last = hasNext ? visible.at(-1) : undefined;
  const sortValue = last
    ? input.sortBy === "criadoEm"
      ? last.criado_em.toISOString()
      : input.sortBy === "email"
        ? last.email
        : last.nome_exibicao
    : null;
  const nextCursor =
    last && sortValue !== null
      ? encodeCursor({ version: 2, sortValue, id: last.id, filtersDigest: digest })
      : null;
  const totalCount = Number(countResult.rows[0]?.total_count ?? 0);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw new Error("invalid_admin_user_count");
  return { usuarios, nextCursor, totalCount };
}
