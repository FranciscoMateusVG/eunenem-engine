import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../../../src/adapters/database.js";
import {
  type CampaignFilter,
  parseAdminCampaignQuery,
} from "./admin-user-search.js";

export const PaymentEvidenceProviderFilterSchema = z.enum(["stripe", "inter"]);
export type PaymentEvidenceProviderFilter = z.infer<
  typeof PaymentEvidenceProviderFilterSchema
>;

export const PaymentEvidenceStatusFilterSchema = z.enum([
  "pendente",
  "processing",
  "aprovado",
  "rejeitado",
  "estornado",
]);
export type PaymentEvidenceStatusFilter = z.infer<
  typeof PaymentEvidenceStatusFilterSchema
>;

const SAFE_STORED_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]*$/u;
export const PaymentEvidencePayerQuerySchema = z.string().max(160).regex(SAFE_STORED_TEXT);
export const PaymentEvidenceCampaignQuerySchema = z.string().max(1024).regex(SAFE_STORED_TEXT);
export const PaymentEvidenceExactReferenceSchema = z.string().max(255).regex(SAFE_STORED_TEXT);
export const PaymentEvidenceReferenceResolutionSchema = z.enum([
  "not_requested",
  "unique",
  "absent",
  "ambiguous",
]);
export type PaymentEvidenceReferenceResolution = z.infer<
  typeof PaymentEvidenceReferenceResolutionSchema
>;
const NullableBoundedReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(SAFE_STORED_TEXT)
  .nullable();

export const AdminPaymentEvidenceSchema = z.object({
  paymentId: z.string().uuid(),
  campaignId: z.string().uuid(),
  campaignTitle: z.string().min(1).max(200).regex(SAFE_STORED_TEXT),
  method: z.enum(["pix", "credit_card"]),
  status: PaymentEvidenceStatusFilterSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  amounts: z.object({
    contributionCents: z.number().int().nonnegative(),
    feeCents: z.number().int().nonnegative(),
    surchargeCents: z.number().int().nonnegative(),
    receiverCents: z.number().int().nonnegative(),
    paidCents: z.number().int().nonnegative(),
  }),
  providerEvidence: z.object({
    provider: PaymentEvidenceProviderFilterSchema.nullable(),
    normalizedStatus: z.enum(["aprovado", "rejeitado"]).nullable(),
    rawStatus: z.string().min(1).max(120).regex(SAFE_STORED_TEXT).nullable(),
    providerAmountCents: z.number().int().nonnegative().nullable(),
    providerRecordedAt: z.string().datetime().nullable(),
    checkoutSessionRef: NullableBoundedReferenceSchema,
    paymentIntentRef: NullableBoundedReferenceSchema,
    chargeRef: NullableBoundedReferenceSchema,
    interE2eRef: z.string().min(1).max(32).regex(SAFE_STORED_TEXT).nullable(),
    externalTransactionRef: NullableBoundedReferenceSchema,
  }),
});
export type AdminPaymentEvidence = z.infer<typeof AdminPaymentEvidenceSchema>;

const PaymentEvidenceCursorSchema = z.object({
  version: z.literal(2),
  createdAt: z.string().datetime(),
  paymentId: z.string().uuid(),
  filtersDigest: z.string().length(43),
}).strict();

type PaymentEvidenceCursor = z.infer<typeof PaymentEvidenceCursorSchema>;

export class InvalidPaymentEvidenceCursorError extends Error {
  constructor() {
    super("invalid_payment_evidence_cursor");
    this.name = "InvalidPaymentEvidenceCursorError";
  }
}

export class InvalidPaymentEvidenceFilterError extends Error {
  constructor() {
    super("invalid_payment_evidence_filter");
    this.name = "InvalidPaymentEvidenceFilterError";
  }
}

