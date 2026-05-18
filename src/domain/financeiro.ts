import { z } from 'zod/v4';
import { MoneyCentsSchema } from './money.js';

export const IdLancamentoFinanceiroSchema = z.uuid();
export type IdLancamentoFinanceiro = z.infer<typeof IdLancamentoFinanceiroSchema>;

export const IdPagamentoReferenciaSchema = z.uuid();
export type IdPagamentoReferencia = z.infer<typeof IdPagamentoReferenciaSchema>;

export const IdContribuicaoReferenciaSchema = z.uuid();
export type IdContribuicaoReferencia = z.infer<typeof IdContribuicaoReferenciaSchema>;

export const IdRecebedorFinanceiroSchema = z.uuid();
export type IdRecebedorFinanceiro = z.infer<typeof IdRecebedorFinanceiroSchema>;

export const IdRepasseSchema = z.uuid();
export type IdRepasse = z.infer<typeof IdRepasseSchema>;

export const SaldoCentavosSchema = z.number().int().min(0);
export type SaldoCentavos = z.infer<typeof SaldoCentavosSchema>;

export const StatusPagamentoFinanceiroSchema = z.enum(['pendente', 'aprovado', 'rejeitado']);
export type StatusPagamentoFinanceiro = z.infer<typeof StatusPagamentoFinanceiroSchema>;

export const ResponsavelTaxaFinanceiroSchema = z.literal('contribuinte');
export type ResponsavelTaxaFinanceiro = z.infer<typeof ResponsavelTaxaFinanceiroSchema>;

export const SnapshotComposicaoValoresFinanceiroSchema = z.object({
  contributionAmountCents: MoneyCentsSchema,
  feeAmountCents: MoneyCentsSchema,
  totalPaidCents: MoneyCentsSchema,
  receiverAmountCents: MoneyCentsSchema,
  responsavelTaxa: ResponsavelTaxaFinanceiroSchema,
});

export type SnapshotComposicaoValoresFinanceiro = Readonly<
  z.infer<typeof SnapshotComposicaoValoresFinanceiroSchema>
>;

export const RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema = z.object({
  idPagamento: IdPagamentoReferenciaSchema,
  idContribuicao: IdContribuicaoReferenciaSchema,
  idRecebedor: IdRecebedorFinanceiroSchema,
  statusPagamento: StatusPagamentoFinanceiroSchema,
  composicaoValores: SnapshotComposicaoValoresFinanceiroSchema,
});

export type RegistrarEfeitosFinanceirosPagamentoAprovadoInput = Readonly<
  z.infer<typeof RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema>
>;

export const TipoLancamentoFinanceiroSchema = z.enum([
  'credito_saldo_recebedor',
  'credito_receita_plataforma',
]);
export type TipoLancamentoFinanceiro = z.infer<typeof TipoLancamentoFinanceiroSchema>;

export const StatusLancamentoSchema = z.enum(['pendente', 'disponivel']);
export type StatusLancamento = z.infer<typeof StatusLancamentoSchema>;

export const LancamentoFinanceiroSchema = z.object({
  id: IdLancamentoFinanceiroSchema,
  idPagamento: IdPagamentoReferenciaSchema,
  idContribuicao: IdContribuicaoReferenciaSchema,
  idRecebedor: IdRecebedorFinanceiroSchema.optional(),
  tipo: TipoLancamentoFinanceiroSchema,
  amountCents: MoneyCentsSchema,
  status: StatusLancamentoSchema,
  criadoEm: z.date(),
});

export type LancamentoFinanceiro = Readonly<z.infer<typeof LancamentoFinanceiroSchema>>;

export const SaldoRecebedorSchema = z.object({
  idRecebedor: IdRecebedorFinanceiroSchema,
  valorPendenteCents: SaldoCentavosSchema,
  valorDisponivelCents: SaldoCentavosSchema,
});

export type SaldoRecebedor = Readonly<z.infer<typeof SaldoRecebedorSchema>>;

export const ObterSaldoRecebedorInputSchema = z.object({
  idRecebedor: IdRecebedorFinanceiroSchema,
});

export type ObterSaldoRecebedorInput = Readonly<z.infer<typeof ObterSaldoRecebedorInputSchema>>;

export const ReceitaPlataformaSchema = z.object({
  totalAmountCents: SaldoCentavosSchema,
});

export type ReceitaPlataforma = Readonly<z.infer<typeof ReceitaPlataformaSchema>>;

export const IdsLancamentosFinanceirosSchema = z.object({
  idLancamentoRecebedor: IdLancamentoFinanceiroSchema,
  idLancamentoReceitaPlataforma: IdLancamentoFinanceiroSchema,
});

export type IdsLancamentosFinanceiros = Readonly<z.infer<typeof IdsLancamentosFinanceirosSchema>>;

export const SolicitarRepasseRecebedorInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  idRecebedor: IdRecebedorFinanceiroSchema,
  amountCents: MoneyCentsSchema,
});

