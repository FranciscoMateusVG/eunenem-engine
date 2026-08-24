import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CreatePixCobrancaDevolucaoInput,
  PixCobrancaDevolucaoRepository,
} from '../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.js';
import { PixCobrancaDevolucaoConflictError } from '../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.js';
import type { IdPagamento } from '../../src/domain/pagamentos/value-objects/ids.js';

interface ConformanceOptions {
  readonly factory:
    | (() => PixCobrancaDevolucaoRepository)
    | (() => Promise<PixCobrancaDevolucaoRepository>);
  readonly resetState?: () => Promise<void>;
  /** Postgres uses this hook to satisfy the refund table's payment FK. */
  readonly preparePagamento?: (idPagamento: IdPagamento) => Promise<void>;
}

const REFUND_ID = 'RefundIdAlphaNumeric00000001';
const OTHER_REFUND_ID = 'RefundIdAlphaNumeric00000002';

function makeInput(
  overrides: Partial<CreatePixCobrancaDevolucaoInput> = {},
): CreatePixCobrancaDevolucaoInput {
  return {
    id: randomUUID(),
    idPagamento: randomUUID(),
    e2eId: 'E1234567890123456789012345678901',
    idDevolucao: REFUND_ID,
    amountCents: 1500,
    criadoEm: new Date('2026-08-05T12:00:00.000Z'),
    ...overrides,
  };
}

export function describePixCobrancaDevolucaoRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`PixCobrancaDevolucaoRepository conformance — ${name}`, () => {
    let repository: PixCobrancaDevolucaoRepository;

    beforeEach(async () => {
      await options.resetState?.();
      repository = await options.factory();
    });

    async function prepare(input: CreatePixCobrancaDevolucaoInput): Promise<void> {
      await options.preparePagamento?.(input.idPagamento);
    }

    it('atomically creates the initial em_processamento row and returns canonical replays', async () => {
      const input = makeInput();
      await prepare(input);

      const [first, replay] = await Promise.all([
        repository.createIfAbsent(input),
        repository.createIfAbsent({
          ...input,
          id: randomUUID(),
          criadoEm: new Date('2026-08-05T12:01:00.000Z'),
        }),
      ]);

      expect([first.created, replay.created].sort()).toEqual([false, true]);
      const canonical = first.created ? first.record : replay.record;
      const repeated = first.created ? replay.record : first.record;
      expect(canonical).toMatchObject({
        idPagamento: input.idPagamento,
        e2eId: input.e2eId,
        idDevolucao: input.idDevolucao,
        amountCents: 1500,
        status: 'em_processamento',
        rtrId: null,
      });
      expect(repeated).toEqual(canonical);
      expect(canonical.atualizadoEm).toEqual(canonical.criadoEm);
    });

    it('rejects collisions whose payment/identity/amount binding differs', async () => {
      const original = makeInput();
      await prepare(original);
      await repository.createIfAbsent(original);

      await expect(
        repository.createIfAbsent({
          ...makeInput(),
          idPagamento: original.idPagamento,
          e2eId: 'E2234567890123456789012345678901',
          idDevolucao: OTHER_REFUND_ID,
        }),
      ).rejects.toBeInstanceOf(PixCobrancaDevolucaoConflictError);

      const otherPayment = makeInput({
        e2eId: original.e2eId,
        idDevolucao: original.idDevolucao,
        amountCents: original.amountCents + 1,
      });
      await prepare(otherPayment);
      await expect(repository.createIfAbsent(otherPayment)).rejects.toBeInstanceOf(
        PixCobrancaDevolucaoConflictError,
      );
    });

    it('finds by provider identity and payment id', async () => {
      const input = makeInput();
      await prepare(input);
      const created = await repository.createIfAbsent(input);

      await expect(repository.findByIdentity(input.e2eId, input.idDevolucao)).resolves.toEqual(
        created.record,
      );
      await expect(repository.findByPagamentoId(input.idPagamento)).resolves.toEqual(
        created.record,
      );
      await expect(repository.findByPagamentoId(randomUUID())).resolves.toBeUndefined();
    });

    it('updates provider outcome, preserves omitted RTR, and accepts explicit null', async () => {
      const input = makeInput();
      await prepare(input);
      await repository.createIfAbsent(input);

      const processingAt = new Date('2026-08-05T12:05:00.000Z');
      const processing = await repository.updateOutcome({
        e2eId: input.e2eId,
        idDevolucao: input.idDevolucao,
        status: 'em_processamento',
        rtrId: 'RTR-accepted-01',
        atualizadoEm: processingAt,
      });
      expect(processing).toMatchObject({ status: 'em_processamento', rtrId: 'RTR-accepted-01' });
      expect(processing?.atualizadoEm).toEqual(processingAt);

      const completed = await repository.updateOutcome({
        e2eId: input.e2eId,
        idDevolucao: input.idDevolucao,
        status: 'devolvida',
        atualizadoEm: new Date('2026-08-05T12:10:00.000Z'),
      });
      expect(completed).toMatchObject({ status: 'devolvida', rtrId: 'RTR-accepted-01' });

      const cleared = await repository.updateOutcome({
        e2eId: input.e2eId,
        idDevolucao: input.idDevolucao,
        status: 'devolvida',
        rtrId: null,
        atualizadoEm: new Date('2026-08-05T12:15:00.000Z'),
      });
      expect(cleared?.rtrId).toBeNull();
    });

    it('never regresses a terminal outcome and returns the canonical winner', async () => {
      const input = makeInput();
      await prepare(input);
      await repository.createIfAbsent(input);

      const terminalAt = new Date('2026-08-05T12:10:00.000Z');
      const terminal = await repository.updateOutcome({
        e2eId: input.e2eId,
        idDevolucao: input.idDevolucao,
        status: 'devolvida',
        rtrId: 'RTR-final',
        atualizadoEm: terminalAt,
      });
      expect(terminal?.status).toBe('devolvida');

      const lateInitial = await repository.updateOutcome({
        e2eId: input.e2eId,
        idDevolucao: input.idDevolucao,
        status: 'em_processamento',
        rtrId: 'RTR-stale',
        atualizadoEm: new Date('2026-08-05T12:05:00.000Z'),
      });
      expect(lateInitial).toEqual(terminal);

      const conflictingTerminal = await repository.updateOutcome({
        e2eId: input.e2eId,
        idDevolucao: input.idDevolucao,
        status: 'rejeitada',
        atualizadoEm: new Date('2026-08-05T12:15:00.000Z'),
      });
      expect(conflictingTerminal).toEqual(terminal);
      await expect(repository.findByPagamentoId(input.idPagamento)).resolves.toEqual(terminal);
    });

    it('atomically converges conflicting terminal outcomes to one canonical winner', async () => {
      const input = makeInput();
      await prepare(input);
      await repository.createIfAbsent(input);

      const [left, right] = await Promise.all([
        repository.updateOutcome({
          e2eId: input.e2eId,
          idDevolucao: input.idDevolucao,
          status: 'devolvida',
          rtrId: 'RTR-race',
          atualizadoEm: new Date('2026-08-05T12:10:00.000Z'),
        }),
        repository.updateOutcome({
          e2eId: input.e2eId,
          idDevolucao: input.idDevolucao,
          status: 'rejeitada',
          atualizadoEm: new Date('2026-08-05T12:11:00.000Z'),
        }),
      ]);

      expect(left).toEqual(right);
      expect(['devolvida', 'rejeitada']).toContain(left?.status);
      await expect(repository.findByPagamentoId(input.idPagamento)).resolves.toEqual(left);
    });

    it('returns undefined when updating an unknown identity', async () => {
      await expect(
        repository.updateOutcome({
          e2eId: 'E1234567890123456789012345678901',
          idDevolucao: REFUND_ID,
          status: 'rejeitada',
          atualizadoEm: new Date(),
        }),
      ).resolves.toBeUndefined();
    });

    it('deleteIfPending removes only an untouched preflight marker', async () => {
      const untouched = makeInput();
      await prepare(untouched);
      await repository.createIfAbsent(untouched);
      await expect(
        repository.deleteIfPending({
          e2eId: untouched.e2eId,
          idDevolucao: untouched.idDevolucao,
        }),
      ).resolves.toBe(true);
      await expect(repository.findByPagamentoId(untouched.idPagamento)).resolves.toBeUndefined();
      await expect(
        repository.deleteIfPending({
          e2eId: untouched.e2eId,
          idDevolucao: untouched.idDevolucao,
        }),
      ).resolves.toBe(false);

      const providerTouched = makeInput({
        e2eId: 'E2234567890123456789012345678901',
        idDevolucao: OTHER_REFUND_ID,
      });
      await prepare(providerTouched);
      await repository.createIfAbsent(providerTouched);
      await repository.updateOutcome({
        e2eId: providerTouched.e2eId,
        idDevolucao: providerTouched.idDevolucao,
        status: 'em_processamento',
        rtrId: 'RTR-provider-touched',
        atualizadoEm: new Date('2026-08-05T12:05:00.000Z'),
      });
      await expect(
        repository.deleteIfPending({
          e2eId: providerTouched.e2eId,
          idDevolucao: providerTouched.idDevolucao,
        }),
      ).resolves.toBe(false);

      await repository.updateOutcome({
        e2eId: providerTouched.e2eId,
        idDevolucao: providerTouched.idDevolucao,
        status: 'rejeitada',
        rtrId: null,
        atualizadoEm: new Date('2026-08-05T12:10:00.000Z'),
      });
      await expect(
        repository.deleteIfPending({
          e2eId: providerTouched.e2eId,
          idDevolucao: providerTouched.idDevolucao,
        }),
      ).resolves.toBe(false);
    });

    it('enforces refund-id and positive-amount invariants', async () => {
      const invalidId = makeInput({ idDevolucao: 'tooShort' });
      await prepare(invalidId);
      await expect(repository.createIfAbsent(invalidId)).rejects.toThrow();

      const invalidAmount = makeInput({ amountCents: 0 });
      await prepare(invalidAmount);
      await expect(repository.createIfAbsent(invalidAmount)).rejects.toThrow();
    });

    it('defensively copies Date values on writes and reads', async () => {
      const input = makeInput();
      await prepare(input);
      const originalTime = input.criadoEm.getTime();
      const created = await repository.createIfAbsent(input);

      input.criadoEm.setUTCFullYear(2040);
      created.record.criadoEm.setUTCFullYear(2041);
      created.record.atualizadoEm.setUTCFullYear(2042);

      const found = await repository.findByPagamentoId(input.idPagamento);
      expect(found?.criadoEm.getTime()).toBe(originalTime);
      expect(found?.atualizadoEm.getTime()).toBe(originalTime);
    });
  });
}
