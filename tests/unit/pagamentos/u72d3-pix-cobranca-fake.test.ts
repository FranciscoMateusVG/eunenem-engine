import { describe, expect, it } from 'vitest';
import {
  PIX_COBRANCA_FAKE_MAGIC_CENTS,
  PixCobrancaProviderFake,
} from '../../../src/adapters/pagamentos/pix-cobranca-provider.fake.js';
import type {
  CriarCobrancaInput,
  DevolucaoOutcome,
  SolicitarDevolucaoInput,
} from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';

const PAGAMENTO_1 = '00000000-0000-4000-8000-000000000001';
const PAGAMENTO_2 = '00000000-0000-4000-8000-000000000002';
const INTENCAO_1 = '10000000-0000-4000-8000-000000000001';

function chargeInput(overrides: Partial<CriarCobrancaInput> = {}): CriarCobrancaInput {
  return {
    idPagamento: PAGAMENTO_1,
    idIntencaoPagamento: INTENCAO_1,
    amountCents: 5000,
    solicitacaoPagador: 'Presente',
    ...overrides,
  };
}

function refundInput(overrides: Partial<SolicitarDevolucaoInput> = {}): SolicitarDevolucaoInput {
  return {
    e2eId: 'E2E00000000000000000000000000001',
    idDevolucao: 'refundbycaller1',
    amountCents: 5000,
    descricao: 'requested_by_customer',
    ...overrides,
  };
}

