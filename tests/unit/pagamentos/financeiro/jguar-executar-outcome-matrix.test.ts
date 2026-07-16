/**
 * aperture-jguar — `executarTransferenciaRepasse` outcome matrix.
 *
 * Handler-level coverage of the `repasse.executar` job (spec §5.3, §6):
 * every pagarPix outcome branch (pago / agendado_aprovacao / rejeitado),
 * every throw class (transitorio auto-retry + exhaustion, ambiguo/timeout
 * divert-to-verificando), the crash re-delivery `reconciliar` path, the
 * `concluido` no-op path, and the stable-referencia idempotency anchor.
 *
 * Complements (does NOT duplicate) Rex's pure-domain FSM guard matrix in
 * `vvh2j-transfer-fsm.test.ts` — here the memory repository + fake
 * provider + spy enqueuer are wired together and the handler drives them.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RecebedorRepositoryMemory } from '../../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import type { RepasseJobEnqueuer } from '../../../../src/adapters/pagamentos/transferencia-enqueuer.js';
import type { TransferenciaProviderFakeOptions } from '../../../../src/adapters/pagamentos/transferencia-provider.fake.js';
import { TransferenciaProviderFake } from '../../../../src/adapters/pagamentos/transferencia-provider.fake.js';
import {
  type PagarPixInput,
  type TransferenciaProvider,
  TransferenciaTransitoriaError,
} from '../../../../src/adapters/pagamentos/transferencia-provider.js';
import { criarRecebedorInicial } from '../../../../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../../src/observability/tracer.js';
import { gerarTransferReferencia } from '../../../../src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
import {
  CONFIRMAR_DELAY_INICIAL_SEGUNDOS,
  type ExecutarTransferenciaRepasseDeps,
  executarTransferenciaRepasse,
  MAX_TENTATIVAS_TRANSITORIAS,
} from '../../../../src/use-cases/pagamentos/financeiro/executar-transferencia-repasse.js';

const T0 = new Date('2026-07-16T10:00:00.000Z');
const T1 = new Date('2026-07-16T11:00:00.000Z');
const CHAVE_PIX = 'bia@example.com';

interface Rig {
  livro: LivroFinanceiroRepositoryMemory;
  enqueuer: RepasseJobEnqueuer;
  enqueued: {
    executar: string[];
    confirmar: Array<{ id: string; tentativa: number; delay: number }>;
  };
  idCampanha: string;
  clock: () => Date;
  setAgora: (d: Date) => void;
}

async function buildRig(options: { metodoRecebedor?: 'pix' | 'conta' } = {}): Promise<Rig> {
  const recebedorRepository = new RecebedorRepositoryMemory();
  const livro = new LivroFinanceiroRepositoryMemory(recebedorRepository);
  const idCampanha = randomUUID();

  const dados =
    (options.metodoRecebedor ?? 'pix') === 'pix'
      ? {
          metodo: 'pix',
          nomeTitular: 'Bia Silva',
          cpfTitular: '52998224725',
          tipoChavePix: 'email',
          chavePix: CHAVE_PIX,
        }
      : {
          metodo: 'conta',
          nomeTitular: 'Bia Silva',
          cpfTitular: '52998224725',
        };
  await recebedorRepository.save(
    criarRecebedorInicial({
      id: randomUUID() as never,
      idCampanha: idCampanha as never,
      dadosRecebedor: dados as never,
      criadaEm: T0,
    }),
  );

  let agora = T1;
  const enqueued: Rig['enqueued'] = { executar: [], confirmar: [] };
  const enqueuer: RepasseJobEnqueuer = {
    async enqueueExecutar(data) {
      enqueued.executar.push(data.idRepasse);
    },
    async enqueueConfirmar(data, delaySeconds) {
      enqueued.confirmar.push({
        id: data.idRepasse,
        tentativa: data.tentativaConfirmacao,
        delay: delaySeconds,
      });
    },
  };

  return {
    livro,
    enqueuer,
    enqueued,
    idCampanha,
    clock: () => agora,
    setAgora: (d) => {
      agora = d;
    },
  };
}

function makeLancamento(args: { idCampanha: string; amountCents: number; idPagamento?: string }) {
  return {
    id: randomUUID(),
    idPagamento: args.idPagamento ?? randomUUID(),
    idContribuicao: randomUUID(),
    idCampanha: args.idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: args.amountCents,
    criadoEm: T0,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
  } as never;
}

/** Seed one repasse through solicitado → aprovado (pix), claiming two lançamentos. */
async function seedRepasseAprovado(rig: Rig): Promise<{
  idRepasse: string;
  idsLancamentos: string[];
  referencia: string;
}> {
  const l1 = makeLancamento({ idCampanha: rig.idCampanha, amountCents: 3000 });
  const l2 = makeLancamento({ idCampanha: rig.idCampanha, amountCents: 1500 });
  await rig.livro.saveLancamentos([l1, l2]);

  const idRepasse = randomUUID();
  await rig.livro.solicitarRepasseTransaction({
    idCampanha: rig.idCampanha as never,
    idRepasse: idRepasse as never,
    solicitadoEm: T0,
    now: T0,
  });
  const referencia = gerarTransferReferencia(idRepasse as never);
  await rig.livro.aprovarRepassePixTransaction(
    { idRepasse: idRepasse as never, aprovadoEm: T1, transferReferencia: referencia },
    async () => {},
  );
  return {
    idRepasse,
    idsLancamentos: [String((l1 as { id: string }).id), String((l2 as { id: string }).id)],
    referencia,
  };
}

