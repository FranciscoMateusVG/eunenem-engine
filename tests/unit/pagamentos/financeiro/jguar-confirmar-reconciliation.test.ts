/**
 * aperture-jguar — `confirmarTransferenciaRepasse` reconciliation suite.
 *
 * Handler-level coverage of the `repasse.confirmar` job (spec §5.4):
 * consult polling to terminal states, the escalating reschedule ladder
 * (30s → 2m → 10m → 1h → 6h, 12 tentativas max, exhaustion STAYS
 * verificando), and the no-codigo reconciliation-by-search path.
 *
 * THE invariant, asserted in every single test: confirmar NEVER calls
 * pagarPix (`fake.pagarPixCalls === 0`). `verificando` is the shut
 * double-pay door — this handler only observes and resolves.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RecebedorRepositoryMemory } from '../../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import type { RepasseJobEnqueuer } from '../../../../src/adapters/pagamentos/transferencia-enqueuer.js';
import type { TransferenciaProviderFakeOptions } from '../../../../src/adapters/pagamentos/transferencia-provider.fake.js';
import { TransferenciaProviderFake } from '../../../../src/adapters/pagamentos/transferencia-provider.fake.js';
import { criarRecebedorInicial } from '../../../../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../../src/observability/tracer.js';
import { gerarTransferReferencia } from '../../../../src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
import {
  type ConfirmarTransferenciaRepasseDeps,
  confirmarTransferenciaRepasse,
  MAX_TENTATIVAS_CONFIRMACAO,
  proximoDelayConfirmacao,
} from '../../../../src/use-cases/pagamentos/financeiro/confirmar-transferencia-repasse.js';

const T0 = new Date('2026-07-16T10:00:00.000Z');
const T1 = new Date('2026-07-16T11:00:00.000Z');
const T2 = new Date('2026-07-16T12:00:00.000Z');
const CHAVE_PIX = 'bia@example.com';
/** Seeded repasse total (3000 + 1500) — what buscarPagamentos must match on. */
const VALOR_REPASSE_CENTS = 4500;

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

async function buildRig(): Promise<Rig> {
  const recebedorRepository = new RecebedorRepositoryMemory();
  const livro = new LivroFinanceiroRepositoryMemory(recebedorRepository);
  const idCampanha = randomUUID();

  await recebedorRepository.save(
    criarRecebedorInicial({
      id: randomUUID() as never,
      idCampanha: idCampanha as never,
      dadosRecebedor: {
        metodo: 'pix',
        nomeTitular: 'Bia Silva',
        cpfTitular: '52998224725',
        tipoChavePix: 'email',
        chavePix: CHAVE_PIX,
      } as never,
      criadaEm: T0,
    }),
  );

  let agora = T2;
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

/**
 * Seed a repasse all the way into `verificando` via the repository FSM
 * methods (solicitar → aprovar pix → iniciar → finalizar verificando).
 * Deliberately does NOT go through the executar handler so the ONE fake
 * under test enters every test with `pagarPixCalls === 0`.
 */
async function seedVerificando(
  rig: Rig,
  options: { codigo: string | null },
): Promise<{ idRepasse: string; idsLancamentos: string[] }> {
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
  await rig.livro.aprovarRepassePixTransaction(
    {
      idRepasse: idRepasse as never,
      aprovadoEm: T1,
      transferReferencia: gerarTransferReferencia(idRepasse as never),
    },
    async () => {},
  );
  const iniciado = await rig.livro.iniciarTransferenciaTransaction({
    idRepasse: idRepasse as never,
    requestSummary: 'seed',
    agora: T1,
  });
  await rig.livro.finalizarTentativaTransferencia({
    idRepasse: idRepasse as never,
    attemptId: iniciado.attemptId,
    resultado: { tipo: 'verificando', codigoSolicitacao: options.codigo },
    agora: T1,
  });
  return {
    idRepasse,
    idsLancamentos: [String((l1 as { id: string }).id), String((l2 as { id: string }).id)],
  };
}

function makeDeps(
  rig: Rig,
  provider: TransferenciaProviderFake,
): ConfirmarTransferenciaRepasseDeps {
  return {
    livroFinanceiroRepository: rig.livro,
    transferenciaProvider: provider,
    repasseJobEnqueuer: rig.enqueuer,
    clock: rig.clock,
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
  };
}

function confirmar(
  rig: Rig,
  provider: TransferenciaProviderFake,
  idRepasse: string,
  tentativaConfirmacao: number,
): Promise<void> {
  return confirmarTransferenciaRepasse(makeDeps(rig, provider), {
    idRepasse: idRepasse as never,
    tentativaConfirmacao,
  });
}

function fake(options: TransferenciaProviderFakeOptions = {}): TransferenciaProviderFake {
  return new TransferenciaProviderFake(options);
}

describe('confirmarTransferenciaRepasse — consult polling', () => {
  it('em_processamento → pago: first call reschedules, second resolves pago + stamps', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: 'inter_abc' });
    const provider = fake({ consultSequence: ['em_processamento', 'pago'] });

    // Tentativa 1: non-terminal → reschedule with the NEXT delay (tentativa 2 → 2m).
    await confirmar(rig, provider, idRepasse, 1);
    expect(rig.enqueued.confirmar).toEqual([{ id: idRepasse, tentativa: 2, delay: 120 }]);
    let repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toBeNull();
    }

    // Tentativa 2: terminal pago → resolve + stamp transferidoEm.
    await confirmar(rig, provider, idRepasse, 2);
    repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago');
    expect(repasse?.interCodigoSolicitacao).toBe('inter_abc');
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toEqual(T2);
    }
    expect(rig.enqueued.confirmar).toHaveLength(1); // no further reschedule
    expect(provider.consultarPagamentoCalls).toBe(2);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('consult → rejeitado resolves falhou with erro CONSULTA_REJEITADO (admin-retryable)', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: 'inter_abc' });
    const provider = fake({ consultSequence: ['rejeitado'] });

    await confirmar(rig, provider, idRepasse, 1);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('CONSULTA_REJEITADO');
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toBeNull();
    }
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('consult → cancelado resolves falhou with erro CONSULTA_CANCELADO (admin-retryable)', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedVerificando(rig, { codigo: 'inter_abc' });
    const provider = fake({ consultSequence: ['cancelado'] });

    await confirmar(rig, provider, idRepasse, 1);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('CONSULTA_CANCELADO');
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('aguardando_aprovacao (Inter-side approval still pending) reschedules', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedVerificando(rig, { codigo: 'inter_abc' });
    const provider = fake({ consultSequence: ['aguardando_aprovacao'] });

    await confirmar(rig, provider, idRepasse, 2);

    expect(rig.enqueued.confirmar).toEqual([{ id: idRepasse, tentativa: 3, delay: 600 }]);
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });
});

