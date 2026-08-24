/**
 * Deterministic fake for the PIX cobranca port.
 *
 * E2E magic values are deliberately OPT-IN (`e2eMagicOutcomes: true`):
 * - 1337 cents: the first charge consultation returns `concluida`.
 * - 1404 cents: the first charge consultation returns `removida` (expired/removed).
 * - 1422 cents: a refund request returns terminal `rejeitada`.
 *
 * With the flag disabled (the default), these are ordinary amounts. The fake
 * uses counters rather than ambient randomness, so its default IDs are stable
 * across runs.
 */
import type { MoneyCents } from '../../domain/money.js';
import type {
  CobrancaCriada,
  ConsultarCobrancaResult,
  ConsultarDevolucaoInput,
  CriarCobrancaInput,
  DevolucaoOutcome,
  PixCobrancaProvider,
  SolicitarDevolucaoInput,
} from './pix-cobranca-provider.js';

export const PIX_COBRANCA_FAKE_MAGIC_CENTS = {
  autoComplete: 1337,
  forceRemoved: 1404,
  refundRejected: 1422,
} as const;

export type ConsultarCobrancaFakeStep =
  | Exclude<ConsultarCobrancaResult, { status: 'concluida' }>
  | {
      readonly status: 'concluida';
      /** Omit to exercise the injected deterministic factory. */
      readonly e2eId?: string;
      /** Omit to reuse the charge amount. */
      readonly valorPagoCents?: MoneyCents;
      /** Omit to use the injected clock. */
      readonly horario?: Date;
    };

export interface PixCobrancaProviderFakeOptions {
  /** Script copied independently into every newly-created charge. Default: ativa. */
  readonly consultarCobrancaSequence?: readonly ConsultarCobrancaFakeStep[];
  /** Initial result of solicitarDevolucao. Default: em_processamento. */
  readonly solicitarDevolucaoOutcome?: DevolucaoOutcome;
  /** Script copied independently into every new refund. Default: devolvida. */
  readonly consultarDevolucaoSequence?: readonly DevolucaoOutcome[];
  readonly txidFactory?: (input: CriarCobrancaInput, ordinal: number) => string;
  readonly e2eIdFactory?: (txid: string, ordinal: number) => string;
  readonly rtrIdFactory?: (input: SolicitarDevolucaoInput, ordinal: number) => string;
  readonly clock?: () => Date;
  readonly expiracaoSeconds?: number;
  readonly pixCopiaEColaFactory?: (txid: string) => string;
  /** Explicit failure hook for callers testing create-infrastructure failures. */
  readonly criarCobrancaError?: Error;
  /** Explicit failure hook for callers testing refund-infrastructure failures. */
  readonly solicitarDevolucaoError?: Error;
  /** Enables the three documented fake-only magic cent values. Default false. */
  readonly e2eMagicOutcomes?: boolean;
}

interface CobrancaLedgerEntry {
  readonly input: CriarCobrancaInput;
  readonly result: CobrancaCriada;
  readonly consultScript: readonly ConsultarCobrancaFakeStep[];
  consultCursor: number;
  consultCalls: number;
  terminal?: ConsultarCobrancaResult;
}

interface DevolucaoLedgerEntry {
  readonly input: SolicitarDevolucaoInput;
  readonly result: DevolucaoOutcome;
  readonly consultScript: readonly DevolucaoOutcome[];
  consultCursor: number;
  consultCalls: number;
  terminal?: DevolucaoOutcome;
}

export interface PixCobrancaFakeCobrancaSnapshot {
  readonly input: CriarCobrancaInput;
  readonly result: CobrancaCriada;
  readonly consultas: number;
  readonly terminal?: ConsultarCobrancaResult;
}

export interface PixCobrancaFakeDevolucaoSnapshot {
  readonly input: SolicitarDevolucaoInput;
  readonly result: DevolucaoOutcome;
  readonly consultas: number;
  readonly terminal?: DevolucaoOutcome;
}

const DEFAULT_CHARGE_SCRIPT: readonly ConsultarCobrancaFakeStep[] = [{ status: 'ativa' }];
const DEFAULT_REFUND_SCRIPT: readonly DevolucaoOutcome[] = [{ status: 'devolvida' }];

function deterministicTxid(ordinal: number): string {
  return `FAKE${String(ordinal).padStart(28, '0')}`;
}

function deterministicE2eId(ordinal: number): string {
  return `E2EFAKE${String(ordinal).padStart(25, '0')}`;
}