describe('PixCobrancaProviderFake — charge ledger', () => {
  it('uses deterministic defaults, injected clock and reverse txid lookup', async () => {
    const now = new Date('2030-02-03T04:05:06.000Z');
    const fake = new PixCobrancaProviderFake({
      clock: () => now,
      expiracaoSeconds: 90,
    });

    const first = await fake.criarCobranca(chargeInput());
    const second = await fake.criarCobranca(
      chargeInput({ idPagamento: PAGAMENTO_2, amountCents: 6000 }),
    );

    expect(first).toEqual({
      txid: 'FAKE0000000000000000000000000001',
      pixCopiaECola: '000201FAKE-PIX-FAKE0000000000000000000000000001',
      expiraEm: new Date('2030-02-03T04:06:36.000Z'),
    });
    expect(second.txid).toBe('FAKE0000000000000000000000000002');
    await expect(fake.consultarCobranca(first.txid)).resolves.toEqual({ status: 'ativa' });
    expect(fake.criarCobrancaCalls).toBe(2);
    expect(fake.consultarCobrancaCalls).toBe(1);
    expect(fake.cobrancas).toHaveLength(2);
    expect(fake.cobrancas[0]).toMatchObject({ input: chargeInput(), result: first, consultas: 1 });
  });

  it('mirrors the real adapter ten-minute expiry by default', async () => {
    const fake = new PixCobrancaProviderFake();

    await expect(fake.criarCobranca(chargeInput())).resolves.toMatchObject({
      expiraEm: new Date('2026-01-01T00:10:00.000Z'),
    });
  });

  it('uses injected txid/e2eId/BR-code factories without ambient randomness', async () => {
    const fake = new PixCobrancaProviderFake({
      txidFactory: (input, ordinal) => `TX${ordinal}-${input.idPagamento}`,
      e2eIdFactory: (txid, ordinal) => `E2E-${ordinal}-${txid}`,
      pixCopiaEColaFactory: (txid) => `BR:${txid}`,
      clock: () => new Date('2031-01-01T00:00:00.000Z'),
      consultarCobrancaSequence: [{ status: 'concluida' }],
    });

    const created = await fake.criarCobranca(chargeInput());
    expect(created.txid).toBe(`TX1-${PAGAMENTO_1}`);
    expect(created.pixCopiaECola).toBe(`BR:TX1-${PAGAMENTO_1}`);
    await expect(fake.consultarCobranca(created.txid)).resolves.toEqual({
      status: 'concluida',
      e2eId: `E2E-1-TX1-${PAGAMENTO_1}`,
      valorPagoCents: 5000,
      horario: new Date('2031-01-01T00:00:00.000Z'),
    });
  });

  it('replays the exact result for the same payment/payload and rejects payload drift', async () => {
    const fake = new PixCobrancaProviderFake();
    const input = chargeInput();
    const created = await fake.criarCobranca(input);
    const replay = await fake.criarCobranca({ ...input });

    expect(replay).toEqual(created);
    expect(replay).not.toBe(created);
    expect(replay.expiraEm).not.toBe(created.expiraEm);
    expect(fake.cobrancas).toHaveLength(1);
    await expect(fake.criarCobranca({ ...input, amountCents: 5001 })).rejects.toThrow(
      'pix fake charge conflict',
    );
  });

  it('owns its idempotency baseline despite caller and snapshot mutation', async () => {
    const fake = new PixCobrancaProviderFake();
    const input = chargeInput();
    const created = await fake.criarCobranca(input);

    (input as { amountCents: number }).amountCents = 5001;
    (fake.cobrancas[0]?.input as { amountCents: number }).amountCents = 5002;

    await expect(fake.criarCobranca(chargeInput())).resolves.toEqual(created);
    await expect(fake.criarCobranca(chargeInput({ amountCents: 5001 }))).rejects.toThrow(
      'pix fake charge conflict',
    );
  });

  it('keeps charge result and Date baselines private from caller and snapshot mutation', async () => {
    const fake = new PixCobrancaProviderFake();
    const expected = {
      txid: 'FAKE0000000000000000000000000001',
      pixCopiaECola: '000201FAKE-PIX-FAKE0000000000000000000000000001',
      expiraEm: new Date('2026-01-01T00:10:00.000Z'),
    };
    const created = await fake.criarCobranca(chargeInput());

    (created as { txid: string; pixCopiaECola: string }).txid = 'CORRUPTED';
    (created as { pixCopiaECola: string }).pixCopiaECola = 'CORRUPTED';
    created.expiraEm.setTime(0);
    const firstSnapshot = fake.cobrancas[0];
    if (firstSnapshot === undefined) throw new Error('expected charge snapshot');
    expect(firstSnapshot.result).toEqual(expected);
    (firstSnapshot.result as { txid: string }).txid = 'SNAPSHOT-CORRUPTED';
    firstSnapshot.result.expiraEm.setTime(1);

    const replay = await fake.criarCobranca(chargeInput());
    expect(replay).toEqual(expected);
    expect(replay).not.toBe(created);
    expect(replay.expiraEm).not.toBe(created.expiraEm);
    expect(fake.cobrancas[0]?.result).toEqual(expected);
  });

  it('rejects duplicate factory txids across different payments', async () => {
    const fake = new PixCobrancaProviderFake({ txidFactory: () => 'SAME-TXID' });
    await fake.criarCobranca(chargeInput());
    await expect(fake.criarCobranca(chargeInput({ idPagamento: PAGAMENTO_2 }))).rejects.toThrow(
      'pix fake duplicate txid SAME-TXID',
    );
  });

  it('scripts ativa/desconhecido/concluida and keeps the terminal result sticky', async () => {
    const paidAt = new Date('2032-03-04T05:06:07.000Z');
    const expectedPaidAt = new Date(paidAt.getTime());
    const fake = new PixCobrancaProviderFake({
      consultarCobrancaSequence: [
        { status: 'ativa' },
        { status: 'desconhecido', statusBruto: 'EM_ANALISE_NOVA' },
        {
          status: 'concluida',
          e2eId: 'E2E-SCRIPTED',
          valorPagoCents: 4999,
          horario: paidAt,
        },
        { status: 'removida' },
      ],
    });
    paidAt.setTime(0);
    const { txid } = await fake.criarCobranca(chargeInput());

    await expect(fake.consultarCobranca(txid)).resolves.toEqual({ status: 'ativa' });
    await expect(fake.consultarCobranca(txid)).resolves.toEqual({
      status: 'desconhecido',
      statusBruto: 'EM_ANALISE_NOVA',
    });
    const concluded = await fake.consultarCobranca(txid);
    expect(concluded).toEqual({
      status: 'concluida',
      e2eId: 'E2E-SCRIPTED',
      valorPagoCents: 4999,
      horario: expectedPaidAt,
    });
    if (concluded.status !== 'concluida') throw new Error('expected concluded charge');
    (concluded as { e2eId: string }).e2eId = 'CALLER-CORRUPTED';
    concluded.horario.setTime(1);

    const sticky = await fake.consultarCobranca(txid);
    expect(sticky).toEqual({
      status: 'concluida',
      e2eId: 'E2E-SCRIPTED',
      valorPagoCents: 4999,
      horario: expectedPaidAt,
    });
    const snapshot = fake.cobrancas[0];
    if (snapshot?.terminal?.status !== 'concluida') {
      throw new Error('expected concluded charge snapshot');
    }
    (snapshot.terminal as { e2eId: string }).e2eId = 'SNAPSHOT-CORRUPTED';
    snapshot.terminal.horario.setTime(2);

    await expect(fake.consultarCobranca(txid)).resolves.toEqual({
      status: 'concluida',
      e2eId: 'E2E-SCRIPTED',
      valorPagoCents: 4999,
      horario: expectedPaidAt,
    });
    expect(fake.cobrancas[0]).toMatchObject({
      consultas: 5,
      terminal: {
        status: 'concluida',
        e2eId: 'E2E-SCRIPTED',
        valorPagoCents: 4999,
        horario: expectedPaidAt,
      },
    });
  });

  it('keeps removida terminal and throws for an unknown txid (never desconhecido)', async () => {
    const fake = new PixCobrancaProviderFake({
      consultarCobrancaSequence: [{ status: 'removida' }, { status: 'ativa' }],
    });
    const { txid } = await fake.criarCobranca(chargeInput());
    const removed = await fake.consultarCobranca(txid);
    expect(removed).toEqual({ status: 'removida' });
    expect(await fake.consultarCobranca(txid)).toEqual(removed);
    await expect(fake.consultarCobranca('UNKNOWN')).rejects.toThrow('charge not found');
  });
});

