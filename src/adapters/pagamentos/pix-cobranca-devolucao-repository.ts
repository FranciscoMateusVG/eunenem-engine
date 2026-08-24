import { z } from 'zod/v4';
import { type MoneyCents, MoneyCentsSchema } from '../../domain/money.js';
import { type IdPagamento, IdPagamentoSchema } from '../../domain/pagamentos/value-objects/ids.js';

export const PixCobrancaDevolucaoStatusSchema = z.enum([
  'em_processamento',
  'devolvida',
  'nao_realizada',
  'rejeitada',
]);
export type PixCobrancaDevolucaoStatus = z.infer<typeof PixCobrancaDevolucaoStatusSchema>;

/** Stable Inter refund identifier: 26-35 ASCII alphanumerics. */
export const PixCobrancaIdDevolucaoSchema = z.string().regex(/^[A-Za-z0-9]{26,35}$/);

/** Inter charge end-to-end identifier: exactly 32 ASCII alphanumerics. */
export const PixCobrancaE2eIdSchema = z.string().regex(/^[A-Za-z0-9]{32}$/);
const RtrIdSchema = z.string().trim().min(1).max(255);

export interface PixCobrancaDevolucaoRecord {
  readonly id: string;
  readonly idPagamento: IdPagamento;
  readonly e2eId: string;
  readonly idDevolucao: string;
  readonly amountCents: MoneyCents;
  readonly status: PixCobrancaDevolucaoStatus;
  readonly rtrId: string | null;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CreatePixCobrancaDevolucaoInput {
  readonly id: string;
  readonly idPagamento: IdPagamento;
  readonly e2eId: string;
  readonly idDevolucao: string;
  readonly amountCents: MoneyCents;
  readonly criadoEm: Date;
}

export interface UpdatePixCobrancaDevolucaoOutcomeInput {
  readonly e2eId: string;
  readonly idDevolucao: string;
  readonly status: PixCobrancaDevolucaoStatus;
  /** Omitted preserves the provider RTR already recorded; explicit null clears it. */
  readonly rtrId?: string | null;
  readonly atualizadoEm: Date;
}

export interface PixCobrancaDevolucaoIdentity {
  readonly e2eId: string;
  readonly idDevolucao: string;
}

export interface PixCobrancaDevolucaoRepository {
  /**
   * Atomically establishes the one refund identity for a payment.
   * Only a caller receiving `created: true` may invoke the provider.
   */
  createIfAbsent(
    input: CreatePixCobrancaDevolucaoInput,
  ): Promise<{ readonly record: PixCobrancaDevolucaoRecord; readonly created: boolean }>;
  findByIdentity(
    e2eId: string,
    idDevolucao: string,
  ): Promise<PixCobrancaDevolucaoRecord | undefined>;
  findByPagamentoId(idPagamento: IdPagamento): Promise<PixCobrancaDevolucaoRecord | undefined>;
  updateOutcome(
    input: UpdatePixCobrancaDevolucaoOutcomeInput,
  ): Promise<PixCobrancaDevolucaoRecord | undefined>;
  /**
   * Removes only an untouched preflight marker. Once Inter returned an RTR
   * or any outcome was persisted, ambiguity wins and the row is retained.
   */
  deleteIfPending(identity: PixCobrancaDevolucaoIdentity): Promise<boolean>;
}

/**
 * Stable port-level error for a replay that collides with a different
 * payment/identity/amount binding. Callers must not treat it as idempotent.
 */
export class PixCobrancaDevolucaoConflictError extends Error {
  constructor() {
    super('Identidade de devolução PIX já vinculada a dados diferentes');
    this.name = 'PixCobrancaDevolucaoConflictError';
  }
}

const CreateInputSchema = z.object({
  id: z.uuid(),
  idPagamento: IdPagamentoSchema,
  e2eId: PixCobrancaE2eIdSchema,
  idDevolucao: PixCobrancaIdDevolucaoSchema,
  amountCents: MoneyCentsSchema,
  criadoEm: z.date(),
});

const UpdateInputSchema = z.object({
  e2eId: PixCobrancaE2eIdSchema,
  idDevolucao: PixCobrancaIdDevolucaoSchema,
  status: PixCobrancaDevolucaoStatusSchema,
  rtrId: z.union([RtrIdSchema, z.null()]).optional(),
  atualizadoEm: z.date(),
});

export function parseCreatePixCobrancaDevolucaoInput(
  input: CreatePixCobrancaDevolucaoInput,
): CreatePixCobrancaDevolucaoInput {
  return CreateInputSchema.parse(input);
}

export function parseUpdatePixCobrancaDevolucaoOutcomeInput(
  input: UpdatePixCobrancaDevolucaoOutcomeInput,
): UpdatePixCobrancaDevolucaoOutcomeInput {
  const parsed = UpdateInputSchema.parse(input);
  const common = {
    e2eId: parsed.e2eId,
    idDevolucao: parsed.idDevolucao,
    status: parsed.status,
    atualizadoEm: parsed.atualizadoEm,
  };
  return parsed.rtrId === undefined ? common : { ...common, rtrId: parsed.rtrId };
}

export function parsePixCobrancaDevolucaoIdentity(
  e2eId: string,
  idDevolucao: string,
): PixCobrancaDevolucaoIdentity {
  return z
    .object({ e2eId: PixCobrancaE2eIdSchema, idDevolucao: PixCobrancaIdDevolucaoSchema })
    .parse({ e2eId, idDevolucao });
}

export function pixCobrancaDevolucaoBindingMatches(
  record: PixCobrancaDevolucaoRecord,
  input: CreatePixCobrancaDevolucaoInput,
): boolean {
  return (
    record.idPagamento === input.idPagamento &&
    record.e2eId === input.e2eId &&
    record.idDevolucao === input.idDevolucao &&
    record.amountCents === input.amountCents
  );
}