export type SolicitarRepasseRecebedorInput = Readonly<
  z.infer<typeof SolicitarRepasseRecebedorInputSchema>
>;

export const StatusRepasseSchema = z.literal('solicitado');
export type StatusRepasse = z.infer<typeof StatusRepasseSchema>;

export const RepasseRecebedorSchema = z.object({
  id: IdRepasseSchema,
  idRecebedor: IdRecebedorFinanceiroSchema,
  amountCents: MoneyCentsSchema,
  status: StatusRepasseSchema,
  solicitadoEm: z.date(),
});

export type RepasseRecebedor = Readonly<z.infer<typeof RepasseRecebedorSchema>>;

export function validarComposicaoFinanceiraPagamentoAprovado(
  input: RegistrarEfeitosFinanceirosPagamentoAprovadoInput,
): void {
  const parsed = RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema.parse(input);

  if (parsed.statusPagamento !== 'aprovado') {
    throw new Error('Apenas pagamentos aprovados podem gerar lancamentos financeiros.');
  }

  const { contributionAmountCents, feeAmountCents, receiverAmountCents, totalPaidCents } =
    parsed.composicaoValores;

  if (receiverAmountCents + feeAmountCents !== totalPaidCents) {
    throw new Error('Composicao de valores financeira nao confere com o total pago.');
  }

  if (receiverAmountCents !== contributionAmountCents) {
    throw new Error(
      'Valor destinado ao recebedor deve ser igual ao valor da contribuicao quando a taxa e paga pelo contribuinte.',
    );
  }
}

export function criarLancamentosParaPagamentoAprovado(
  input: RegistrarEfeitosFinanceirosPagamentoAprovadoInput,
  idsLancamentos: IdsLancamentosFinanceiros,
  criadoEm: Date,
): readonly [LancamentoFinanceiro, LancamentoFinanceiro] {
  const inputParsed = RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema.parse(input);
  const idsParsed = IdsLancamentosFinanceirosSchema.parse(idsLancamentos);
  validarComposicaoFinanceiraPagamentoAprovado(inputParsed);

  const lancamentoRecebedor = LancamentoFinanceiroSchema.parse({
    id: idsParsed.idLancamentoRecebedor,
    idPagamento: inputParsed.idPagamento,
    idContribuicao: inputParsed.idContribuicao,
    idRecebedor: inputParsed.idRecebedor,
    tipo: 'credito_saldo_recebedor',
    amountCents: inputParsed.composicaoValores.receiverAmountCents,
    status: 'pendente',
    criadoEm,
  });

  const lancamentoReceita = LancamentoFinanceiroSchema.parse({
    id: idsParsed.idLancamentoReceitaPlataforma,
    idPagamento: inputParsed.idPagamento,
    idContribuicao: inputParsed.idContribuicao,
    tipo: 'credito_receita_plataforma',
    amountCents: inputParsed.composicaoValores.feeAmountCents,
    status: 'disponivel',
    criadoEm,
  });

  return [lancamentoRecebedor, lancamentoReceita];
}

export function calcularSaldoRecebedor(
  idRecebedor: IdRecebedorFinanceiro,
  lancamentos: readonly LancamentoFinanceiro[],
): SaldoRecebedor {
  const idParsed = IdRecebedorFinanceiroSchema.parse(idRecebedor);
  const lancamentosRecebedor = lancamentos
    .map((l) => LancamentoFinanceiroSchema.parse(l))
    .filter((l) => l.tipo === 'credito_saldo_recebedor' && l.idRecebedor === idParsed);

  const valorPendenteCents = lancamentosRecebedor
    .filter((l) => l.status === 'pendente')
    .reduce<SaldoCentavos>((total, l) => total + l.amountCents, 0);

  const valorDisponivelCents = lancamentosRecebedor
    .filter((l) => l.status === 'disponivel')
    .reduce<SaldoCentavos>((total, l) => total + l.amountCents, 0);

  return SaldoRecebedorSchema.parse({
    idRecebedor: idParsed,
    valorPendenteCents,
    valorDisponivelCents,
  });
}

export function calcularReceitaPlataforma(
  lancamentos: readonly LancamentoFinanceiro[],
): ReceitaPlataforma {
  const totalAmountCents = lancamentos
    .map((l) => LancamentoFinanceiroSchema.parse(l))
    .filter((l) => l.tipo === 'credito_receita_plataforma')
    .reduce<SaldoCentavos>((total, l) => total + l.amountCents, 0);

  return ReceitaPlataformaSchema.parse({ totalAmountCents });
}

export function criarRepasseRecebedorSolicitado(
  input: SolicitarRepasseRecebedorInput,
  solicitadoEm: Date,
): RepasseRecebedor {
  const parsed = SolicitarRepasseRecebedorInputSchema.parse(input);

  return RepasseRecebedorSchema.parse({
    id: parsed.idRepasse,
    idRecebedor: parsed.idRecebedor,
    amountCents: parsed.amountCents,
    status: 'solicitado',
    solicitadoEm,
  });
}