function makeDeps(rig: Rig, provider: TransferenciaProvider): ExecutarTransferenciaRepasseDeps {
  return {
    livroFinanceiroRepository: rig.livro,
    transferenciaProvider: provider,
    repasseJobEnqueuer: rig.enqueuer,
    clock: rig.clock,
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
  };
}

function executar(rig: Rig, provider: TransferenciaProvider, idRepasse: string): Promise<void> {
  return executarTransferenciaRepasse(makeDeps(rig, provider), { idRepasse: idRepasse as never });
}

function fake(options: TransferenciaProviderFakeOptions = {}): TransferenciaProviderFake {
  return new TransferenciaProviderFake(options);
}

/** Delegating provider that records the referencia of every pagarPix call. */
function recordReferencias(
  target: TransferenciaProviderFake,
  sink: string[],
): TransferenciaProvider {
  return {
    async pagarPix(input: PagarPixInput) {
      sink.push(input.referencia);
      return target.pagarPix(input);
    },
    consultarPagamento: (codigo) => target.consultarPagamento(codigo),
    buscarPagamentos: (input) => target.buscarPagamentos(input),
  };
}

describe('executarTransferenciaRepasse — outcome pago', () => {
  it('FSM → pago, records codigo, closes the attempt, stamps transferidoEm, no confirmar', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedRepasseAprovado(rig);
    const provider = fake({ pagarPixOutcome: 'pago' });

    await executar(rig, provider, idRepasse);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago');
    expect(repasse?.interCodigoSolicitacao).toBeTruthy();
    expect(repasse?.transferAttempts).toBe(1);

    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('pago');
    expect(attempts[0]?.codigoSolicitacao).toBe(repasse?.interCodigoSolicitacao);
    expect(attempts[0]?.finishedAt).not.toBeNull();

    // The single debit point: linked lançamentos are stamped at pago.
    const lancamentos = await rig.livro.findLancamentosByIds(idsLancamentos as never);
    expect(lancamentos).toHaveLength(2);
    for (const l of lancamentos) {
      expect(l.transferidoEm).toEqual(T1);
    }

    // Success needs no reconciliation.
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(1);
  });
});

describe('executarTransferenciaRepasse — outcome agendado_aprovacao', () => {
  it('is NOT success: FSM → verificando, codigo recorded, confirmar enqueued once, no stamp', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedRepasseAprovado(rig);
    const provider = fake({ pagarPixOutcome: 'agendado_aprovacao' });

    await executar(rig, provider, idRepasse);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    expect(repasse?.interCodigoSolicitacao).toBeTruthy();

    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('verificando');
    expect(attempts[0]?.codigoSolicitacao).toBe(repasse?.interCodigoSolicitacao);

    expect(rig.enqueued.confirmar).toEqual([
      { id: idRepasse, tentativa: 1, delay: CONFIRMAR_DELAY_INICIAL_SEGUNDOS },
    ]);

    // Payment outcome unknown → money is NOT marked as moved.
    const lancamentos = await rig.livro.findLancamentosByIds(idsLancamentos as never);
    for (const l of lancamentos) {
      expect(l.transferidoEm).toBeNull();
    }
    expect(provider.pagarPixCalls).toBe(1);
  });
});

