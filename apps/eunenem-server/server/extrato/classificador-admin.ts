/**
 * Classificador admin de lançamentos do recebedor (aperture-5jk8y).
 *
 * Plano aperture-owmqs A1.3 com as correções do contrato revisado
 * (QA lgcgzk/uj1r5f, decisão root tyc1uv):
 *
 *   - Grão = linha do ledger `credito_saldo_recebedor`.
 *   - Fatos EXPLÍCITOS entram (inclusive `estornoAtivo` e
 *     `disponivelCanonico`, calculados pelos predicados canônicos da branch
 *     na consulta em lote). Nada aqui infere estorno por ausência.
 *   - A elegibilidade para "recebido confirmado" é calculada SEPARADA do
 *     bucket: pagamento aprovado ∧ sem `cancelado_em`. Buckets fora do
 *     recebido (`estornado`, `anomalia`) são exatamente o complemento.
 *   - Precedência EXCLUSIVA, primeira regra vence (ver classificarBucketAdmin).
 *
 * Puro: sem I/O, sem relógio implícito (`now` é argumento).
 */

export type BucketAdmin =
  | "disponivel"
  | "aguardando_liberacao"
  | "aguardando_transferencia"
  | "transferencia_falhou"
  | "enviado_ao_banco"
  | "transferido"
  | "estorno_em_andamento"
  | "inconsistente"
  | "estornado"
  | "anomalia";

export const BUCKETS_ADMIN: readonly BucketAdmin[] = [
  "disponivel",
  "aguardando_liberacao",
  "aguardando_transferencia",
  "transferencia_falhou",
  "enviado_ao_banco",
  "transferido",
  "estorno_em_andamento",
  "inconsistente",
  "estornado",
  "anomalia",
];

/** Buckets que compõem `recebidoConfirmado` (partição das linhas elegíveis). */
export const BUCKETS_ELEGIVEIS_RECEBIDO: ReadonlySet<BucketAdmin> = new Set<BucketAdmin>([
  "disponivel",
  "aguardando_liberacao",
  "aguardando_transferencia",
  "transferencia_falhou",
  "enviado_ao_banco",
  "transferido",
  "estorno_em_andamento",
  "inconsistente",
]);

export type MotivoClassificacao =
  // anomalia (fora do recebido)
  | "transferido_e_cancelado"
  | "pagamento_ausente"
  | "pagamento_nao_aprovado"
  // inconsistente (dentro do recebido, pendente de conferência)
  | "repasse_pago_sem_transferido"
  | "repasse_ausente"
  | "repasse_cancelado_com_vinculo"
  | "repasse_status_desconhecido"
  | "excluido_pela_guarda_canonica";

export interface FatosLancamentoAdmin {
  readonly idLancamento: string;
  readonly amountCents: number;
  readonly transferidoEm: Date | null;
  readonly canceladoEm: Date | null;
  readonly idRepasse: string | null;
  /** Status persistido do repasse vinculado; null quando não há vínculo ou o repasse não foi encontrado. */
  readonly repasseStatus: string | null;
  /** Status persistido do pagamento pai; null quando o pagamento não foi encontrado. */
  readonly pagamentoStatus: string | null;
  /** `pagamentos.intencao_balance_transaction_available_on`. */
  readonly availableOn: Date | null;
  /** Predicado canônico de estorno ativo da branch (devolução PIX em_processamento|devolvida; refund-op em main). */
  readonly estornoAtivo: boolean;
  /** Predicado canônico completo de disponibilidade da branch (mesma SQL que alimenta SOLICITAR). */
  readonly disponivelCanonico: boolean;
}

export interface ClassificacaoAdmin {
  readonly bucket: BucketAdmin;
  readonly motivo: MotivoClassificacao | null;
  readonly elegivelRecebido: boolean;
}

const REPASSE_AGUARDANDO_TRANSFERENCIA: ReadonlySet<string> = new Set([
  "solicitado",
  "aprovado",
  "transferindo",
  "verificando",
]);

/**
 * Elegibilidade para "recebido confirmado", independente do bucket:
 * pagamento aprovado e nenhum cancelamento persistido. Um estorno EM
 * ANDAMENTO não remove elegibilidade (o dinheiro ainda está no ledger);
 * um pagamento não aprovado nunca ganha recebido por existir no ledger.
 */
