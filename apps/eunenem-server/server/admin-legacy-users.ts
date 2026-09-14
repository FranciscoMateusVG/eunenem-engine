import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../../../src/adapters/database.js";
import type { LegacyUserEntry } from "../lib/legacy-users.js";

const SAFE_QUERY = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]*$/u;
const CURSOR_DOMAIN = "admin-legacy-users-cursor:v1\0";

export const AdminLegacyUserQuerySchema = z.string().max(120).regex(SAFE_QUERY);

export const AdminLegacyUserStatusSchema = z.enum([
  "somente_legado",
  "conta_2_0",
  "perfil_2_0",
  "evidencia_inconsistente",
]);
export type AdminLegacyUserStatus = z.infer<typeof AdminLegacyUserStatusSchema>;

export interface AdminLegacyUserItem {
  readonly email: string;
  readonly nomeExibicao: string | null;
  readonly idConta: string | null;
  readonly legacyCampaignCount: number;
  readonly status: AdminLegacyUserStatus;
  readonly evidencedAt: string | null;
}

export interface AdminLegacyUserCounts {
  readonly somente_legado: number;
  readonly conta_2_0: number;
  readonly perfil_2_0: number;
  readonly evidencia_inconsistente: number;
}

export interface AdminLegacyUsersPage {
  readonly items: AdminLegacyUserItem[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly counts: AdminLegacyUserCounts;
}

export class InvalidAdminLegacyUserQueryError extends Error {
  constructor() {
    super("invalid_admin_legacy_user_query");
    this.name = "InvalidAdminLegacyUserQueryError";
  }
}

export class InvalidAdminLegacyUserCursorError extends Error {
  constructor() {
    super("invalid_admin_legacy_user_cursor");
    this.name = "InvalidAdminLegacyUserCursorError";
  }
}

interface LegacyMembership {
  readonly email: string;
  readonly legacyCampaignCount: number;
}

const AuthEvidenceSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
  })
  .strict();

const DomainEvidenceSchema = z
  .object({
    id: z.string(),
    idConta: z.string(),
    nomeExibicao: z.string(),
    contaId: z.string().nullable(),
    contaIdUsuario: z.string().nullable(),
    contaCriadaEm: z.string().nullable(),
  })
  .strict();

const EvidenceRowSchema = z
  .object({
    email: z.string().min(1).max(320),
    legacy_campaign_count: z.number().int().positive(),
    auth_records: z.array(AuthEvidenceSchema),
    domain_records: z.array(DomainEvidenceSchema),
  })
  .strict();
type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

const CursorSchema = z
  .object({
    version: z.literal(1),
    query: z.string().max(120).nullable(),
    afterEmail: z.string().min(1).max(320),
    signature: z.string().length(43),
  })
  .strict();
type Cursor = z.infer<typeof CursorSchema>;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeQuery(query: string | undefined): string | null {
  const cleaned = query?.trim().toLowerCase() ?? "";
  if (cleaned.length > 120 || !SAFE_QUERY.test(cleaned)) {
    throw new InvalidAdminLegacyUserQueryError();
  }
  return cleaned.length === 0 ? null : cleaned;
}

function legacyMemberships(entries: readonly LegacyUserEntry[]): LegacyMembership[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const email = normalizeEmail(entry.email);
    if (email.length === 0 || email.length > 320) {
      throw new Error("invalid_admin_legacy_snapshot_email");
    }
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([email, legacyCampaignCount]) => ({ email, legacyCampaignCount }));
}

function asIso(timestamp: string): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) throw new Error("invalid_admin_legacy_evidence_time");
  return new Date(millis).toISOString();
}

function safePersonName(value: string): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 120 &&
    SAFE_QUERY.test(value)
  );
}

export function classifyAdminLegacyEvidence(row: EvidenceRow): AdminLegacyUserItem {
  const auth = row.auth_records;
  const domain = row.domain_records;

  if (auth.length === 0 && domain.length === 0) {
    return {
      email: row.email,
      nomeExibicao: null,
      idConta: null,
      legacyCampaignCount: row.legacy_campaign_count,
      status: "somente_legado",
      evidencedAt: null,
    };
  }

  if (auth.length === 1 && domain.length === 0) {
    return {
      email: row.email,
      nomeExibicao: null,
      idConta: null,
      legacyCampaignCount: row.legacy_campaign_count,
      status: "conta_2_0",
      evidencedAt: asIso(auth[0]!.createdAt),
    };
  }

  if (auth.length === 1 && domain.length === 1) {
    const authRow = auth[0]!;
    const domainRow = domain[0]!;
    if (
      authRow.id === domainRow.id &&
      domainRow.contaId !== null &&
      domainRow.contaIdUsuario === domainRow.id &&
      domainRow.idConta === domainRow.contaId &&
      domainRow.contaCriadaEm !== null &&
      safePersonName(domainRow.nomeExibicao)
    ) {
      return {
        email: row.email,
        nomeExibicao: domainRow.nomeExibicao,
        idConta: domainRow.idConta,
        legacyCampaignCount: row.legacy_campaign_count,
        status: "perfil_2_0",
        evidencedAt: asIso(domainRow.contaCriadaEm),
      };
    }
  }

  return {
    email: row.email,
    nomeExibicao: null,
    idConta: null,
    legacyCampaignCount: row.legacy_campaign_count,
    status: "evidencia_inconsistente",
    evidencedAt: null,
  };
}

