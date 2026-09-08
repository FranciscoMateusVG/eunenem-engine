import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../../../src/adapters/database.js";

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

const SAFE_STORED_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/u;
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
    checkoutSessionRef: NullableBoundedReferenceSchema,
    paymentIntentRef: NullableBoundedReferenceSchema,
    chargeRef: NullableBoundedReferenceSchema,
    interE2eRef: z.string().min(1).max(32).regex(SAFE_STORED_TEXT).nullable(),
    externalTransactionRef: NullableBoundedReferenceSchema,
  }),
});
export type AdminPaymentEvidence = z.infer<typeof AdminPaymentEvidenceSchema>;

const PaymentEvidenceCursorSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  paymentId: z.string().uuid(),
  provider: PaymentEvidenceProviderFilterSchema.nullable(),
  status: PaymentEvidenceStatusFilterSchema.nullable(),
}).strict();

type PaymentEvidenceCursor = z.infer<typeof PaymentEvidenceCursorSchema>;

export class InvalidPaymentEvidenceCursorError extends Error {
  constructor() {
    super("invalid_payment_evidence_cursor");
    this.name = "InvalidPaymentEvidenceCursorError";
  }
}

export function decodePaymentEvidenceCursor(
  encoded: string,
  filters: {
    provider: PaymentEvidenceProviderFilter | null;
    status: PaymentEvidenceStatusFilter | null;
  },
): PaymentEvidenceCursor {
  try {
    if (encoded.length === 0 || encoded.length > 1024) {
      throw new InvalidPaymentEvidenceCursorError();
    }
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const cursor = PaymentEvidenceCursorSchema.parse(JSON.parse(decoded));
    if (cursor.provider !== filters.provider || cursor.status !== filters.status) {
      throw new InvalidPaymentEvidenceCursorError();
    }
    return cursor;
  } catch (error: unknown) {
    if (error instanceof InvalidPaymentEvidenceCursorError) throw error;
    throw new InvalidPaymentEvidenceCursorError();
  }
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
}

export interface ListAdminPaymentEvidenceOutput {
  readonly rows: AdminPaymentEvidence[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
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

/**
 * Stored-only admin payment evidence. The query applies platform and optional
 * filters before both pagination and count. It never reads webhook payloads,
 * recipient data, contributor identity or provider credentials.
 */
export async function listAdminPaymentEvidence(
  db: Database,
  input: ListAdminPaymentEvidenceInput,
): Promise<ListAdminPaymentEvidenceOutput> {
  const cursor =
    input.cursor === null
      ? null
      : decodePaymentEvidenceCursor(input.cursor, {
          provider: input.provider,
          status: input.status,
        });

  const providerFilter = input.provider;
  const statusFilter = input.status;
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorPaymentId = cursor?.paymentId ?? null;

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
  `.execute(db);

  const hasNext = rowsResult.rows.length > input.limit;
  const visibleRows = rowsResult.rows.slice(0, input.limit);
  const rows = visibleRows.map((row) =>
    AdminPaymentEvidenceSchema.parse({
      paymentId: row.payment_id,
      campaignId: row.campaign_id,
      campaignTitle: row.campaign_title,
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
        version: 1,
        createdAt: last.created_at.toISOString(),
        paymentId: last.payment_id,
        provider: input.provider,
        status: input.status,
      })
    : null;
  const totalCount = numberFromDb(countResult.rows[0]?.total_count ?? 0);

  return { rows, nextCursor, totalCount };
}