function sameCobrancaPayload(left: CriarCobrancaInput, right: CriarCobrancaInput): boolean {
  return (
    left.idPagamento === right.idPagamento &&
    left.idIntencaoPagamento === right.idIntencaoPagamento &&
    left.amountCents === right.amountCents &&
    left.solicitacaoPagador === right.solicitacaoPagador
  );
}

function sameDevolucaoPayload(
  left: SolicitarDevolucaoInput,
  right: SolicitarDevolucaoInput,
): boolean {
  return (
    left.e2eId === right.e2eId &&
    left.idDevolucao === right.idDevolucao &&
    left.amountCents === right.amountCents &&
    left.descricao === right.descricao
  );
}

function cloneCobrancaInput(input: CriarCobrancaInput): CriarCobrancaInput {
  return { ...input };
}

function cloneDevolucaoInput(input: SolicitarDevolucaoInput): SolicitarDevolucaoInput {
  return { ...input };
}

function cloneCobrancaCriada(result: CobrancaCriada): CobrancaCriada {
  return { ...result, expiraEm: new Date(result.expiraEm.getTime()) };
}

function cloneConsultarCobrancaResult(result: ConsultarCobrancaResult): ConsultarCobrancaResult {
  return result.status === 'concluida'
    ? { ...result, horario: new Date(result.horario.getTime()) }
    : { ...result };
}

function cloneConsultarCobrancaFakeStep(
  step: ConsultarCobrancaFakeStep,
): ConsultarCobrancaFakeStep {
  return step.status === 'concluida' && step.horario !== undefined
    ? { ...step, horario: new Date(step.horario.getTime()) }
    : { ...step };
}

function cloneDevolucaoOutcome(outcome: DevolucaoOutcome): DevolucaoOutcome {
  return { ...outcome };
}

function isCobrancaTerminal(
  outcome: ConsultarCobrancaResult,
): outcome is Extract<ConsultarCobrancaResult, { status: 'concluida' | 'removida' }> {
  return outcome.status === 'concluida' || outcome.status === 'removida';
}

function isDevolucaoTerminal(outcome: DevolucaoOutcome): boolean {
  return outcome.status !== 'em_processamento';
}

/**
 * In-memory fake with two indexes for charges (`idPagamento` and `txid`) and a
 * refund ledger keyed by `(e2eId,idDevolucao)`. Retrying with the same identity
 * and payload returns an equal copy of the ledger-owned result; changing the
 * payload is a conflict. Callers and snapshots never receive mutable ledger
 * objects. This mirrors provider idempotency rather than silently accepting a
 * different operation under the same key.
 */
export class PixCobrancaProviderFake implements PixCobrancaProvider {
  private readonly chargeByPaymentId = new Map<string, CobrancaLedgerEntry>();
  private readonly chargeByTxid = new Map<string, CobrancaLedgerEntry>();
  private readonly refundByKey = new Map<string, DevolucaoLedgerEntry>();

  private readonly chargeScript: readonly ConsultarCobrancaFakeStep[];
  private readonly refundInitialOutcome: DevolucaoOutcome | undefined;
  private readonly refundScript: readonly DevolucaoOutcome[];
  private readonly txidFactory: (input: CriarCobrancaInput, ordinal: number) => string;
  private readonly e2eIdFactory: (txid: string, ordinal: number) => string;
  private readonly rtrIdFactory: (input: SolicitarDevolucaoInput, ordinal: number) => string;
  private readonly clock: () => Date;
  private readonly expiracaoSeconds: number;
  private readonly pixCopiaEColaFactory: (txid: string) => string;
  private readonly criarCobrancaError: Error | undefined;
  private readonly solicitarDevolucaoError: Error | undefined;
  private readonly e2eMagicOutcomes: boolean;

  private chargeOrdinal = 0;
  private e2eOrdinal = 0;
  private refundOrdinal = 0;
  private _criarCobrancaCalls = 0;
  private _consultarCobrancaCalls = 0;
  private _solicitarDevolucaoCalls = 0;
  private _consultarDevolucaoCalls = 0;