describe('PixCobrancaProviderFake — refund ledger', () => {
  it.each<DevolucaoOutcome>([
    { status: 'em_processamento', rtrId: 'RTR-1' },
    { status: 'devolvida' },
    { status: 'nao_realizada', motivo: 'saldo_insuficiente' },
    { status: 'rejeitada', codigo: 'VALOR_INVALIDO' },
  ])('returns configured option-driven outcome $status', async (outcome) => {
    const fake = new PixCobrancaProviderFake({ solicitarDevolucaoOutcome: outcome });
    const returned = await fake.solicitarDevolucao(refundInput());
    expect(returned).toEqual(outcome);
    expect(returned).not.toBe(outcome);
  });

  it('uses the caller idDevolucao, replays byte-for-byte, and rejects payload drift', async () => {
    const initial: DevolucaoOutcome = { status: 'em_processamento', rtrId: 'RTR-STABLE' };
    const fake = new PixCobrancaProviderFake({ solicitarDevolucaoOutcome: initial });
    const input = refundInput({ idDevolucao: 'callerownedid35' });

    const created = await fake.solicitarDevolucao(input);
    const replay = await fake.solicitarDevolucao({ ...input });
    expect(created).toEqual(initial);
    expect(created).not.toBe(initial);
    expect(replay).toEqual(created);
    expect(replay).not.toBe(created);
    expect(fake.devolucoes).toHaveLength(1);
    expect(fake.devolucoes[0]?.input.idDevolucao).toBe('callerownedid35');
    expect(fake.solicitarDevolucaoCalls).toBe(2);

    await expect(fake.solicitarDevolucao({ ...input, amountCents: 4000 })).rejects.toThrow(
      'pix fake refund conflict',
    );
  });

  it('owns the refund idempotency baseline despite caller and snapshot mutation', async () => {
    const fake = new PixCobrancaProviderFake();
    const input = refundInput();
    const created = await fake.solicitarDevolucao(input);

    (input as { amountCents: number }).amountCents = 5001;
    (fake.devolucoes[0]?.input as { amountCents: number }).amountCents = 5002;

    await expect(fake.solicitarDevolucao(refundInput())).resolves.toEqual(created);
    await expect(fake.solicitarDevolucao(refundInput({ amountCents: 5001 }))).rejects.toThrow(
      'pix fake refund conflict',
    );
  });

  it('keeps configured, returned and snapshotted refund results outside the ledger', async () => {
    const configured: DevolucaoOutcome = { status: 'em_processamento', rtrId: 'RTR-OWNED' };
    const fake = new PixCobrancaProviderFake({ solicitarDevolucaoOutcome: configured });
    (configured as { rtrId: string }).rtrId = 'CONFIG-CORRUPTED';

    const created = await fake.solicitarDevolucao(refundInput());
    expect(created).toEqual({ status: 'em_processamento', rtrId: 'RTR-OWNED' });
    (created as { rtrId: string }).rtrId = 'CALLER-CORRUPTED';
    const firstSnapshot = fake.devolucoes[0];
    if (firstSnapshot === undefined) throw new Error('expected refund snapshot');
    expect(firstSnapshot?.result).toEqual({ status: 'em_processamento', rtrId: 'RTR-OWNED' });
    (firstSnapshot.result as { rtrId: string }).rtrId = 'SNAPSHOT-CORRUPTED';

    const replay = await fake.solicitarDevolucao(refundInput());
    expect(replay).toEqual({ status: 'em_processamento', rtrId: 'RTR-OWNED' });
    expect(replay).not.toBe(created);
    expect(fake.devolucoes[0]?.result).toEqual({
      status: 'em_processamento',
      rtrId: 'RTR-OWNED',
    });
  });

  it('scripts refund consultation and keeps devolvida terminal', async () => {
    const processing: DevolucaoOutcome = { status: 'em_processamento', rtrId: 'RTR-POLL' };
    const refunded: DevolucaoOutcome = { status: 'devolvida' };
    const fake = new PixCobrancaProviderFake({
      solicitarDevolucaoOutcome: processing,
      consultarDevolucaoSequence: [processing, refunded, { status: 'rejeitada', codigo: 'LATE' }],
    });
    (processing as { rtrId: string }).rtrId = 'CONFIG-CORRUPTED';
    (refunded as { status: string }).status = 'rejeitada';
    const input = refundInput();
    await fake.solicitarDevolucao(input);

    const first = await fake.consultarDevolucao(input);
    expect(first).toEqual({ status: 'em_processamento', rtrId: 'RTR-POLL' });
    (first as { rtrId: string }).rtrId = 'CALLER-CORRUPTED';
    const second = await fake.consultarDevolucao(input);
    expect(second).toEqual({ status: 'devolvida' });
    (second as { status: string }).status = 'nao_realizada';
    const third = await fake.consultarDevolucao(input);
    expect(third).toEqual({ status: 'devolvida' });
    const snapshot = fake.devolucoes[0];
    if (snapshot?.terminal === undefined) throw new Error('expected refund terminal snapshot');
    (snapshot.terminal as { status: string }).status = 'rejeitada';
    expect(await fake.consultarDevolucao(input)).toEqual({
      status: 'devolvida',
    });
    expect(fake.consultarDevolucaoCalls).toBe(4);
    expect(fake.devolucoes[0]).toMatchObject({ consultas: 4, terminal: { status: 'devolvida' } });
  });

  it('throws for an unknown (e2eId,idDevolucao) pair', async () => {
    const fake = new PixCobrancaProviderFake();
    await expect(
      fake.consultarDevolucao({ e2eId: 'missing', idDevolucao: 'missing', amountCents: 1000 }),
    ).rejects.toThrow('refund not found');
  });

  it('rejects a mismatched expected amount without advancing the consultation script', async () => {
    const fake = new PixCobrancaProviderFake({
      consultarDevolucaoSequence: [{ status: 'em_processamento', rtrId: 'FIRST' }],
    });
    const input = refundInput();
    await fake.solicitarDevolucao(input);

    await expect(
      fake.consultarDevolucao({ ...input, amountCents: input.amountCents + 1 }),
    ).rejects.toThrow('amount mismatch');
    await expect(fake.consultarDevolucao(input)).resolves.toEqual({
      status: 'em_processamento',
      rtrId: 'FIRST',
    });
  });
});