describe('confirmarTransferenciaRepasse — escalation schedule', () => {
  it('proximoDelayConfirmacao ladder: 30/120/600/3600, then 21600, null past 12', () => {
    expect(proximoDelayConfirmacao(1)).toBe(30);
    expect(proximoDelayConfirmacao(2)).toBe(120);
    expect(proximoDelayConfirmacao(3)).toBe(600);
    expect(proximoDelayConfirmacao(4)).toBe(3600);
    for (let tentativa = 5; tentativa <= MAX_TENTATIVAS_CONFIRMACAO; tentativa += 1) {
      expect(proximoDelayConfirmacao(tentativa)).toBe(21600);
    }
    expect(proximoDelayConfirmacao(MAX_TENTATIVAS_CONFIRMACAO + 1)).toBeNull();
  });

  it('tentativa 12 without resolution exhausts: STAYS verificando, no further enqueue, never stamps', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: 'inter_abc' });
    const provider = fake({ consultSequence: ['em_processamento'] });

    await confirmar(rig, provider, idRepasse, MAX_TENTATIVAS_CONFIRMACAO);

    // Never guess: the repasse stays verificando for the operator, and the
    // schedule stops (enqueuer NOT called).
    expect(rig.enqueued.confirmar).toHaveLength(0);
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toBeNull();
    }
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });
});

