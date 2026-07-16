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
  extratoVerified = false,
): ConfirmarTransferenciaRepasseDeps {
  return {
    livroFinanceiroRepository: rig.livro,
    transferenciaProvider: provider,
    repasseJobEnqueuer: rig.enqueuer,
    clock: rig.clock,
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
    // aperture-477nz — default DISARMED (matches prod default): a
    // zero-candidate window exhaustion escalates to needs-manual-resolution,
    // not auto-falhou, until the extrato SHAPE is empirically verified.
    extratoVerified,
  };
}

function confirmar(
  rig: Rig,
  provider: TransferenciaProviderFake,
  idRepasse: string,
  tentativaConfirmacao: number,
  extratoVerified = false,
): Promise<void> {
  return confirmarTransferenciaRepasse(makeDeps(rig, provider, extratoVerified), {
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
  it('aperture-477nz: a valor+chave-matching search hit is NEVER auto-booked pago — it flags needs-manual-resolution, persists the candidate (chave masked), stays verificando, no consult', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: null });
    const referencia = gerarTransferReferencia(idRepasse as never);
    const provider = fake({
      buscarResultados: [
        // WRONG valor — filtered out of candidates.
        {
          codigoSolicitacao: 'inter_outro',
          valorCents: 100 as never,
          chave: CHAVE_PIX,
          referencia,
          status: 'pago',
        },
        // Matching valor+chave — becomes a candidate, but is NOT auto-pago.
        {
          codigoSolicitacao: 'inter_found',
          valorCents: VALOR_REPASSE_CENTS as never,
          chave: CHAVE_PIX,
          referencia,
          status: 'pago',
          dataMovimento: '2026-07-16',
        },
      ],
      // Provided but must NOT be consumed — confirmar does not consult a
      // search candidate; it defers to the admin.
      consultSequence: ['pago'],
    });

    await confirmar(rig, provider, idRepasse, 1);

    // NEVER auto-pago: Inter has no reliable caller-supplied identifier, so a
    // search match cannot PROVE the payment is ours. Stays verificando, flagged.
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    expect(repasse?.needsManualResolution).toBe(true);
    expect(repasse?.interCodigoSolicitacao).toBeNull();
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toBeNull(); // no debit until an admin resolves
    }
    // The single matching candidate is persisted with the chave MASKED at rest.
    const candidatos = await rig.livro.findCandidatosByRepasseId(idRepasse as never);
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]?.codigoSolicitacao).toBe('inter_found');
    expect(candidatos[0]?.valorCents).toBe(VALOR_REPASSE_CENTS);
    expect(candidatos[0]?.dataMovimento).toBe('2026-07-16');
    expect(candidatos[0]?.chaveMascarada).toBe('b***om'); // bia@example.com → b***om
    expect(candidatos[0]?.chaveMascarada).not.toContain('@'); // full chave never at rest
    // Deferred to the admin — no consult, no reschedule.
    expect(provider.consultarPagamentoCalls).toBe(0);
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('aperture-477nz: a chave-less matching hit still becomes a candidate (chave a secondary guard), persisted with chaveMascarada null', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedVerificando(rig, { codigo: null });
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
    });

    await confirmar(rig, provider, idRepasse, 1);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    expect(repasse?.needsManualResolution).toBe(true);
    const candidatos = await rig.livro.findCandidatosByRepasseId(idRepasse as never);
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]?.codigoSolicitacao).toBe('inter_sem_chave');
    expect(candidatos[0]?.chaveMascarada).toBeNull(); // no chave on the row → null
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

  // ── aperture-477nz DISARM BOUNDARY ──────────────────────────────────
  // At tentativa MAX_TENTATIVAS_CONFIRMACAO (12) the next reschedule would be
  // 13 > 12 → proximoDelayConfirmacao returns null → the ~48h window is
  // exhausted with ZERO candidates. What happens then is GATED on
  // extratoVerified (INTER_EXTRATO_VERIFIED). This is THE load-bearing
  // transition: auto-falhou here → admin retry → SECOND PIX if the "zero" was
  // actually a shape-mismatch dropping a real-but-invisible payment.

  it('DISARMED (extratoVerified=false, prod default): zero-candidate window exhaustion escalates to needs-manual-resolution — NOT auto-falhou', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: null });
    const provider = fake({ buscarResultados: [] });

    await confirmar(rig, provider, idRepasse, MAX_TENTATIVAS_CONFIRMACAO, false);

    // Flag OFF: a zero could be a shape-mismatch dropping a real payment, so a
    // human decides. Stays verificando, flagged — the double-pay door stays shut.
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    expect(repasse?.needsManualResolution).toBe(true);
    for (const l of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(l.transferidoEm).toBeNull();
    }
    // No candidates found → flagged with an empty candidate list.
    const candidatos = await rig.livro.findCandidatosByRepasseId(idRepasse as never);
    expect(candidatos).toHaveLength(0);
    // Exhausted → no further reschedule.
    expect(rig.enqueued.confirmar).toHaveLength(0);
    expect(provider.pagarPixCalls).toBe(0); // confirmar NEVER pays
  });

  it('ARMED (extratoVerified=true): zero-candidate window exhaustion resolves falhou/NAO_ENCONTRADO_NA_BUSCA (safe to retry) + audit row', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo: null });
    const provider = fake({ buscarResultados: [] });

    await confirmar(rig, provider, idRepasse, MAX_TENTATIVAS_CONFIRMACAO, true);

    // Flag ON: the extrato SHAPE is empirically trusted, so sustained absence
    // over the full window is real evidence of no payment → auto-falhou.
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('NAO_ENCONTRADO_NA_BUSCA');
    expect(repasse?.needsManualResolution).toBe(false);
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

  it('ARMED but BEFORE exhaustion (tentativa 2): zero candidates still reschedules — the flag only gates the exhaustion boundary, not early absence', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedVerificando(rig, { codigo: null });
    const provider = fake({ buscarResultados: [] });

    await confirmar(rig, provider, idRepasse, 2, true);

    expect(rig.enqueued.confirmar).toEqual([{ id: idRepasse, tentativa: 3, delay: 600 }]);
    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('verificando');
    expect(repasse?.needsManualResolution).toBe(false);
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