describe('PixCobrancaProviderFake — opt-in magic and explicit failures', () => {
  it('treats magic values as ordinary cents while magic is disabled', async () => {
    const fake = new PixCobrancaProviderFake();
    const auto = await fake.criarCobranca(
      chargeInput({ amountCents: PIX_COBRANCA_FAKE_MAGIC_CENTS.autoComplete }),
    );
    await expect(fake.consultarCobranca(auto.txid)).resolves.toEqual({ status: 'ativa' });
    await expect(
      fake.solicitarDevolucao(
        refundInput({ amountCents: PIX_COBRANCA_FAKE_MAGIC_CENTS.refundRejected }),
      ),
    ).resolves.toEqual({
      status: 'em_processamento',
      rtrId: 'RTRFAKE0000000000000000000000001',
    });
  });

  it('auto-completes 1337 and force-removes 1404 on first consult with terminal stickiness', async () => {
    const fake = new PixCobrancaProviderFake({ e2eMagicOutcomes: true });
    const auto = await fake.criarCobranca(
      chargeInput({ amountCents: PIX_COBRANCA_FAKE_MAGIC_CENTS.autoComplete }),
    );
    const removed = await fake.criarCobranca(
      chargeInput({
        idPagamento: PAGAMENTO_2,
        amountCents: PIX_COBRANCA_FAKE_MAGIC_CENTS.forceRemoved,
      }),
    );

    const completedResult = await fake.consultarCobranca(auto.txid);
    expect(completedResult).toMatchObject({
      status: 'concluida',
      e2eId: 'E2EFAKE0000000000000000000000001',
      valorPagoCents: 1337,
    });
    expect(await fake.consultarCobranca(auto.txid)).toEqual(completedResult);
    const removedResult = await fake.consultarCobranca(removed.txid);
    expect(removedResult).toEqual({ status: 'removida' });
    expect(await fake.consultarCobranca(removed.txid)).toEqual(removedResult);
  });

  it('rejects the 1422 refund magic without generating or replacing idDevolucao', async () => {
    const fake = new PixCobrancaProviderFake({ e2eMagicOutcomes: true });
    const input = refundInput({
      idDevolucao: 'callerkeepsthisid',
      amountCents: PIX_COBRANCA_FAKE_MAGIC_CENTS.refundRejected,
    });
    await expect(fake.solicitarDevolucao(input)).resolves.toEqual({
      status: 'rejeitada',
      codigo: 'FAKE_MAGIC_REFUND_REJECTED',
    });
    expect(fake.devolucoes[0]?.input.idDevolucao).toBe('callerkeepsthisid');
  });

  it('supports explicit create/refund infrastructure errors without writing ledgers', async () => {
    const createError = new Error('create unavailable');
    const refundError = new Error('refund unavailable');
    const fake = new PixCobrancaProviderFake({
      criarCobrancaError: createError,
      solicitarDevolucaoError: refundError,
    });

    await expect(fake.criarCobranca(chargeInput())).rejects.toBe(createError);
    await expect(fake.solicitarDevolucao(refundInput())).rejects.toBe(refundError);
    expect(fake.cobrancas).toEqual([]);
    expect(fake.devolucoes).toEqual([]);
  });
});