  constructor(options: PixCobrancaProviderFakeOptions = {}) {
    this.chargeScript = (options.consultarCobrancaSequence ?? DEFAULT_CHARGE_SCRIPT).map(
      cloneConsultarCobrancaFakeStep,
    );
    this.refundInitialOutcome =
      options.solicitarDevolucaoOutcome === undefined
        ? undefined
        : cloneDevolucaoOutcome(options.solicitarDevolucaoOutcome);
    this.refundScript = (options.consultarDevolucaoSequence ?? DEFAULT_REFUND_SCRIPT).map(
      cloneDevolucaoOutcome,
    );
    this.txidFactory = options.txidFactory ?? ((_input, ordinal) => deterministicTxid(ordinal));
    this.e2eIdFactory = options.e2eIdFactory ?? ((_txid, ordinal) => deterministicE2eId(ordinal));
    this.rtrIdFactory =
      options.rtrIdFactory ?? ((_input, ordinal) => `RTRFAKE${String(ordinal).padStart(25, '0')}`);
    this.clock = options.clock ?? (() => new Date('2026-01-01T00:00:00.000Z'));
    // Mirror the real Inter adapter's immediate-charge window. Downstream
    // checkout/countdown tests must not pass against an hour-long fake while
    // production expires the same charge after ten minutes.
    this.expiracaoSeconds = options.expiracaoSeconds ?? 600;
    this.pixCopiaEColaFactory =
      options.pixCopiaEColaFactory ?? ((txid) => `000201FAKE-PIX-${txid}`);
    this.criarCobrancaError = options.criarCobrancaError;
    this.solicitarDevolucaoError = options.solicitarDevolucaoError;
    this.e2eMagicOutcomes = options.e2eMagicOutcomes ?? false;
  }

  get criarCobrancaCalls(): number {
    return this._criarCobrancaCalls;
  }

  get consultarCobrancaCalls(): number {
    return this._consultarCobrancaCalls;
  }

  get solicitarDevolucaoCalls(): number {
    return this._solicitarDevolucaoCalls;
  }

  get consultarDevolucaoCalls(): number {
    return this._consultarDevolucaoCalls;
  }

  get cobrancas(): readonly PixCobrancaFakeCobrancaSnapshot[] {
    return [...this.chargeByPaymentId.values()].map((entry) => ({
      input: cloneCobrancaInput(entry.input),
      result: cloneCobrancaCriada(entry.result),
      consultas: entry.consultCalls,
      ...(entry.terminal ? { terminal: cloneConsultarCobrancaResult(entry.terminal) } : {}),
    }));
  }

  get devolucoes(): readonly PixCobrancaFakeDevolucaoSnapshot[] {
    return [...this.refundByKey.values()].map((entry) => ({
      input: cloneDevolucaoInput(entry.input),
      result: cloneDevolucaoOutcome(entry.result),
      consultas: entry.consultCalls,
      ...(entry.terminal ? { terminal: cloneDevolucaoOutcome(entry.terminal) } : {}),
    }));
  }

  async criarCobranca(input: CriarCobrancaInput): Promise<CobrancaCriada> {
    this._criarCobrancaCalls += 1;
    const replay = this.chargeByPaymentId.get(input.idPagamento);
    if (replay) {
      if (!sameCobrancaPayload(replay.input, input)) {
        throw new Error(`pix fake charge conflict for idPagamento ${input.idPagamento}`);
      }
      return cloneCobrancaCriada(replay.result);
    }
    if (this.criarCobrancaError) throw this.criarCobrancaError;

    this.chargeOrdinal += 1;
    const txid = this.txidFactory(input, this.chargeOrdinal);
    if (this.chargeByTxid.has(txid)) {
      throw new Error(`pix fake duplicate txid ${txid}`);
    }
    const now = this.clock();
    const result: CobrancaCriada = {
      txid,
      pixCopiaECola: this.pixCopiaEColaFactory(txid),
      expiraEm: new Date(now.getTime() + this.expiracaoSeconds * 1000),
    };
    const entry: CobrancaLedgerEntry = {
      // `readonly` is compile-time only. Keep an owned comparison baseline so
      // caller/snapshot mutation cannot rewrite idempotency history.
      input: cloneCobrancaInput(input),
      result: cloneCobrancaCriada(result),
      consultScript: [...this.chargeScript],
      consultCursor: 0,
      consultCalls: 0,
    };
    this.chargeByPaymentId.set(input.idPagamento, entry);
    this.chargeByTxid.set(txid, entry);
    return cloneCobrancaCriada(entry.result);
  }

