import type { IdPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import { PaymentMoneyMovementMemoryCoordinator } from './payment-money-movement-lock.memory.js';
import {
  type CreatePixCobrancaDevolucaoInput,
  PixCobrancaDevolucaoConflictError,
  type PixCobrancaDevolucaoIdentity,
  type PixCobrancaDevolucaoRecord,
  type PixCobrancaDevolucaoRepository,
  parseCreatePixCobrancaDevolucaoInput,
  parsePixCobrancaDevolucaoIdentity,
  parseUpdatePixCobrancaDevolucaoOutcomeInput,
  pixCobrancaDevolucaoBindingMatches,
  type UpdatePixCobrancaDevolucaoOutcomeInput,
} from './pix-cobranca-devolucao-repository.js';

function copyRecord(record: PixCobrancaDevolucaoRecord): PixCobrancaDevolucaoRecord {
  return {
    ...record,
    criadoEm: new Date(record.criadoEm),
    atualizadoEm: new Date(record.atualizadoEm),
  };
}

export class PixCobrancaDevolucaoRepositoryMemory implements PixCobrancaDevolucaoRepository {
  private readonly byPagamentoId = new Map<IdPagamento, PixCobrancaDevolucaoRecord>();
  private readonly byIdentity = new Map<string, PixCobrancaDevolucaoRecord>();

  constructor(private readonly moneyMovement = new PaymentMoneyMovementMemoryCoordinator()) {
    this.moneyMovement.registerRefundBlockerProbe((idPagamento) => {
      const record = this.byPagamentoId.get(idPagamento);
      return record?.status === 'em_processamento' || record?.status === 'devolvida';
    });
  }

  async createIfAbsent(
    rawInput: CreatePixCobrancaDevolucaoInput,
  ): Promise<{ readonly record: PixCobrancaDevolucaoRecord; readonly created: boolean }> {
    const input = parseCreatePixCobrancaDevolucaoInput(rawInput);
    return this.moneyMovement.withRefundCreationLock(input.idPagamento, () => {
      const identityKey = this.identityKey(input.e2eId, input.idDevolucao);
      const byPayment = this.byPagamentoId.get(input.idPagamento);
      const byIdentity = this.byIdentity.get(identityKey);
      const existing = byPayment ?? byIdentity;

      if (existing !== undefined) {
        if (
          !pixCobrancaDevolucaoBindingMatches(existing, input) ||
          (byPayment !== undefined && byIdentity !== undefined && byPayment.id !== byIdentity.id)
        ) {
          throw new PixCobrancaDevolucaoConflictError();
        }
        return { record: copyRecord(existing), created: false };
      }

      const created: PixCobrancaDevolucaoRecord = {
        ...input,
        status: 'em_processamento',
        rtrId: null,
        criadoEm: new Date(input.criadoEm),
        atualizadoEm: new Date(input.criadoEm),
      };
      this.byPagamentoId.set(created.idPagamento, created);
      this.byIdentity.set(identityKey, created);
      return { record: copyRecord(created), created: true };
    });
  }

  async findByIdentity(
    e2eId: string,
    idDevolucao: string,
  ): Promise<PixCobrancaDevolucaoRecord | undefined> {
    const identity = parsePixCobrancaDevolucaoIdentity(e2eId, idDevolucao);
    const record = this.byIdentity.get(this.identityKey(identity.e2eId, identity.idDevolucao));
    return record === undefined ? undefined : copyRecord(record);
  }

  async findByPagamentoId(
    idPagamento: IdPagamento,
  ): Promise<PixCobrancaDevolucaoRecord | undefined> {
    const record = this.byPagamentoId.get(idPagamento);
    return record === undefined ? undefined : copyRecord(record);
  }

  async updateOutcome(
    rawInput: UpdatePixCobrancaDevolucaoOutcomeInput,
  ): Promise<PixCobrancaDevolucaoRecord | undefined> {
    const input = parseUpdatePixCobrancaDevolucaoOutcomeInput(rawInput);
    const identityKey = this.identityKey(input.e2eId, input.idDevolucao);
    const existing = this.byIdentity.get(identityKey);
    if (existing === undefined) return undefined;
    if (existing.status !== 'em_processamento' && existing.status !== input.status) {
      return copyRecord(existing);
    }

    const updated: PixCobrancaDevolucaoRecord = {
      ...existing,
      status: input.status,
      rtrId: input.rtrId === undefined ? existing.rtrId : input.rtrId,
      atualizadoEm: new Date(
        Math.max(existing.atualizadoEm.getTime(), input.atualizadoEm.getTime()),
      ),
    };
    this.byIdentity.set(identityKey, updated);
    this.byPagamentoId.set(updated.idPagamento, updated);
    return copyRecord(updated);
  }

  async deleteIfPending(identity: PixCobrancaDevolucaoIdentity): Promise<boolean> {
    const parsed = parsePixCobrancaDevolucaoIdentity(identity.e2eId, identity.idDevolucao);
    const identityKey = this.identityKey(parsed.e2eId, parsed.idDevolucao);
    const existing = this.byIdentity.get(identityKey);
    if (
      existing === undefined ||
      existing.status !== 'em_processamento' ||
      existing.rtrId !== null
    ) {
      return false;
    }
    this.byIdentity.delete(identityKey);
    this.byPagamentoId.delete(existing.idPagamento);
    return true;
  }

  private identityKey(e2eId: string, idDevolucao: string): string {
    return `${e2eId}\0${idDevolucao}`;
  }
}
