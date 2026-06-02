import { z } from 'zod/v4';
import type { MoneyCents } from '../../money.js';
import { MoneyCentsSchema } from '../../money.js';
import {
  EventoPagamentoSchema,
  NomeProvedorPagamentoSchema,
  type TipoEventoPagamento,
} from '../value-objects/evento-pagamento.js';
import {
  IdContribuicaoPagamentoSchema,
  type IdIntencaoPagamento,
  IdIntencaoPagamentoSchema,
  type IdPagamento,
  IdPagamentoSchema,
  IdTransacaoExternaSchema,
} from '../value-objects/ids.js';
import { type MetodoPagamento, MetodoPagamentoSchema } from '../value-objects/metodo-pagamento.js';
import {
  type SnapshotComposicaoValores,
  SnapshotComposicaoValoresSchema,
} from '../value-objects/snapshot-composicao-valores.js';

/**
 * @aggregateRoot Pagamento (BC Pagamentos)
 *
 * Lifecycle root: a pagamento is born `pendente`, transitions to `aprovado` or
 * `rejeitado` once exactly. Carries an embedded `IntencaoPagamento` (the charge
 * intent) and, after settlement, an embedded `TransacaoExterna` (the provider's
 * response).
 *
 * Persisted via: `PagamentoRepository`.
 *
 * `IntencaoPagamento` and `TransacaoExterna` are **entities inside this
 * aggregate** — they have their own identity (id) but are loaded and saved
 * with the Pagamento root, never independently. `StatusPagamento` and
 * `StatusTransacaoExterna` are intrinsic enum VOs kept inline.
 */

export const StatusPagamentoSchema = z.enum(['pendente', 'aprovado', 'rejeitado']);
export type StatusPagamento = z.infer<typeof StatusPagamentoSchema>;

export const StatusTransacaoExternaSchema = z.enum(['aprovado', 'rejeitado']);
export type StatusTransacaoExterna = z.infer<typeof StatusTransacaoExternaSchema>;

/**
 * @entity IntencaoPagamento (within Pagamento aggregate)
 *
 * `externalRef` (aperture-xaha2): provider-side reference to a
 * pre-authorisation session — for Stripe embedded checkout this is the
 * `cs_test_...` / `cs_live_...` session id. Populated when the
 * IntencaoPagamento is created via the CheckoutSessionProvider flow;
 * remains `null` for the synchronous solicitarPagamento topology
 * (Pagarme / Pix-direct, where the provider mints the transaction
 * on-demand without a pre-session). Stored on IntencaoPagamento (not
 * Pagamento root or TransacaoExterna) because the pre-authorisation
 * session lives at "intent" granularity; TransacaoExterna.id is the
 * post-settlement provider id (payment_intent / transaction).
 *
 * `paymentIntentExternalRef` + `chargeExternalRef` (aperture-wif8s):
 * the Stripe `pi_xxx` and `ch_xxx` references for the same intent's
 * provider chain. Both nullable. Populated as the webhook lifecycle
 * advances:
 *   - `paymentIntentExternalRef` is set on `checkout.session.completed`
 *     (event payload carries `data.object.payment_intent`).
 *   - `chargeExternalRef` is set on `payment_intent.succeeded`
 *     (event payload carries `data.object.latest_charge`).
 *
 * The handler then uses these as additional lookup keys so future
 * `payment_intent.*` and `charge.*` events can resolve back to the
 * Pagamento that owns them — closes the orphan-event gap operator
 * surfaced via 3zxkn. PagamentoRepository exposes
 * `findByPaymentIntentExternalRef` + `findByChargeExternalRef` for the
 * resolver. Both fields stay on IntencaoPagamento (NOT Pagamento root)
 * because they belong to the provider-transport boundary — the
 * post-settlement TransacaoExterna ID is a separate concept owned by
 * the provider's terminal flow.
 */
export const IntencaoPagamentoSchema = z.object({
  id: IdIntencaoPagamentoSchema,
  idContribuicao: IdContribuicaoPagamentoSchema,
  amountCents: MoneyCentsSchema,
  metodo: MetodoPagamentoSchema,
  composicaoValores: SnapshotComposicaoValoresSchema,
  externalRef: z.string().trim().min(1).max(255).nullable(),
  paymentIntentExternalRef: z.string().trim().min(1).max(255).nullable(),
  chargeExternalRef: z.string().trim().min(1).max(255).nullable(),
  criadaEm: z.date(),
});
export type IntencaoPagamento = Readonly<z.infer<typeof IntencaoPagamentoSchema>>;

/** @entity TransacaoExterna (within Pagamento aggregate) */
export const TransacaoExternaSchema = z.object({
  id: IdTransacaoExternaSchema,
  provedor: NomeProvedorPagamentoSchema,
  status: StatusTransacaoExternaSchema,
  amountCents: MoneyCentsSchema,
  criadaEm: z.date(),
  statusBruto: z.string().trim().max(120).optional(),
});
export type TransacaoExterna = Readonly<z.infer<typeof TransacaoExternaSchema>>;

