import { z } from 'zod/v4';
import type { MoneyCents } from './money.js';
import { MoneyCentsSchema } from './money.js';

export const IdPagamentoSchema = z.uuid();
export type IdPagamento = z.infer<typeof IdPagamentoSchema>;

export const IdIntencaoPagamentoSchema = z.uuid();
export type IdIntencaoPagamento = z.infer<typeof IdIntencaoPagamentoSchema>;

export const IdTransacaoExternaSchema = z.uuid();
export type IdTransacaoExterna = z.infer<typeof IdTransacaoExternaSchema>;

export const IdContribuicaoPagamentoSchema = z.uuid();
export type IdContribuicaoPagamento = z.infer<typeof IdContribuicaoPagamentoSchema>;

export const MetodoPagamentoSchema = z.enum(['pix', 'credit_card']);
export type MetodoPagamento = z.infer<typeof MetodoPagamentoSchema>;

export const NomeProvedorPagamentoSchema = z.string().trim().min(1).max(120);
export type NomeProvedorPagamento = z.infer<typeof NomeProvedorPagamentoSchema>;

export const StatusPagamentoSchema = z.enum(['pendente', 'aprovado', 'rejeitado']);
export type StatusPagamento = z.infer<typeof StatusPagamentoSchema>;

export const StatusTransacaoExternaSchema = z.enum(['aprovado', 'rejeitado']);
export type StatusTransacaoExterna = z.infer<typeof StatusTransacaoExternaSchema>;

export const ResponsavelTaxaPagamentoSchema = z.literal('contribuinte');
export type ResponsavelTaxaPagamento = z.infer<typeof ResponsavelTaxaPagamentoSchema>;

export const SnapshotComposicaoValoresSchema = z.object({
  idContribuicao: IdContribuicaoPagamentoSchema,
  contributionAmountCents: MoneyCentsSchema,
  feeAmountCents: MoneyCentsSchema,
  totalPaidCents: MoneyCentsSchema,
  receiverAmountCents: MoneyCentsSchema,
  responsavelTaxa: ResponsavelTaxaPagamentoSchema,
});

export type SnapshotComposicaoValores = Readonly<z.infer<typeof SnapshotComposicaoValoresSchema>>;

export const IntencaoPagamentoSchema = z.object({
  id: IdIntencaoPagamentoSchema,
  idContribuicao: IdContribuicaoPagamentoSchema,
  amountCents: MoneyCentsSchema,
  metodo: MetodoPagamentoSchema,
  composicaoValores: SnapshotComposicaoValoresSchema,
  criadaEm: z.date(),
});

export type IntencaoPagamento = Readonly<z.infer<typeof IntencaoPagamentoSchema>>;

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

export const TipoEventoPagamentoSchema = z.enum([
  'payment.intent_created',
  'payment.approved',
  'payment.rejected',
]);
export type TipoEventoPagamento = z.infer<typeof TipoEventoPagamentoSchema>;

export const EventoPagamentoSchema = z.object({
  id: z.uuid(),
  tipo: TipoEventoPagamentoSchema,
  idPagamento: IdPagamentoSchema,
  idIntencaoPagamento: IdIntencaoPagamentoSchema,
  idContribuicao: IdContribuicaoPagamentoSchema,
  amountCents: MoneyCentsSchema,
  status: StatusPagamentoSchema,
  idTransacaoExterna: IdTransacaoExternaSchema.optional(),
  ocorridoEm: z.date(),
});

export type EventoPagamento = Readonly<z.infer<typeof EventoPagamentoSchema>>;

export const CriarIntencaoPagamentoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
  idIntencaoPagamento: IdIntencaoPagamentoSchema,
  composicaoValores: SnapshotComposicaoValoresSchema,
  valorACobrarCents: MoneyCentsSchema,
  metodo: MetodoPagamentoSchema,
});

export type CriarIntencaoPagamentoInput = z.infer<typeof CriarIntencaoPagamentoInputSchema>;

export const ComandoPagamentoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
});

export type ComandoPagamentoInput = z.infer<typeof ComandoPagamentoInputSchema>;

export interface CriarPagamentoPendenteInput {
  readonly idPagamento: IdPagamento;
  readonly idIntencaoPagamento: IdIntencaoPagamento;
  readonly composicaoValores: SnapshotComposicaoValores;
  readonly valorACobrarCents: MoneyCents;
  readonly metodo: MetodoPagamento;
  readonly criadoEm: Date;
}

export function criarPagamentoPendente(input: CriarPagamentoPendenteInput): Pagamento {
  const parsed = CriarIntencaoPagamentoInputSchema.extend({
    criadoEm: z.date(),
  }).parse(input);

  if (parsed.valorACobrarCents !== parsed.composicaoValores.totalPaidCents) {
    throw new Error('Valor do pagamento deve ser igual ao total pago na composicao de valores.');
  }

  const pagamento: Pagamento = {
    id: parsed.idPagamento,
    intencao: {
      id: parsed.idIntencaoPagamento,
      idContribuicao: parsed.composicaoValores.idContribuicao,
      amountCents: parsed.valorACobrarCents,
      metodo: parsed.metodo,
      composicaoValores: parsed.composicaoValores,
      criadaEm: parsed.criadoEm,
    },
    status: 'pendente',
    criadoEm: parsed.criadoEm,
    atualizadoEm: parsed.criadoEm,
  };

  return PagamentoSchema.parse(pagamento);
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
  const pagamentoParsed = PagamentoSchema.parse(pagamento);
  const transacaoParsed = TransacaoExternaSchema.parse(transacao);

  if (!podeAprovarPagamento(pagamentoParsed)) {
    throw new Error(
      `Pagamento "${pagamentoParsed.id}" nao pode ser aprovado a partir do status "${pagamento.status}".`,
    );
  }

  if (transacaoParsed.status !== 'aprovado') {
    throw new Error('Transacao externa deve estar aprovada para aprovar o pagamento.');
  }

  if (transacaoParsed.amountCents !== pagamentoParsed.intencao.amountCents) {
    throw new Error('Valor da transacao externa deve ser igual ao valor do pagamento.');
  }

  return PagamentoSchema.parse({
    ...pagamentoParsed,
    status: 'aprovado',
    transacaoExterna: transacaoParsed,
    atualizadoEm,
  });
}

export function rejeitarPagamentoPendente(
  pagamento: Pagamento,
  transacao: TransacaoExterna,
  atualizadoEm: Date,
): Pagamento {
  const pagamentoParsed = PagamentoSchema.parse(pagamento);
  const transacaoParsed = TransacaoExternaSchema.parse(transacao);

  if (!podeRejeitarPagamento(pagamentoParsed)) {
    throw new Error(
      `Pagamento "${pagamentoParsed.id}" nao pode ser rejeitado a partir do status "${pagamento.status}".`,
    );
  }

  if (transacaoParsed.status !== 'rejeitado') {
    throw new Error('Transacao externa deve estar rejeitada para rejeitar o pagamento.');
  }

  if (transacaoParsed.amountCents !== pagamentoParsed.intencao.amountCents) {
    throw new Error('Valor da transacao externa deve ser igual ao valor do pagamento.');
  }

  return PagamentoSchema.parse({
    ...pagamentoParsed,
    status: 'rejeitado',
    transacaoExterna: transacaoParsed,
    atualizadoEm,
  });
}

export function criarEventoPagamento(input: {
  readonly id: string;
  readonly tipo: TipoEventoPagamento;
  readonly pagamento: Pagamento;
  readonly ocorridoEm: Date;
}): EventoPagamento {
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