describe('executarTransferenciaRepasse — outcome rejeitado', () => {
  it('FSM → falhou, lastTransferError from erro, no confirmar, no stamp', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedRepasseAprovado(rig);
    const provider = fake({ pagarPixOutcome: 'rejeitado', erroRejeicao: 'CHAVE_INVALIDA' });

    await executar(rig, provider, idRepasse);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('CHAVE_INVALIDA');

    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('falhou');
    expect(attempts[0]?.error).toBe('CHAVE_INVALIDA');

    expect(rig.enqueued.confirmar).toHaveLength(0);
    const lancamentos = await rig.livro.findLancamentosByIds(idsLancamentos as never);
    for (const l of lancamentos) {
      expect(l.transferidoEm).toBeNull();
    }
    expect(provider.pagarPixCalls).toBe(1);
  });

  it('handles a rejection WITHOUT codigoSolicitacao (incluiCodigoNaRejeicao: false)', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedRepasseAprovado(rig);
    const provider = fake({ pagarPixOutcome: 'rejeitado', incluiCodigoNaRejeicao: false });

    await executar(rig, provider, idRepasse);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('FAKE_REJECTED');
    // No codigo was ever produced — none may be recorded.
    expect(repasse?.interCodigoSolicitacao).toBeNull();
    expect(rig.enqueued.confirmar).toHaveLength(0);
  });
});

describe('executarTransferenciaRepasse — transitorio throw (safe auto-retry)', () => {
  // VERIFIED-FIXED (aperture-oxqlf, Rex PR #8, staging 1cd53c3): the handler
  // previously detached `finalizarTentativaTransferencia` into a `const`,
  // dropping its `this` binding so every thrown-pagarPix branch TypeError'd
  // and wedged the repasse in `transferindo`. Rex now calls the method
  // directly on the repository (`livroFinanceiroRepository.finalizar…(…)`),
  // so the transitorio revert / exhaustion / ambiguo divert branches all
  // execute. Flipped from it.fails → it() as the in-suite regression lock.
  it('closes the attempt as transitorio, reverts to aprovado, and RETHROWS for pg-boss', async () => {
    const rig = await buildRig();
    const { idRepasse, referencia } = await seedRepasseAprovado(rig);
    const provider = fake({ pagarPixOutcome: 'transitorio' });

    await expect(executar(rig, provider, idRepasse)).rejects.toBeInstanceOf(
      TransferenciaTransitoriaError,
    );

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    // reverterTransferenciaParaAprovado: clean fresh claim on the retry.
    expect(repasse?.status).toBe('aprovado');
    // The attempt counter is KEPT (not rolled back) — bounds retry storms.
    expect(repasse?.transferAttempts).toBe(1);
    // The stable referencia survives the revert.
    expect(repasse?.transferReferencia).toBe(referencia);

    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('transitorio');
    expect(attempts[0]?.finishedAt).not.toBeNull();

    // Transient ≠ ambiguous: no reconciliation is scheduled.
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(1);
  });

  // VERIFIED-FIXED (aperture-oxqlf, Rex PR #8): the transitorio-exhaustion
  // branch now runs instead of TypeError'ing. Flipped it.fails → it().
  it(`exhausts at attempt ${MAX_TENTATIVAS_TRANSITORIAS}: closes falhou/TRANSITORIO_ESGOTADO and does NOT rethrow`, async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedRepasseAprovado(rig);
    const provider = fake({ pagarPixOutcome: 'transitorio' });

    // Attempts 1..3 revert + rethrow (pg-boss would redeliver each).
    for (let i = 1; i < MAX_TENTATIVAS_TRANSITORIAS; i += 1) {
      await expect(executar(rig, provider, idRepasse)).rejects.toBeInstanceOf(
        TransferenciaTransitoriaError,
      );
    }
    // Attempt 4 hits the cap: resolves without throwing.
    await expect(executar(rig, provider, idRepasse)).resolves.toBeUndefined();

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('TRANSITORIO_ESGOTADO');
    expect(repasse?.transferAttempts).toBe(MAX_TENTATIVAS_TRANSITORIAS);

    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts).toHaveLength(MAX_TENTATIVAS_TRANSITORIAS);
    expect(attempts.at(-1)?.outcome).toBe('falhou');
    expect(attempts.at(-1)?.error).toBe('TRANSITORIO_ESGOTADO');
    expect(provider.pagarPixCalls).toBe(MAX_TENTATIVAS_TRANSITORIAS);
  });
});