function cursorSignature(
  secret: string,
  value: Pick<Cursor, "query" | "afterEmail">,
): string {
  return createHmac("sha256", secret)
    .update(CURSOR_DOMAIN)
    .update(JSON.stringify([value.query, value.afterEmail]))
    .digest("base64url");
}

function signaturesEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeCursor(secret: string, query: string | null, afterEmail: string): string {
  const unsigned = { query, afterEmail };
  const cursor: Cursor = {
    version: 1,
    ...unsigned,
    signature: cursorSignature(secret, unsigned),
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(encoded: string, secret: string, query: string | null): Cursor {
  try {
    if (encoded.length < 1 || encoded.length > 1024) {
      throw new InvalidAdminLegacyUserCursorError();
    }
    const cursor = CursorSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    const expected = cursorSignature(secret, cursor);
    if (cursor.query !== query || !signaturesEqual(cursor.signature, expected)) {
      throw new InvalidAdminLegacyUserCursorError();
    }
    return cursor;
  } catch (error: unknown) {
    if (error instanceof InvalidAdminLegacyUserCursorError) throw error;
    throw new InvalidAdminLegacyUserCursorError();
  }
}

async function loadEvidence(
  db: Database,
  platformId: string,
  memberships: readonly LegacyMembership[],
): Promise<EvidenceRow[]> {
  if (memberships.length === 0) return [];
  const emails = memberships.map((member) => member.email);
  const campaignCounts = memberships.map((member) => member.legacyCampaignCount);

  const result = await sql<unknown>`
    WITH legacy(email, legacy_campaign_count) AS (
      SELECT *
      FROM unnest(${emails}::text[], ${campaignCounts}::integer[])
    )
    SELECT
      legacy.email,
      legacy.legacy_campaign_count,
      COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
          'id', auth.id,
          'createdAt', auth.created_at
        )) FILTER (WHERE auth.id IS NOT NULL),
        '[]'::jsonb
      ) AS auth_records,
      COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
          'id', domain.id,
          'idConta', domain.id_conta,
          'nomeExibicao', domain.nome_exibicao,
          'contaId', account.id,
          'contaIdUsuario', account.id_usuario,
          'contaCriadaEm', account.criada_em
        )) FILTER (WHERE domain.id IS NOT NULL),
        '[]'::jsonb
      ) AS domain_records
    FROM legacy
    LEFT JOIN users auth
      ON auth.id_plataforma = ${platformId}::uuid
     AND lower(btrim(auth.email)) = legacy.email
    LEFT JOIN usuarios domain
      ON domain.id_plataforma = ${platformId}::uuid
     AND lower(btrim(domain.email)) = legacy.email
    LEFT JOIN contas account ON account.id_usuario = domain.id
    GROUP BY legacy.email, legacy.legacy_campaign_count
    ORDER BY legacy.email COLLATE "C" ASC
  `.execute(db);

  return result.rows.map((row) => EvidenceRowSchema.parse(row));
}

function emptyCounts(): Record<AdminLegacyUserStatus, number> {
  return {
    somente_legado: 0,
    conta_2_0: 0,
    perfil_2_0: 0,
    evidencia_inconsistente: 0,
  };
}

export async function listAdminLegacyUsers(
  db: Database,
  input: {
    readonly platformId: string;
    readonly entries: readonly LegacyUserEntry[];
    readonly query?: string;
    readonly cursor: string | null;
    readonly limit: number;
    readonly cursorSecret: string;
  },
): Promise<AdminLegacyUsersPage> {
  const query = normalizeQuery(input.query);
  const memberships = legacyMemberships(input.entries);
  const evidence = await loadEvidence(db, input.platformId, memberships);
  const records = evidence.map((row) => ({
    row,
    item: classifyAdminLegacyEvidence(row),
  }));
  const filtered = query
    ? records.filter(
        ({ row, item }) =>
          item.email.startsWith(query) ||
          row.domain_records.some(
            ({ nomeExibicao }) =>
              safePersonName(nomeExibicao) && nomeExibicao.toLowerCase().startsWith(query),
          ),
      )
    : records;

  const counts = emptyCounts();
  for (const { item } of filtered) counts[item.status] += 1;

  const cursor =
    input.cursor === null ? null : decodeCursor(input.cursor, input.cursorSecret, query);
  let start = 0;
  if (cursor !== null) {
    const cursorIndex = filtered.findIndex(({ item }) => item.email === cursor.afterEmail);
    if (cursorIndex < 0) throw new InvalidAdminLegacyUserCursorError();
    start = cursorIndex + 1;
  }

  const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
  const visible = filtered.slice(start, start + limit).map(({ item }) => item);
  const hasNext = start + visible.length < filtered.length;
  const last = hasNext ? visible.at(-1) : undefined;
  return {
    items: visible,
    nextCursor: last ? encodeCursor(input.cursorSecret, query, last.email) : null,
    totalCount: filtered.length,
    counts,
  };
}