export function elegivelParaRecebido(f: FatosLancamentoAdmin): boolean {
  return f.pagamentoStatus === "aprovado" && f.canceladoEm === null;
}

export function classificarBucketAdmin(
  f: FatosLancamentoAdmin,
  now: Date,
): ClassificacaoAdmin {
  const elegivelRecebido = elegivelParaRecebido(f);

  // 1. Carimbos contraditórios: nunca resgatado, nunca estornado "limpo".
  if (f.transferidoEm !== null && f.canceladoEm !== null) {
    return { bucket: "anomalia", motivo: "transferido_e_cancelado", elegivelRecebido };
  }
  // 2. Estorno já efetivado.
  if (f.canceladoEm !== null) {
    return { bucket: "estornado", motivo: null, elegivelRecebido };
  }
  // 3. Ledger sem pagamento aprovado por trás: anomalia visível, fora do recebido.
  if (f.pagamentoStatus === null) {
    return { bucket: "anomalia", motivo: "pagamento_ausente", elegivelRecebido };
  }
  if (f.pagamentoStatus !== "aprovado") {
    return { bucket: "anomalia", motivo: "pagamento_nao_aprovado", elegivelRecebido };
  }
  // 4. Transferência concluída (carimbo do ledger é autoritativo; status do repasse é glosa).
  if (f.transferidoEm !== null) {
    return { bucket: "transferido", motivo: null, elegivelRecebido };
  }
  // 5. Estorno em andamento vence repasse e liberação: não disponível, não estornado.
  if (f.estornoAtivo) {
    return { bucket: "estorno_em_andamento", motivo: null, elegivelRecebido };
  }
  // 6. Reivindicado por um repasse.
  if (f.idRepasse !== null) {
    const s = f.repasseStatus;
    if (s === null) {
      return { bucket: "inconsistente", motivo: "repasse_ausente", elegivelRecebido };
    }
    if (s === "pago") {
      return { bucket: "inconsistente", motivo: "repasse_pago_sem_transferido", elegivelRecebido };
    }
    if (s === "cancelado") {
      return { bucket: "inconsistente", motivo: "repasse_cancelado_com_vinculo", elegivelRecebido };
    }
    if (s === "falhou") {
      return { bucket: "transferencia_falhou", motivo: null, elegivelRecebido };
    }
    if (s === "enviado_ao_banco") {
      return { bucket: "enviado_ao_banco", motivo: null, elegivelRecebido };
    }
    if (REPASSE_AGUARDANDO_TRANSFERENCIA.has(s)) {
      return { bucket: "aguardando_transferencia", motivo: null, elegivelRecebido };
    }
    return { bucket: "inconsistente", motivo: "repasse_status_desconhecido", elegivelRecebido };
  }
  // 7. Provedor ainda não liberou (null NÃO prova disponibilidade).
  if (f.availableOn === null || f.availableOn.getTime() > now.getTime()) {
    return { bucket: "aguardando_liberacao", motivo: null, elegivelRecebido };
  }
  // 8. A guarda canônica da branch excluiu sem estorno conhecido: evidente, não disponível.
  if (!f.disponivelCanonico) {
    return { bucket: "inconsistente", motivo: "excluido_pela_guarda_canonica", elegivelRecebido };
  }
  // 9.
  return { bucket: "disponivel", motivo: null, elegivelRecebido };
}

export interface TotaisAdmin {
  /** Σ amount das linhas elegíveis (aprovado ∧ sem cancelado_em), calculado sem olhar buckets. */
  readonly recebidoConfirmadoCents: number;
  readonly disponivelCents: number;
  readonly aguardandoLiberacaoCents: number;
  readonly aguardandoTransferenciaCents: number;
  readonly transferenciaFalhouCents: number;
  /** aguardandoTransferencia + transferenciaFalhou (agrupador de UI). */
  readonly emTransferenciaCents: number;
  readonly enviadoAoBancoCents: number;
  readonly transferidoCents: number;
  /** = transferidoCents (só transferido_em; anomalias nunca entram). */
  readonly resgatadoConcluidoCents: number;
  readonly estornoEmAndamentoCents: number;
  readonly inconsistenteCents: number;
  /** estornoEmAndamento + inconsistente (agrupador de UI, dentro do recebido). */
  readonly pendenteConferenciaCents: number;
  /** Fora do recebido. */
  readonly estornadoCents: number;
  readonly estornadoCount: number;
  /** Fora do recebido, visível. */
  readonly anomaliaCents: number;
  readonly anomaliaCount: number;
  readonly lancamentosCount: number;
}