describe('confirmarTransferenciaRepasse — no-codigo reconciliation via buscarPagamentos', () => {
  it('adopts the codigoSolicitacao of a valor+referencia-matching search hit, then resolves via consult', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: null });
    // s8v26 fix: referencia is the STRONG match key. A matching hit MUST
    // carry the repasse's stable referencia (what we sent to Inter).
    const referencia = gerarTransferReferencia(idRepasse as never);
    const provider = fake({
      buscarResultados: [
        // Same referencia but WRONG valor — must be skipped: valor is an
        // AND-guard alongside referencia, not subsumed by it.
        {
          codigoSolicitacao: 'inter_outro',
          valorCents: 100 as never,
          chave: CHAVE_PIX,
          referencia,
          status: 'pago',
        },
        {
          codigoSolicitacao: 'inter_found',
          valorCents: VALOR_REPASSE_CENTS as never,
          chave: CHAVE_PIX,
          referencia,
          status: 'pago',
        },
      ],
      consultSequence: ['pago'],
    });

    await confirmar(rig, provider, idRepasse, 1);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago');
    expect(repasse?.interCodigoSolicitacao).toBe('inter_found');
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toEqual(T2);
    }
    expect(provider.consultarPagamentoCalls).toBe(1);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('is chave-tolerant: a referencia+valor-matching hit with no chave still matches (chave is a secondary guard)', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedVerificando(rig, { codigo: null });
    // referencia already pins payment identity, so an absent chave on the
    // search row is tolerated (chave is only an extra guard, never the key).
    const referencia = gerarTransferReferencia(idRepasse as never);
    const provider = fake({
      buscarResultados: [
        {
          codigoSolicitacao: 'inter_sem_chave',
          valorCents: VALOR_REPASSE_CENTS as never,
          referencia,
          status: 'pago',
        },
      ],
      consultSequence: ['pago'],
    });

    await confirmar(rig, provider, idRepasse, 1);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago');
    expect(repasse?.interCodigoSolicitacao).toBe('inter_sem_chave');
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('empty search on tentativa 1 reschedules (payment may not be visible yet)', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedVerificando(rig, { codigo: null });
    const provider = fake({ buscarResultados: [] });

    await confirmar(rig, provider, idRepasse, 1);

    expect(rig.enqueued.confirmar).toEqual([{ id: idRepasse, tentativa: 2, delay: 120 }]);
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    expect(provider.consultarPagamentoCalls).toBe(0); // nothing to consult
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('empty search BEFORE the window is exhausted (tentativa 2) reschedules — never early-falhou (amended §5.4)', async () => {
    // AMENDED §5.4 (spec branch aperture-8mivl-inter-repasse-spec): absence
    // of candidates is only strong evidence AFTER the full ~48h escalation.
    // The old handler declared falhou at `tentativa >= 2` (~2.5min) — a real
    // in-flight PIX lagging in Inter's search index would be falsely falhou'd
    // → admin retry → SECOND PIX. Rex's amended handler reschedules until the
    // window is exhausted. This locks that: tentativa 2 empty → reschedule to 3.
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: null });
    const provider = fake({ buscarResultados: [] });

    await confirmar(rig, provider, idRepasse, 2);

    // tentativa 3 delay = DELAYS_CURTOS[2] = 600s. Reschedules, not falhou.
    expect(rig.enqueued.confirmar).toEqual([{ id: idRepasse, tentativa: 3, delay: 600 }]);
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toBeNull();
    }
    expect(provider.consultarPagamentoCalls).toBe(0); // nothing adopted to consult
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('empty search at the EXHAUSTED window (tentativa 12) resolves falhou/NAO_ENCONTRADO_NA_BUSCA (safe to retry)', async () => {
    // At tentativa MAX_TENTATIVAS_CONFIRMACAO (12) the next reschedule would be
    // 13 > 12 → proximoDelayConfirmacao returns null → sustained-absence over
    // the full window is now real evidence of no payment → auto-falhou. This
    // is the amended-§5.4 "zero candidates across 48h → falhou" boundary.
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: null });
    const provider = fake({ buscarResultados: [] });

    await confirmar(rig, provider, idRepasse, MAX_TENTATIVAS_CONFIRMACAO);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('NAO_ENCONTRADO_NA_BUSCA');
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toBeNull();
    }
    // The reconciliation resolve writes an audit row.
    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    expect(attempts.at(-1)?.outcome).toBe('falhou');
    expect(attempts.at(-1)?.error).toBe('NAO_ENCONTRADO_NA_BUSCA');
    // Exhausted → no further reschedule.
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });
});

describe('confirmarTransferenciaRepasse — no-ops', () => {
  it('a non-verificando repasse (aprovado) is a no-op: no consult, no enqueue, no state change', async () => {
    const rig = await buildRig();
    const l1 = makeLancamento({ idCampanha: rig.idCampanha, amountCents: 4500 });
    await rig.livro.saveLancamentos([l1]);
    const idRepasse = randomUUID();
    await rig.livro.solicitarRepasseTransaction({
      idCampanha: rig.idCampanha as never,
      idRepasse: idRepasse as never,
      solicitadoEm: T0,
      now: T0,
    });
    await rig.livro.aprovarRepassePixTransaction(
      {
        idRepasse: idRepasse as never,
        aprovadoEm: T1,
        transferReferencia: gerarTransferReferencia(idRepasse as never),
      },
      async () => {},
    );
    const provider = fake({ consultSequence: ['pago'] });

    await confirmar(rig, provider, idRepasse, 1);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('aprovado');
    expect(provider.consultarPagamentoCalls).toBe(0);
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('an already-pago repasse is a no-op (late-arriving confirmar job)', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedVerificando(rig, { codigo: 'inter_abc' });
    // First confirmar resolves pago…
    await confirmar(rig, fake({ consultSequence: ['pago'] }), idRepasse, 1);
    // …a stale duplicate job arrives later.
    const provider = fake({ consultSequence: ['rejeitado'] });
    await confirmar(rig, provider, idRepasse, 2);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago'); // the stale rejeitado consult never ran
    expect(provider.consultarPagamentoCalls).toBe(0);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('a missing repasse is a no-op, no throw', async () => {
    const rig = await buildRig();
    const provider = fake();

    await expect(confirmar(rig, provider, randomUUID(), 1)).resolves.toBeUndefined();

    expect(provider.consultarPagamentoCalls).toBe(0);
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });
});
