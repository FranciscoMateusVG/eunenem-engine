import type { MoneyCents } from '../../domain/money.js';
import type {
  IdIntencaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';

/** Input for one deterministic Banco Inter immediate PIX charge. */
export interface CriarCobrancaInput {
  readonly idPagamento: IdPagamento;
  readonly idIntencaoPagamento: IdIntencaoPagamento;
  readonly amountCents: MoneyCents;
  readonly solicitacaoPagador?: string;
}

export interface CobrancaCriada {
  readonly txid: string;
  readonly pixCopiaECola: string;
  readonly expiraEm: Date;
}

export type ConsultarCobrancaResult =
  | { readonly status: 'ativa' }
  | {
      readonly status: 'concluida';
      readonly e2eId: string;
      readonly valorPagoCents: MoneyCents;
      readonly horario: Date;
    }
  | { readonly status: 'removida' }
  | { readonly status: 'desconhecido'; readonly statusBruto: string };

export interface SolicitarDevolucaoInput {
  readonly e2eId: string;
  /** Stable, caller-generated idempotency key (one key per refund intent). */
  readonly idDevolucao: string;
  readonly amountCents: MoneyCents;
  readonly descricao?: string;
}

/** Trusted persisted identity expected from one authoritative refund GET. */
export interface ConsultarDevolucaoInput {
  readonly e2eId: string;
  readonly idDevolucao: string;
  readonly amountCents: MoneyCents;
}

export type DevolucaoOutcome =
  | { readonly status: 'em_processamento'; readonly rtrId: string }
  | { readonly status: 'devolvida' }
  | { readonly status: 'nao_realizada'; readonly motivo?: string }
  | { readonly status: 'rejeitada'; readonly codigo: string };

export interface PixCobrancaProvider {
  criarCobranca(input: CriarCobrancaInput): Promise<CobrancaCriada>;
  consultarCobranca(txid: string): Promise<ConsultarCobrancaResult>;
  solicitarDevolucao(input: SolicitarDevolucaoInput): Promise<DevolucaoOutcome>;
  consultarDevolucao(input: ConsultarDevolucaoInput): Promise<DevolucaoOutcome>;
}

/**
 * Definitely safe to retry. No non-idempotent money-out request can have
 * reached Inter (or the operation is an idempotent/read-only cobrança call).
 */
export class PixCobrancaTransitoriaError extends Error {
  readonly _tag = 'PixCobrancaTransitoriaError';

  constructor(message: string) {
    super(message);
    this.name = 'PixCobrancaTransitoriaError';
  }
}

/**
 * A devolução may have reached Inter, or Inter returned a successful response
 * whose state we cannot prove. Reconcile by GET before attempting another PUT.
 */
export class PixCobrancaAmbiguaError extends Error {
  readonly _tag = 'PixCobrancaAmbiguaError';

  constructor(message: string) {
    super(message);
    this.name = 'PixCobrancaAmbiguaError';
  }
}