describe('executarTransferenciaRepasse — ambiguous throws (never auto-retry)', () => {
  for (const outcome of ['ambiguo', 'timeout'] as const) {
    // VERIFIED-FIXED (aperture-oxqlf, Rex PR #8): the ambiguous
    // divert-to-verificando + enqueueConfirmar now executes instead of
    // stranding the repasse in `transferindo`. Flipped it.fails → it().
    it(`${outcome}: FSM → verificando with null codigo, confirmar enqueued, NO rethrow`, async () => {
      const rig = await buildRig();
      const { idRepasse, idsLancamentos } = await seedRepasseAprovado(rig);
      const provider = fake({ pagarPixOutcome: outcome });

      // A payment MAY exist — the handler swallows the throw and reconciles.
      await expect(executar(rig, provider, idRepasse)).resolves.toBeUndefined();

      const repasse = await rig.livro.findRepasseById(idRepasse as never);
      expect(repasse?.status).toBe('verificando');
      expect(repasse?.interCodigoSolicitacao).toBeNull();

      const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe('verificando');
      expect(attempts[0]?.codigoSolicitacao).toBeNull();

      expect(rig.enqueued.confirmar).toEqual([
        { id: idRepasse, tentativa: 1, delay: CONFIRMAR_DELAY_INICIAL_SEGUNDOS },
      ]);

      const lancamentos = await rig.livro.findLancamentosByIds(idsLancamentos as never);
      for (const l of lancamentos) {
        expect(l.transferidoEm).toBeNull();
      }
      expect(provider.pagarPixCalls).toBe(1);
    });
  }
});

describe('executarTransferenciaRepasse — reconciliar path (crash re-delivery)', () => {
  it('re-delivered job on a transferindo repasse does NOT call pagarPix again', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedRepasseAprovado(rig);
    const provider = fake({ pagarPixOutcome: 'ambiguo' });

    // Simulate a crash BETWEEN pagarPix and the attempt-closing write: the
    // first finalizar dies, leaving the repasse in `transferindo` with an
    // open intent row — exactly what a mid-call process death leaves behind.
    vi.spyOn(rig.livro, 'finalizarTentativaTransferencia').mockRejectedValueOnce(
      new Error('simulated crash before finalizar'),
    );
    await expect(executar(rig, provider, idRepasse)).rejects.toThrow(
      'simulated crash before finalizar',
    );

    expect(provider.pagarPixCalls).toBe(1);
    const midCrash = await rig.livro.findRepasseById(idRepasse as never);
    expect(midCrash?.status).toBe('transferindo');
    const openAttempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(openAttempts).toHaveLength(1);
    expect(openAttempts[0]?.finishedAt).toBeNull(); // orphan intent row

    // pg-boss re-delivers. A payment MAY exist → divert, never re-pay.
    await executar(rig, provider, idRepasse);

    expect(provider.pagarPixCalls).toBe(1); // the double-pay door stays shut
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    expect(rig.enqueued.confirmar).toEqual([
      { id: idRepasse, tentativa: 1, delay: CONFIRMAR_DELAY_INICIAL_SEGUNDOS },
    ]);
    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('verificando');
    expect(attempts[0]?.finishedAt).not.toBeNull();
  });
});

describe('executarTransferenciaRepasse — concluido path', () => {
  it('a re-delivered job on an already-pago repasse is a no-op (pagarPixCalls 0)', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedRepasseAprovado(rig);
    await executar(rig, fake({ pagarPixOutcome: 'pago' }), idRepasse);

    const redelivered = fake({ pagarPixOutcome: 'pago' });
    await expect(executar(rig, redelivered, idRepasse)).resolves.toBeUndefined();

    expect(redelivered.pagarPixCalls).toBe(0);
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago');
    // No new attempt row, no new confirmar.
    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts).toHaveLength(1);
    expect(rig.enqueued.confirmar).toHaveLength(0);
  });
});