export const PagamentoSchema = z.object({
  id: IdPagamentoSchema,
  intencao: IntencaoPagamentoSchema,
  status: StatusPagamentoSchema,
  transacaoExterna: TransacaoExternaSchema.optional(),
  criadoEm: z.date(),
  atualizadoEm: z.date(),
});
export type Pagamento = Readonly<z.infer<typeof PagamentoSchema>>;

export interface CriarPagamentoPendenteInput {
  readonly idPagamento: IdPagamento;
  readonly idIntencaoPagamento: IdIntencaoPagamento;
  readonly composicaoValores: SnapshotComposicaoValores;
  readonly valorACobrarCents: MoneyCents;
  readonly metodo: MetodoPagamento;
  readonly criadoEm: Date;
  /**
   * Provider-side session reference (Stripe checkout session id, etc.)
   * for the pre-authorisation flow. Pass `null` for the synchronous
   * solicitarPagamento topology. Optional with `null` default keeps
   * existing callers backward-compatible (tests using PagamentoProviderFake
   * don't have to thread this through).
   */
  readonly externalRef?: string | null;
}

export function criarPagamentoPendente(input: CriarPagamentoPendenteInput): Pagamento {
  if (input.valorACobrarCents !== input.composicaoValores.totalPaidCents) {
    throw new Error('Valor do pagamento deve ser igual ao total pago na composicao de valores.');
  }

  return {
    id: input.idPagamento,
    intencao: {
      id: input.idIntencaoPagamento,
      idContribuicao: input.composicaoValores.idContribuicao,
      amountCents: input.valorACobrarCents,
      metodo: input.metodo,
      composicaoValores: input.composicaoValores,
      externalRef: input.externalRef ?? null,
      // aperture-wif8s: pi_xxx + ch_xxx populated post-creation by the
      // webhook handler as Stripe events arrive. Always start null at
      // intent-creation time — checkout flow hasn't talked to Stripe
      // about a payment_intent yet (that happens after the user
      // confirms in the Stripe-hosted UI).
      paymentIntentExternalRef: null,
      chargeExternalRef: null,
      criadaEm: input.criadoEm,
    },
    status: 'pendente',
    criadoEm: input.criadoEm,
    atualizadoEm: input.criadoEm,
  };
}

export function podeAprovarPagamento(pagamento: Pagamento): boolean {
  return pagamento.status === 'pendente';
}

export function podeRejeitarPagamento(pagamento: Pagamento): boolean {
  return pagamento.status === 'pendente';
}

export function aprovarPagamentoPendente(
  pagamento: Pagamento,
  transacao: TransacaoExterna,
  atualizadoEm: Date,
): Pagamento {
  if (!podeAprovarPagamento(pagamento)) {
    throw new Error(
      `Pagamento "${pagamento.id}" nao pode ser aprovado a partir do status "${pagamento.status}".`,
    );
  }

  if (transacao.status !== 'aprovado') {
    throw new Error('Transacao externa deve estar aprovada para aprovar o pagamento.');
  }

  if (transacao.amountCents !== pagamento.intencao.amountCents) {
    throw new Error('Valor da transacao externa deve ser igual ao valor do pagamento.');
  }

  return {
    ...pagamento,
    status: 'aprovado',
    transacaoExterna: transacao,
    atualizadoEm,
  };
}

export function rejeitarPagamentoPendente(
  pagamento: Pagamento,
  transacao: TransacaoExterna,
  atualizadoEm: Date,
): Pagamento {
  if (!podeRejeitarPagamento(pagamento)) {
    throw new Error(
      `Pagamento "${pagamento.id}" nao pode ser rejeitado a partir do status "${pagamento.status}".`,
    );
  }

  if (transacao.status !== 'rejeitado') {
    throw new Error('Transacao externa deve estar rejeitada para rejeitar o pagamento.');
  }

  if (transacao.amountCents !== pagamento.intencao.amountCents) {
    throw new Error('Valor da transacao externa deve ser igual ao valor do pagamento.');
  }

  return {
    ...pagamento,
    status: 'rejeitado',
    transacaoExterna: transacao,
    atualizadoEm,
  };
}

export function criarEventoPagamento(input: {
  readonly id: string;
  readonly tipo: TipoEventoPagamento;
  readonly pagamento: Pagamento;
  readonly ocorridoEm: Date;
}) {
  return EventoPagamentoSchema.parse({
    id: input.id,
    tipo: input.tipo,
    idPagamento: input.pagamento.id,
    idIntencaoPagamento: input.pagamento.intencao.id,
    idContribuicao: input.pagamento.intencao.idContribuicao,
    amountCents: input.pagamento.intencao.amountCents,
    status: input.pagamento.status,
    idTransacaoExterna: input.pagamento.transacaoExterna?.id,
    ocorridoEm: input.ocorridoEm,
  });
}