  async consultarCobranca(txid: string): Promise<ConsultarCobrancaResult> {
    this._consultarCobrancaCalls += 1;
    const entry = this.chargeByTxid.get(txid);
    if (!entry) throw new Error(`pix fake charge not found for txid ${txid}`);
    entry.consultCalls += 1;
    if (entry.terminal) return cloneConsultarCobrancaResult(entry.terminal);

    let step: ConsultarCobrancaFakeStep;
    if (
      this.e2eMagicOutcomes &&
      entry.consultCursor === 0 &&
      entry.input.amountCents === PIX_COBRANCA_FAKE_MAGIC_CENTS.autoComplete
    ) {
      step = { status: 'concluida' };
    } else if (
      this.e2eMagicOutcomes &&
      entry.consultCursor === 0 &&
      entry.input.amountCents === PIX_COBRANCA_FAKE_MAGIC_CENTS.forceRemoved
    ) {
      step = { status: 'removida' };
    } else {
      const index = Math.min(entry.consultCursor, Math.max(0, entry.consultScript.length - 1));
      step = entry.consultScript[index] ?? { status: 'ativa' };
    }
    entry.consultCursor += 1;

    const outcome = this.materializeChargeStep(step, entry);
    if (isCobrancaTerminal(outcome)) {
      entry.terminal = cloneConsultarCobrancaResult(outcome);
    }
    return cloneConsultarCobrancaResult(outcome);
  }

  async solicitarDevolucao(input: SolicitarDevolucaoInput): Promise<DevolucaoOutcome> {
    this._solicitarDevolucaoCalls += 1;
    const key = this.refundKey(input.e2eId, input.idDevolucao);
    const replay = this.refundByKey.get(key);
    if (replay) {
      if (!sameDevolucaoPayload(replay.input, input)) {
        throw new Error(
          `pix fake refund conflict for e2eId ${input.e2eId} and idDevolucao ${input.idDevolucao}`,
        );
      }
      return cloneDevolucaoOutcome(replay.result);
    }
    if (this.solicitarDevolucaoError) throw this.solicitarDevolucaoError;

    this.refundOrdinal += 1;
    const result: DevolucaoOutcome =
      this.e2eMagicOutcomes && input.amountCents === PIX_COBRANCA_FAKE_MAGIC_CENTS.refundRejected
        ? { status: 'rejeitada', codigo: 'FAKE_MAGIC_REFUND_REJECTED' }
        : (this.refundInitialOutcome ?? {
            status: 'em_processamento',
            rtrId: this.rtrIdFactory(input, this.refundOrdinal),
          });
    const ownedResult = cloneDevolucaoOutcome(result);
    const entry: DevolucaoLedgerEntry = {
      input: cloneDevolucaoInput(input),
      result: ownedResult,
      consultScript: [...this.refundScript],
      consultCursor: 0,
      consultCalls: 0,
      ...(isDevolucaoTerminal(ownedResult) ? { terminal: cloneDevolucaoOutcome(ownedResult) } : {}),
    };
    this.refundByKey.set(key, entry);
    return cloneDevolucaoOutcome(ownedResult);
  }

  async consultarDevolucao(input: ConsultarDevolucaoInput): Promise<DevolucaoOutcome> {
    this._consultarDevolucaoCalls += 1;
    const entry = this.refundByKey.get(this.refundKey(input.e2eId, input.idDevolucao));
    if (!entry) {
      throw new Error(
        `pix fake refund not found for e2eId ${input.e2eId} and idDevolucao ${input.idDevolucao}`,
      );
    }
    if (entry.input.amountCents !== input.amountCents) {
      throw new Error('pix fake refund amount mismatch');
    }
    entry.consultCalls += 1;
    if (entry.terminal) return cloneDevolucaoOutcome(entry.terminal);

    const index = Math.min(entry.consultCursor, Math.max(0, entry.consultScript.length - 1));
    const outcome = cloneDevolucaoOutcome(entry.consultScript[index] ?? entry.result);
    entry.consultCursor += 1;
    if (isDevolucaoTerminal(outcome)) {
      entry.terminal = cloneDevolucaoOutcome(outcome);
    }
    return cloneDevolucaoOutcome(outcome);
  }

  private materializeChargeStep(
    step: ConsultarCobrancaFakeStep,
    entry: CobrancaLedgerEntry,
  ): ConsultarCobrancaResult {
    if (step.status !== 'concluida') return cloneConsultarCobrancaResult(step);
    this.e2eOrdinal += 1;
    return {
      status: 'concluida',
      e2eId: step.e2eId ?? this.e2eIdFactory(entry.result.txid, this.e2eOrdinal),
      valorPagoCents: step.valorPagoCents ?? entry.input.amountCents,
      horario: step.horario ?? this.clock(),
    };
  }

  private refundKey(e2eId: string, idDevolucao: string): string {
    // Length-prefixing makes the pair unambiguous even if values contain separators.
    return `${e2eId.length}:${e2eId}${idDevolucao.length}:${idDevolucao}`;
  }
}