describe('executarTransferenciaRepasse — referencia stability (idempotency anchor)', () => {
  // VERIFIED-FIXED (aperture-oxqlf, Rex PR #8): the transitorio revert path
  // now yields a clean fresh claim on retry (not a reconciliar divert), so
  // the same stable referencia flows to pagarPix across all three attempts.
  // Flipped it.fails → it(). The falhou-retry variant below is the sibling lock.
  it('passes the IDENTICAL referencia to pagarPix across transitorio retries', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedRepasseAprovado(rig);
    const referencias: string[] = [];

    // Two transient failures, then success — three separate pagarPix calls.
    const transitorio = recordReferencias(fake({ pagarPixOutcome: 'transitorio' }), referencias);
    await expect(executar(rig, transitorio, idRepasse)).rejects.toBeInstanceOf(
      TransferenciaTransitoriaError,
    );
    await expect(executar(rig, transitorio, idRepasse)).rejects.toBeInstanceOf(
      TransferenciaTransitoriaError,
    );
    const pago = recordReferencias(fake({ pagarPixOutcome: 'pago' }), referencias);
    await executar(rig, pago, idRepasse);

    const esperada = gerarTransferReferencia(idRepasse as never);
    expect(referencias).toEqual([esperada, esperada, esperada]);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago');
    // Every attempt row carries the same referencia.
    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts.map((a) => a.referencia)).toEqual([esperada, esperada, esperada]);
  });

  it('passes the IDENTICAL deterministic referencia across falhou → retry → pago', async () => {
    const rig = await buildRig();
    const { idRepasse, referencia } = await seedRepasseAprovado(rig);
    const referencias: string[] = [];

    // Clean rejection (falhou), then admin retry succeeds — two pagarPix calls.
    const rejeitado = recordReferencias(fake({ pagarPixOutcome: 'rejeitado' }), referencias);
    await executar(rig, rejeitado, idRepasse);
    expect((await rig.livro.findRepasseById(idRepasse as never))?.status).toBe('falhou');
    const pago = recordReferencias(fake({ pagarPixOutcome: 'pago' }), referencias);
    await executar(rig, pago, idRepasse);

    const esperada = gerarTransferReferencia(idRepasse as never);
    expect(esperada).toBe(`EN${idRepasse.replace(/-/g, '')}`);
    expect(esperada).toBe(referencia);
    expect(referencias).toEqual([esperada, esperada]);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago');
    expect(repasse?.transferReferencia).toBe(esperada);
    // Every attempt row carries the same referencia.
    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts.map((a) => a.referencia)).toEqual([esperada, esperada]);
  });
});

describe('executarTransferenciaRepasse — degenerate inputs', () => {
  it('missing repasse: no-op, no throw, no pagarPix', async () => {
    const rig = await buildRig();
    const provider = fake();

    await expect(executar(rig, provider, randomUUID())).resolves.toBeUndefined();

    expect(provider.pagarPixCalls).toBe(0);
    expect(rig.enqueued.confirmar).toHaveLength(0);
  });

  it('non-pix recebedor: attempt opened + closed falhou/RECEBEDOR_NAO_PIX, no pagarPix', async () => {
    const rig = await buildRig({ metodoRecebedor: 'conta' });
    // The repo transaction does not gate on metodo (the use-case does), so a
    // mis-routed conta repasse CAN reach the queue — the handler must fail it
    // safely instead of paying without a chave.
    const { idRepasse } = await seedRepasseAprovado(rig);
    const provider = fake();

    await expect(executar(rig, provider, idRepasse)).resolves.toBeUndefined();

    expect(provider.pagarPixCalls).toBe(0);
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('RECEBEDOR_NAO_PIX');

    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('falhou');
    expect(attempts[0]?.error).toBe('RECEBEDOR_NAO_PIX');
    expect(attempts[0]?.finishedAt).not.toBeNull();
  });
});