export function decodePaymentEvidenceCursor(
  encoded: string,
  expectedFiltersDigest: string,
): PaymentEvidenceCursor {
  try {
    if (encoded.length === 0 || encoded.length > 1024) {
      throw new InvalidPaymentEvidenceCursorError();
    }
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const cursor = PaymentEvidenceCursorSchema.parse(JSON.parse(decoded));
    if (cursor.filtersDigest !== expectedFiltersDigest) {
      throw new InvalidPaymentEvidenceCursorError();
    }
    return cursor;
  } catch (error: unknown) {
    if (error instanceof InvalidPaymentEvidenceCursorError) throw error;
    throw new InvalidPaymentEvidenceCursorError();
  }
}

function canonicalFilter(
  value: string | undefined,
  schema: z.ZodString,
): string | null {
  const parsed = schema.safeParse(value?.trim() ?? "");
  if (!parsed.success) throw new InvalidPaymentEvidenceFilterError();
  return parsed.data.length === 0 ? null : parsed.data;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function paymentCampaignPredicate(
  platformId: string,
  filter: CampaignFilter | null,
) {
  if (filter === null) return sql<boolean>`TRUE`;
  if (filter.kind === "text") {
    return sql<boolean>`(
      c.titulo ILIKE ${filter.pattern} ESCAPE '\\'
      OR c.slug ILIKE ${filter.pattern} ESCAPE '\\'
    )`;
  }
  if (filter.kind === "slug") {
    return sql<boolean>`(
      c.slug = ${filter.campaignSlug}
      AND EXISTS (
        SELECT 1
        FROM campanha_administradores ca
        INNER JOIN usuarios u
          ON u.id_conta = ca.id_usuario
         AND u.id_plataforma = ${platformId}
        WHERE ca.campanha_id = c.id
          AND u.slug = ${filter.ownerSlug}
      )
    )`;
  }
  return sql<boolean>`(
    c.id = ${filter.campaignId}::uuid
    AND EXISTS (
      SELECT 1
      FROM campanha_administradores ca
      INNER JOIN usuarios u
        ON u.id_conta = ca.id_usuario
       AND u.id_plataforma = ${platformId}
      WHERE ca.campanha_id = c.id
        AND u.slug = ${filter.ownerSlug}
    )
  )`;
}

function paymentFiltersDigest(secret: string, value: object): string {
  return createHmac("sha256", secret)
    .update("admin-payment-evidence-cursor:v2\0")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function encodePaymentEvidenceCursor(cursor: PaymentEvidenceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

interface PaymentEvidenceDbRow {
  payment_id: string;
  campaign_id: string;
  campaign_title: string;
  method: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  contribution_cents: string | number;
  fee_cents: string | number;
  surcharge_cents: string | number;
  receiver_cents: string | number;
  paid_cents: string | number;
  provider: string | null;
  normalized_status: string | null;
  raw_status: string | null;
  provider_amount_cents: string | null;
  provider_recorded_at: string | null;
  checkout_session_ref: string | null;
  payment_intent_ref: string | null;
  charge_ref: string | null;
  inter_e2e_ref: string | null;
  external_transaction_ref: string | null;
}

export interface ListAdminPaymentEvidenceInput {
  readonly platformId: string;
  readonly cursor: string | null;
  readonly limit: number;
  readonly provider: PaymentEvidenceProviderFilter | null;
  readonly status: PaymentEvidenceStatusFilter | null;
  readonly payerQuery?: string;
  readonly campaignQuery?: string;
  readonly exactReference?: string;
  readonly publicOrigin: string;
  readonly cursorSecret: string;
}

export interface ListAdminPaymentEvidenceOutput {
  readonly rows: AdminPaymentEvidence[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly referenceResolution: PaymentEvidenceReferenceResolution;
}

function numberFromDb(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("invalid_payment_evidence_amount");
  }
  return parsed;
}

function boundedStoredText(value: string | null, maxLength: number): string | null {
  if (
    value === null ||
    value.length === 0 ||
    value.length > maxLength ||
    !SAFE_STORED_TEXT.test(value)
  ) {
    return null;
  }
  return value;
}

function safeCampaignTitle(value: string): string {
  if (value.length === 0 || value.length > 200 || !SAFE_STORED_TEXT.test(value)) {
    return "Título indisponível";
  }
  return value;
}

function nullableAmountFromDb(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nullableProviderDate(value: string | null): string | null {
  if (value === null) return null;
  const result = z.string().datetime().safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Stored-only admin payment evidence. The query applies platform and optional
 * filters before both pagination and count. It never reads webhook payloads,
 * recipient data, contributor identity or provider credentials.
 */
export async function listAdminPaymentEvidence(
  db: Database,
  input: ListAdminPaymentEvidenceInput,
): Promise<ListAdminPaymentEvidenceOutput> {
  const payerQuery = canonicalFilter(input.payerQuery, PaymentEvidencePayerQuerySchema);
  const payerPattern = payerQuery === null ? null : `%${escapeLike(payerQuery)}%`;
  let campaignFilter: CampaignFilter | null;
  try {
    campaignFilter = parseAdminCampaignQuery(input.campaignQuery, input.publicOrigin);
  } catch {
    throw new InvalidPaymentEvidenceFilterError();
  }
  const exactReference = canonicalFilter(
    input.exactReference,
    PaymentEvidenceExactReferenceSchema,
  );
  const digest = paymentFiltersDigest(input.cursorSecret, {
    provider: input.provider,
    status: input.status,
    payerQuery,
    campaignFilter,
    exactReference,
  });
  const cursor =
    input.cursor === null
      ? null
      : decodePaymentEvidenceCursor(input.cursor, digest);

  let exactPaymentId: string | null = null;
  let referenceResolution: PaymentEvidenceReferenceResolution = "not_requested";
  if (exactReference !== null) {
    const matches = await sql<{ payment_id: string }>`
      SELECT DISTINCT p.id AS payment_id
      FROM pagamentos p
      INNER JOIN campanhas c ON c.id = p.intencao_id_campanha
      WHERE c.id_plataforma = ${input.platformId}
        AND (
          p.intencao_external_ref = ${exactReference}
          OR p.intencao_payment_intent_external_ref = ${exactReference}
          OR p.intencao_charge_external_ref = ${exactReference}
          OR p.intencao_e2e_external_ref = ${exactReference}
          OR p.transacao_externa ->> 'id' = ${exactReference}
          OR EXISTS (
            SELECT 1
            FROM payment_webhook_events e
            WHERE e.pagamento_id = p.id
              AND e.provider_event_id = ${exactReference}
          )
        )
      LIMIT 2
    `.execute(db);
    if (matches.rows.length === 0) {
      return { rows: [], nextCursor: null, totalCount: 0, referenceResolution: "absent" };
    }
    if (matches.rows.length > 1) {
      return { rows: [], nextCursor: null, totalCount: 0, referenceResolution: "ambiguous" };
    }
    exactPaymentId = matches.rows[0]?.payment_id ?? null;
    referenceResolution = "unique";
  }

  const providerFilter = input.provider;
  const statusFilter = input.status;
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorPaymentId = cursor?.paymentId ?? null;
  const campaignPredicate = paymentCampaignPredicate(input.platformId, campaignFilter);

  const rowsResult = await sql<PaymentEvidenceDbRow>`
    SELECT
      p.id AS payment_id,
      c.id AS campaign_id,
      c.titulo AS campaign_title,
      p.intencao_metodo AS method,
      p.status,
      p.criado_em AS created_at,
      p.atualizado_em AS updated_at,
      p.intencao_total_contribution_cents AS contribution_cents,
      p.intencao_total_fee_cents AS fee_cents,
      p.intencao_total_surcharge_cents AS surcharge_cents,
      p.intencao_total_receiver_cents AS receiver_cents,
      p.intencao_total_paid_cents AS paid_cents,
      p.transacao_externa ->> 'provedor' AS provider,
      p.transacao_externa ->> 'status' AS normalized_status,
      p.transacao_externa ->> 'statusBruto' AS raw_status,
      p.transacao_externa ->> 'amountCents' AS provider_amount_cents,
      p.transacao_externa ->> 'criadaEm' AS provider_recorded_at,
      p.intencao_external_ref AS checkout_session_ref,
      p.intencao_payment_intent_external_ref AS payment_intent_ref,
      p.intencao_charge_external_ref AS charge_ref,
      p.intencao_e2e_external_ref AS inter_e2e_ref,
      p.transacao_externa ->> 'id' AS external_transaction_ref
    FROM pagamentos p
    INNER JOIN campanhas c ON c.id = p.intencao_id_campanha
    WHERE c.id_plataforma = ${input.platformId}
      AND (${providerFilter}::text IS NULL OR p.transacao_externa ->> 'provedor' = ${providerFilter})
      AND (${statusFilter}::text IS NULL OR p.status = ${statusFilter})
      AND (${payerPattern}::text IS NULL OR (
        p.intencao_contribuinte_nome ILIKE ${payerPattern} ESCAPE '\\'
        OR p.intencao_contribuinte_email ILIKE ${payerPattern} ESCAPE '\\'
      ))
      AND ${campaignPredicate}
      AND (${exactPaymentId}::uuid IS NULL OR p.id = ${exactPaymentId}::uuid)
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR p.criado_em < ${cursorCreatedAt}::timestamptz
        OR (p.criado_em = ${cursorCreatedAt}::timestamptz AND p.id < ${cursorPaymentId}::uuid)
      )
    ORDER BY p.criado_em DESC, p.id DESC
    LIMIT ${input.limit + 1}
  `.execute(db);

  const countResult = await sql<{ total_count: string | number }>`
    SELECT COUNT(*) AS total_count
    FROM pagamentos p
    INNER JOIN campanhas c ON c.id = p.intencao_id_campanha
    WHERE c.id_plataforma = ${input.platformId}
      AND (${providerFilter}::text IS NULL OR p.transacao_externa ->> 'provedor' = ${providerFilter})
      AND (${statusFilter}::text IS NULL OR p.status = ${statusFilter})
      AND (${payerPattern}::text IS NULL OR (
        p.intencao_contribuinte_nome ILIKE ${payerPattern} ESCAPE '\\'
        OR p.intencao_contribuinte_email ILIKE ${payerPattern} ESCAPE '\\'
      ))
      AND ${campaignPredicate}
      AND (${exactPaymentId}::uuid IS NULL OR p.id = ${exactPaymentId}::uuid)
  `.execute(db);

  const hasNext = rowsResult.rows.length > input.limit;
  const visibleRows = rowsResult.rows.slice(0, input.limit);
  const rows = visibleRows.map((row) =>
    AdminPaymentEvidenceSchema.parse({
      paymentId: row.payment_id,
      campaignId: row.campaign_id,
      campaignTitle: safeCampaignTitle(row.campaign_title),
      method: row.method,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      amounts: {
        contributionCents: numberFromDb(row.contribution_cents),
        feeCents: numberFromDb(row.fee_cents),
        surchargeCents: numberFromDb(row.surcharge_cents),
        receiverCents: numberFromDb(row.receiver_cents),
        paidCents: numberFromDb(row.paid_cents),
      },
      providerEvidence: {
        provider:
          row.provider === "stripe" || row.provider === "inter" ? row.provider : null,
        normalizedStatus:
          row.normalized_status === "aprovado" || row.normalized_status === "rejeitado"
            ? row.normalized_status
            : null,
        rawStatus: boundedStoredText(row.raw_status, 120),
        providerAmountCents: nullableAmountFromDb(row.provider_amount_cents),
        providerRecordedAt: nullableProviderDate(row.provider_recorded_at),
        checkoutSessionRef: boundedStoredText(row.checkout_session_ref, 255),
        paymentIntentRef: boundedStoredText(row.payment_intent_ref, 255),
        chargeRef: boundedStoredText(row.charge_ref, 255),
        interE2eRef: boundedStoredText(row.inter_e2e_ref, 32),
        externalTransactionRef: boundedStoredText(row.external_transaction_ref, 255),
      },
    }),
  );

  const last = hasNext ? visibleRows.at(-1) : undefined;
  const nextCursor = last
    ? encodePaymentEvidenceCursor({
        version: 2,
        createdAt: last.created_at.toISOString(),
        paymentId: last.payment_id,
        filtersDigest: digest,
      })
    : null;
  const totalCount = numberFromDb(countResult.rows[0]?.total_count ?? 0);

  return { rows, nextCursor, totalCount, referenceResolution };
}