export const TOTAIS_ADMIN_ZERO: TotaisAdmin = {
  recebidoConfirmadoCents: 0,
  disponivelCents: 0,
  aguardandoLiberacaoCents: 0,
  aguardandoTransferenciaCents: 0,
  transferenciaFalhouCents: 0,
  emTransferenciaCents: 0,
  enviadoAoBancoCents: 0,
  transferidoCents: 0,
  resgatadoConcluidoCents: 0,
  estornoEmAndamentoCents: 0,
  inconsistenteCents: 0,
  pendenteConferenciaCents: 0,
  estornadoCents: 0,
  estornadoCount: 0,
  anomaliaCents: 0,
  anomaliaCount: 0,
  lancamentosCount: 0,
};

/**
 * Agrega totais sobre um conjunto de linhas. Cada `idLancamento` conta
 * uma única vez (dedup defensivo: uma campanha nunca soma duas vezes).
 * `recebidoConfirmadoCents` vem da elegibilidade, não da soma dos buckets;
 * a igualdade entre os dois é o invariante que os testes verificam.
 */
export function agregarTotaisAdmin(
  linhas: readonly FatosLancamentoAdmin[],
  now: Date,
): TotaisAdmin {
  const vistos = new Set<string>();
  const acc = {
    recebido: 0,
    disponivel: 0,
    aguardandoLiberacao: 0,
    aguardandoTransferencia: 0,
    transferenciaFalhou: 0,
    enviadoAoBanco: 0,
    transferido: 0,
    estornoEmAndamento: 0,
    inconsistente: 0,
    estornado: 0,
    estornadoCount: 0,
    anomalia: 0,
    anomaliaCount: 0,
    count: 0,
  };

  for (const f of linhas) {
    if (vistos.has(f.idLancamento)) continue;
    vistos.add(f.idLancamento);
    acc.count += 1;

    if (elegivelParaRecebido(f)) acc.recebido += f.amountCents;

    const { bucket } = classificarBucketAdmin(f, now);
    switch (bucket) {
      case "disponivel":
        acc.disponivel += f.amountCents;
        break;
      case "aguardando_liberacao":
        acc.aguardandoLiberacao += f.amountCents;
        break;
      case "aguardando_transferencia":
        acc.aguardandoTransferencia += f.amountCents;
        break;
      case "transferencia_falhou":
        acc.transferenciaFalhou += f.amountCents;
        break;
      case "enviado_ao_banco":
        acc.enviadoAoBanco += f.amountCents;
        break;
      case "transferido":
        acc.transferido += f.amountCents;
        break;
      case "estorno_em_andamento":
        acc.estornoEmAndamento += f.amountCents;
        break;
      case "inconsistente":
        acc.inconsistente += f.amountCents;
        break;
      case "estornado":
        acc.estornado += f.amountCents;
        acc.estornadoCount += 1;
        break;
      case "anomalia":
        acc.anomalia += f.amountCents;
        acc.anomaliaCount += 1;
        break;
    }
  }

  return {
    recebidoConfirmadoCents: acc.recebido,
    disponivelCents: acc.disponivel,
    aguardandoLiberacaoCents: acc.aguardandoLiberacao,
    aguardandoTransferenciaCents: acc.aguardandoTransferencia,
    transferenciaFalhouCents: acc.transferenciaFalhou,
    emTransferenciaCents: acc.aguardandoTransferencia + acc.transferenciaFalhou,
    enviadoAoBancoCents: acc.enviadoAoBanco,
    transferidoCents: acc.transferido,
    resgatadoConcluidoCents: acc.transferido,
    estornoEmAndamentoCents: acc.estornoEmAndamento,
    inconsistenteCents: acc.inconsistente,
    pendenteConferenciaCents: acc.estornoEmAndamento + acc.inconsistente,
    estornadoCents: acc.estornado,
    estornadoCount: acc.estornadoCount,
    anomaliaCents: acc.anomalia,
    anomaliaCount: acc.anomaliaCount,
    lancamentosCount: acc.count,
  };
}
