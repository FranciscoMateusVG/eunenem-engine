/**
 * aperture-jguar — Tier 3 ADVERSARIAL suite (unit level, memory adapter).
 *
 * The invariant under attack: **at most one successful PIX per repasse,
 * ever** — plus the §10.1 ledger corollaries (transferido_em stamped at
 * `pago` only, exactly once, never a compensating entry).
 *
 * Each describe block is an attack on one §6 enforcement layer:
 *   L2 — stable transfer_referencia across retry storms
 *   L4 — ambiguity never auto-retries / no pagarPix from `verificando`
 *   L5 — retry only from `falhou`
 *   funds-claim — the id_repasse lock (second-sweep attack)
 *   reconciliation-by-search — cross-match adoption (s8v26, VERIFIED-FIXED)
 *
 * True concurrency races (FOR UPDATE interleavings) are NOT reproducible
 * against the memory adapter — those live in
 * tests/integration/jguar-*.postgres.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RecebedorRepositoryMemory } from '../../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import {
  TransferenciaProviderFake,
  type TransferenciaProviderFakeOptions,
} from '../../../../src/adapters/pagamentos/transferencia-provider.fake.js';
import type {
  PagamentoEncontrado,
  PagarPixInput,
  PagarPixOutcome,
} from '../../../../src/adapters/pagamentos/transferencia-provider.js';
import { criarRecebedorInicial } from '../../../../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../../src/observability/tracer.js';
import { gerarTransferReferencia } from '../../../../src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
import { confirmarTransferenciaRepasse } from '../../../../src/use-cases/pagamentos/financeiro/confirmar-transferencia-repasse.js';
import { executarTransferenciaRepasse } from '../../../../src/use-cases/pagamentos/financeiro/executar-transferencia-repasse.js';

const T0 = new Date('2026-07-16T10:00:00.000Z');
const T1 = new Date('2026-07-16T11:00:00.000Z');

const CHAVE_COMPARTILHADA = 'bia@example.com';

/**
 * Fake that additionally records every pagarPix input — the stock fake
 * only counts calls; the L2 attack needs the referencia of EVERY attempt.
 */
class RecordingTransferenciaFake extends TransferenciaProviderFake {
  readonly pagarPixInputs: PagarPixInput[] = [];

  constructor(options: TransferenciaProviderFakeOptions = {}) {
    super(options);
  }

  override async pagarPix(input: PagarPixInput): Promise<PagarPixOutcome> {
    this.pagarPixInputs.push(input);
    return super.pagarPix(input);
  }
}

interface Lab {
  readonly recebedorRepository: RecebedorRepositoryMemory;
  readonly livro: LivroFinanceiroRepositoryMemory;
  readonly enqueued: {
    executar: string[];
    confirmar: Array<{ id: string; tentativa: number; delay: number }>;
  };
  readonly repasseJobEnqueuer: {
    enqueueExecutar(data: { idRepasse: string }): Promise<void>;
    enqueueConfirmar(
      data: { idRepasse: string; tentativaConfirmacao: number },
      delaySeconds: number,
    ): Promise<void>;
  };
  readonly observability: { logger: NoopLogger; tracer: ReturnType<typeof noopTracer> };
  readonly clock: () => Date;
}

function buildLab(): Lab {
  const recebedorRepository = new RecebedorRepositoryMemory();
  const livro = new LivroFinanceiroRepositoryMemory(recebedorRepository);
  const enqueued = {
    executar: [] as string[],
    confirmar: [] as Array<{ id: string; tentativa: number; delay: number }>,
  };
  const repasseJobEnqueuer = {
    async enqueueExecutar(data: { idRepasse: string }) {
      enqueued.executar.push(data.idRepasse);
    },
    async enqueueConfirmar(
      data: { idRepasse: string; tentativaConfirmacao: number },
      delaySeconds: number,
    ) {
      enqueued.confirmar.push({
        id: data.idRepasse,
        tentativa: data.tentativaConfirmacao,
        delay: delaySeconds,
      });
    },
  };
  return {
    recebedorRepository,
    livro,
    enqueued,
    repasseJobEnqueuer,
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
    clock: () => T1,
  };
}

async function seedCampanhaComRecebedorPix(lab: Lab, chavePix: string): Promise<string> {
  const idCampanha = randomUUID();
  const recebedor = criarRecebedorInicial({
    id: randomUUID() as never,
    idCampanha: idCampanha as never,
    dadosRecebedor: {
      metodo: 'pix',
      nomeTitular: 'Bia Silva',
      cpfTitular: '52998224725',
      tipoChavePix: 'email',
      chavePix,
    } as never,
    criadaEm: T0,
  });
  await lab.recebedorRepository.save(recebedor);
  return idCampanha;
}

function makeLancamento(args: { idCampanha: string; amountCents: number }) {
  return {
    id: randomUUID() as never,
    idPagamento: randomUUID() as never,
    idContribuicao: randomUUID() as never,
    idCampanha: args.idCampanha as never,
    tipo: 'credito_saldo_recebedor' as never,
    amountCents: args.amountCents as never,
    criadoEm: T0,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
  } as never;
}

/** Seed lançamentos + solicitar a repasse claiming them. Returns idRepasse. */
async function seedRepasseSolicitado(
  lab: Lab,
  idCampanha: string,
  amounts: readonly number[],
): Promise<string> {
  await lab.livro.saveLancamentos(
    amounts.map((a) => makeLancamento({ idCampanha, amountCents: a })),
  );
  const idRepasse = randomUUID();
  await lab.livro.solicitarRepasseTransaction({
    idCampanha: idCampanha as never,
    idRepasse: idRepasse as never,
    solicitadoEm: T0,
    now: T0,
  });
  return idRepasse;
}

async function aprovarPix(lab: Lab, idRepasse: string): Promise<string> {
  const referencia = gerarTransferReferencia(idRepasse as never);
  await lab.livro.aprovarRepassePixTransaction(
    { idRepasse: idRepasse as never, aprovadoEm: T1, transferReferencia: referencia },
    async () => {
      /* enqueue observed elsewhere; not under test here */
    },
  );
  return referencia;
}

function depsWith(lab: Lab, fake: TransferenciaProviderFake) {
  return {
    livroFinanceiroRepository: lab.livro,
    transferenciaProvider: fake,
    repasseJobEnqueuer: lab.repasseJobEnqueuer as never,
    clock: lab.clock,
    observability: lab.observability as never,
  } as never;
}

async function lancamentosDoRepasse(lab: Lab, idRepasse: string) {
  return lab.livro.findLancamentosByIdRepasse(idRepasse as never);
}

/**
 * Force an approved repasse into `verificando` with NO codigoSolicitacao —
 * the exact state the executar ambiguous-throw path produces — via direct
 * repo calls. Kept as a direct-seed helper (independent of the executar
 * handler) so each reconciliation test enters with pagarPixCalls === 0 and a
 * known verificando/no-codigo state. Historically this also side-stepped
 * IMPL-GAP B (aperture-oxqlf, the detached-method TypeError in the executar
 * catch block) — now VERIFIED-FIXED in Rex PR #8; the helper stays valid.
 */
async function forcarVerificandoSemCodigo(lab: Lab, idRepasse: string): Promise<void> {
  const iniciado = await lab.livro.iniciarTransferenciaTransaction({
    idRepasse: idRepasse as never,
    requestSummary: 'adversarial:seed-verificando',
    agora: T1,
  });
  await lab.livro.finalizarTentativaTransferencia({
    idRepasse: idRepasse as never,
    attemptId: iniciado.attemptId,
    resultado: { tipo: 'verificando', codigoSolicitacao: null } as never,
    agora: T1,
  } as never);
}

describe('jguar Tier 3 — adversarial double-pay hunt (memory level)', () => {
  it('rig smoke: happy path pago stamps every linked lançamento exactly once', async () => {
    const lab = buildLab();
    const idCampanha = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
    const idRepasse = await seedRepasseSolicitado(lab, idCampanha, [3000, 1500]);
    const referencia = await aprovarPix(lab, idRepasse);

    const fake = new RecordingTransferenciaFake({ pagarPixOutcome: 'pago' });
    await executarTransferenciaRepasse(depsWith(lab, fake), { idRepasse: idRepasse as never });

    const repasse = await lab.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('pago');
    expect(fake.pagarPixCalls).toBe(1);
    expect(fake.pagarPixInputs[0]?.referencia).toBe(referencia);
    const linked = await lancamentosDoRepasse(lab, idRepasse);
    expect(linked).toHaveLength(2);
    for (const l of linked) expect(l.transferidoEm).toEqual(T1);
  });

  describe('L2 attack — retry storm must never mint a new payment identity', () => {
    // VERIFIED-FIXED (aperture-oxqlf, Rex PR #8, staging 1cd53c3): the handler
    // previously detached `finalizarTentativaTransferencia` into a `const`, so
    // every call in the pagarPix catch block ran with `this === undefined` and
    // BOTH adapters TypeError'd on the transitorio/ambiguo/timeout paths,
    // wedging the repasse in `transferindo`. Rex now invokes the method on the
    // repository directly. This test asserts the CORRECT §5.3d/§6.2 contract;
    // flipped it.fails → it() as the in-suite regression lock.
    it('4 transient attempts all carry the IDENTICAL referencia; exhaustion lands falhou with ledger untouched', async () => {
      const lab = buildLab();
      const idCampanha = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idRepasse = await seedRepasseSolicitado(lab, idCampanha, [4500]);
      const referencia = await aprovarPix(lab, idRepasse);

      const fake = new RecordingTransferenciaFake({ pagarPixOutcome: 'transitorio' });
      const deps = depsWith(lab, fake);

      // Attempts 1..3: transitorio closes the attempt and RETHROWS so
      // pg-boss retries; the repasse reverts to aprovado each time.
      for (let attempt = 1; attempt <= 3; attempt++) {
        await expect(
          executarTransferenciaRepasse(deps, { idRepasse: idRepasse as never }),
        ).rejects.toThrow();
        const mid = await lab.livro.findRepasseById(idRepasse as never);
        expect(mid?.status).toBe('aprovado');
        expect(mid?.transferAttempts).toBe(attempt);
      }

      // Attempt 4: MAX_TENTATIVAS_TRANSITORIAS reached → falhou, NO rethrow.
      await expect(
        executarTransferenciaRepasse(deps, { idRepasse: idRepasse as never }),
      ).resolves.toBeUndefined();

      const final = await lab.livro.findRepasseById(idRepasse as never);
      expect(final?.status).toBe('falhou');
      expect(final?.lastTransferError).toBe('TRANSITORIO_ESGOTADO');
      expect(final?.transferAttempts).toBe(4);

      // The storm's payment identity never drifted.
      expect(fake.pagarPixCalls).toBe(4);
      expect(new Set(fake.pagarPixInputs.map((i) => i.referencia))).toEqual(new Set([referencia]));

      // §10.1: a falhou repasse debits NOTHING and books NOTHING new.
      const linked = await lancamentosDoRepasse(lab, idRepasse);
      expect(linked).toHaveLength(1);
      expect(linked[0]?.transferidoEm).toBeNull();
      expect(linked[0]?.idRepasse).toBe(idRepasse); // still locked to the repasse
    });
  });

  describe('L4 attack — verificando is a shut door', () => {
    it('re-delivered executar against a verificando repasse never calls pagarPix', async () => {
      const lab = buildLab();
      const idCampanha = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idRepasse = await seedRepasseSolicitado(lab, idCampanha, [4500]);
      await aprovarPix(lab, idRepasse);

      // A payment MAY exist at Inter (crash after send) → verificando.
      // Seeded via direct repo calls — see forcarVerificandoSemCodigo/IMPL-GAP B.
      await forcarVerificandoSemCodigo(lab, idRepasse);
      expect((await lab.livro.findRepasseById(idRepasse as never))?.status).toBe('verificando');

      // pg-boss re-delivers the executar job. The fresh provider must
      // receive ZERO pagarPix calls — the double-pay door stays shut.
      const fake2 = new RecordingTransferenciaFake({ pagarPixOutcome: 'pago' });
      await executarTransferenciaRepasse(depsWith(lab, fake2), {
        idRepasse: idRepasse as never,
      });
      expect(fake2.pagarPixCalls).toBe(0);
      expect((await lab.livro.findRepasseById(idRepasse as never))?.status).toBe('verificando');
    });

    it('poison consult flapping (em_processamento/aguardando_aprovacao) only ever reschedules; terminal rejeitado lands falhou; retry then pays and stamps EXACTLY once', async () => {
      const lab = buildLab();
      const idCampanha = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idRepasse = await seedRepasseSolicitado(lab, idCampanha, [4500]);
      await aprovarPix(lab, idRepasse);

      // Inter parks the payment in its own approval workflow → verificando
      // WITH a codigoSolicitacao (the consult path, not the search path).
      const fakeExec = new RecordingTransferenciaFake({ pagarPixOutcome: 'agendado_aprovacao' });
      await executarTransferenciaRepasse(depsWith(lab, fakeExec), {
        idRepasse: idRepasse as never,
      });
      expect((await lab.livro.findRepasseById(idRepasse as never))?.status).toBe('verificando');
      expect(
        (await lab.livro.findRepasseById(idRepasse as never))?.interCodigoSolicitacao,
      ).not.toBeNull();

      // Flapping, contradictory, non-terminal consults — the reconciler
      // must never guess and never pay.
      const fakeConfirm = new RecordingTransferenciaFake({
        consultSequence: [
          'em_processamento',
          'aguardando_aprovacao',
          'em_processamento',
          'rejeitado',
        ],
      });
      const confirmDeps = depsWith(lab, fakeConfirm);
      const expectedDelays = [120, 600, 3600]; // proxima tentativa 2, 3, 4
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        await confirmarTransferenciaRepasse(confirmDeps, {
          idRepasse: idRepasse as never,
          tentativaConfirmacao: tentativa,
        });
        expect((await lab.livro.findRepasseById(idRepasse as never))?.status).toBe('verificando');
        expect(lab.enqueued.confirmar.at(-1)).toEqual({
          id: idRepasse,
          tentativa: tentativa + 1,
          delay: expectedDelays[tentativa - 1],
        });
      }

      // Terminal rejeitado → falhou (positive knowledge: no money moved).
      await confirmarTransferenciaRepasse(confirmDeps, {
        idRepasse: idRepasse as never,
        tentativaConfirmacao: 4,
      });
      const failed = await lab.livro.findRepasseById(idRepasse as never);
      expect(failed?.status).toBe('falhou');
      expect(failed?.lastTransferError).toBe('CONSULTA_REJEITADO');
      expect(fakeConfirm.pagarPixCalls).toBe(0); // the reconciler NEVER pays

      // Ledger untouched through the whole ordeal.
      let linked = await lancamentosDoRepasse(lab, idRepasse);
      expect(linked[0]?.transferidoEm).toBeNull();

      // Admin retry from falhou → pago. Stamp fires EXACTLY once.
      const fakeRetry = new RecordingTransferenciaFake({ pagarPixOutcome: 'pago' });
      await executarTransferenciaRepasse(depsWith(lab, fakeRetry), {
        idRepasse: idRepasse as never,
      });
      const paid = await lab.livro.findRepasseById(idRepasse as never);
      expect(paid?.status).toBe('pago');
      linked = await lancamentosDoRepasse(lab, idRepasse);
      expect(linked[0]?.transferidoEm).toEqual(T1);

      // Post-pago double-stamp attempts must all be inert:
      // (a) a stale resolverVerificacao pago is a no-op off `verificando`;
      await lab.livro.resolverVerificacaoTransferencia({
        idRepasse: idRepasse as never,
        resultado: { tipo: 'pago', codigoSolicitacao: 'inter_stale_dup' } as never,
        reconciliacaoResumo: 'adversarial:stale-duplicate',
        agora: new Date('2026-07-16T12:00:00.000Z'),
      } as never);
      // (b) a stale re-delivered executar is concluido (0 pagarPix calls).
      const fakeStale = new RecordingTransferenciaFake({ pagarPixOutcome: 'pago' });
      await executarTransferenciaRepasse(depsWith(lab, fakeStale), {
        idRepasse: idRepasse as never,
      });
      expect(fakeStale.pagarPixCalls).toBe(0);

      linked = await lancamentosDoRepasse(lab, idRepasse);
      expect(linked[0]?.transferidoEm).toEqual(T1); // original stamp, unchanged
      const still = await lab.livro.findRepasseById(idRepasse as never);
      expect(still?.status).toBe('pago');
    });

    it('exhausted confirmation window STAYS verificando — the system never guesses', async () => {
      const lab = buildLab();
      const idCampanha = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idRepasse = await seedRepasseSolicitado(lab, idCampanha, [4500]);
      await aprovarPix(lab, idRepasse);

      const fakeExec = new RecordingTransferenciaFake({ pagarPixOutcome: 'agendado_aprovacao' });
      await executarTransferenciaRepasse(depsWith(lab, fakeExec), {
        idRepasse: idRepasse as never,
      });

      // Tentativa 12 (the max) still non-terminal → reagendar computes the
      // 13th delay as null → stays verificando, NO further enqueue.
      const fakeConfirm = new RecordingTransferenciaFake({
        consultSequence: ['em_processamento'],
      });
      const before = lab.enqueued.confirmar.length;
      await confirmarTransferenciaRepasse(depsWith(lab, fakeConfirm), {
        idRepasse: idRepasse as never,
        tentativaConfirmacao: 12,
      });
      expect(lab.enqueued.confirmar.length).toBe(before); // nothing re-enqueued
      const repasse = await lab.livro.findRepasseById(idRepasse as never);
      expect(repasse?.status).toBe('verificando');
      const linked = await lancamentosDoRepasse(lab, idRepasse);
      expect(linked[0]?.transferidoEm).toBeNull();
    });
  });

  describe('L5 boundary — what can re-enter transferindo', () => {
    it('DESIGN-NOTE: a stale executar re-delivery after falhou re-fires pagarPix without an admin — the single-pay invariant still holds because falhou = positive no-money-moved', async () => {
      // Reachable window: finalizar(falhou) commits, then the process dies
      // BEFORE pg-boss acks the job → re-delivery finds `falhou`, which is
      // fresh-claimable (it is the admin-retry source state; the iniciar
      // layer cannot distinguish machine re-delivery from admin intent).
      // Spec §5.3d says permanent rejections "surface to the admin" — this
      // window auto-retries them instead. NOT an invariant breach (falhou
      // guarantees no payment exists), but flagged to Rex as a design note
      // on aperture-jguar. If the retry-source guard ever tightens, this
      // test flips to expect pagarPixCalls === 0.
      const lab = buildLab();
      const idCampanha = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idRepasse = await seedRepasseSolicitado(lab, idCampanha, [4500]);
      const referencia = await aprovarPix(lab, idRepasse);

      const fakeReject = new RecordingTransferenciaFake({ pagarPixOutcome: 'rejeitado' });
      await executarTransferenciaRepasse(depsWith(lab, fakeReject), {
        idRepasse: idRepasse as never,
      });
      expect((await lab.livro.findRepasseById(idRepasse as never))?.status).toBe('falhou');

      const fakeReplay = new RecordingTransferenciaFake({ pagarPixOutcome: 'pago' });
      await executarTransferenciaRepasse(depsWith(lab, fakeReplay), {
        idRepasse: idRepasse as never,
      });

      // Current behavior: the replay claims falhou and pays.
      expect(fakeReplay.pagarPixCalls).toBe(1);
      // The invariant that matters survives: same identity, single success,
      // single stamp.
      expect(fakeReplay.pagarPixInputs[0]?.referencia).toBe(referencia);
      const repasse = await lab.livro.findRepasseById(idRepasse as never);
      expect(repasse?.status).toBe('pago');
      const linked = await lancamentosDoRepasse(lab, idRepasse);
      expect(linked[0]?.transferidoEm).toEqual(T1);
    });
  });

  describe('funds-claim attack — the second sweep', () => {
    it('a new solicitar over a campanha with an in-flight (falhou) repasse sweeps ONLY unclaimed lançamentos', async () => {
      const lab = buildLab();
      const idCampanha = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idRepasse1 = await seedRepasseSolicitado(lab, idCampanha, [3000, 1500]);
      await aprovarPix(lab, idRepasse1);

      // Drive R1 to falhou — its lançamentos stay locked (id_repasse set,
      // transferido_em null: earmarked, not lost, not available).
      const fakeReject = new RecordingTransferenciaFake({ pagarPixOutcome: 'rejeitado' });
      await executarTransferenciaRepasse(depsWith(lab, fakeReject), {
        idRepasse: idRepasse1 as never,
      });
      expect((await lab.livro.findRepasseById(idRepasse1 as never))?.status).toBe('falhou');

      // Fresh donation arrives after the failed sweep.
      await lab.livro.saveLancamentos([makeLancamento({ idCampanha, amountCents: 2000 })]);

      // The disponivel bucket must expose ONLY the unclaimed lançamento.
      const disponiveis = await lab.livro.findLancamentosDisponiveisByIdCampanha(
        idCampanha as never,
        T1,
      );
      expect(disponiveis).toHaveLength(1);
      expect(disponiveis[0]?.amountCents).toBe(2000);

      // Second sweep: claims exactly that lançamento — never R1's funds.
      const idRepasse2 = randomUUID();
      const { repasse: r2 } = await lab.livro.solicitarRepasseTransaction({
        idCampanha: idCampanha as never,
        idRepasse: idRepasse2 as never,
        solicitadoEm: T1,
        now: T1,
      });
      expect(r2.amountCents).toBe(2000);

      const r1Linked = await lancamentosDoRepasse(lab, idRepasse1);
      expect(r1Linked).toHaveLength(2);
      for (const l of r1Linked) {
        expect(l.idRepasse).toBe(idRepasse1); // still R1's — not re-swept
        expect(l.transferidoEm).toBeNull();
      }
      const r2Linked = await lancamentosDoRepasse(lab, idRepasse2);
      expect(r2Linked).toHaveLength(1);
      expect(r2Linked[0]?.amountCents).toBe(2000);
    });

    it('cancel from falhou releases EXACTLY the linked lançamentos back to disponivel', async () => {
      const lab = buildLab();
      const idCampanha = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idRepasse = await seedRepasseSolicitado(lab, idCampanha, [3000, 1500]);
      await aprovarPix(lab, idRepasse);

      // Unrelated neighbour lançamento must be untouched by the release.
      await lab.livro.saveLancamentos([makeLancamento({ idCampanha, amountCents: 999 })]);

      const fakeReject = new RecordingTransferenciaFake({ pagarPixOutcome: 'rejeitado' });
      await executarTransferenciaRepasse(depsWith(lab, fakeReject), {
        idRepasse: idRepasse as never,
      });

      await lab.livro.cancelarRepasseTransaction({
        idRepasse: idRepasse as never,
        canceladoPor: 'admin-test' as never,
        agora: T1,
      } as never);

      const repasse = await lab.livro.findRepasseById(idRepasse as never);
      expect(repasse?.status).toBe('cancelado');

      // Both R1 lançamentos released; the neighbour untouched; total
      // disponivel = 3000 + 1500 + 999 and nothing was ever stamped.
      const disponiveis = await lab.livro.findLancamentosDisponiveisByIdCampanha(
        idCampanha as never,
        T1,
      );
      const amounts = disponiveis.map((l) => l.amountCents).sort((a, b) => a - b);
      expect(amounts).toEqual([999, 1500, 3000]);
      for (const l of disponiveis) {
        expect(l.idRepasse).toBeNull();
        expect(l.transferidoEm).toBeNull();
      }
    });
  });

  describe('reconciliation-by-search cross-match (IMPL-GAP A — filed against aperture-vvh2j)', () => {
    // VERIFIED-FIXED (aperture-s8v26 P0, Rex PR #8, staging 1cd53c3): the
    // original confirmar match was valorCents + a chave-TOLERANT predicate
    // with NO referencia discrimination, so two same-amount repasses to the
    // same chave (one person, two campanhas) could cross-adopt one PIX →
    // double-settlement of a single payment. Rex added a REQUIRED `referencia`
    // to PagamentoEncontrado and made it the STRONG match key
    // (confirmar-transferencia-repasse.ts): a candidate is adopted only when
    // p.referencia === repasse.transferReferencia. These tests now assert the
    // CORRECT contract (flipped it.fails → it()) and are STRENGTHENED to carry
    // R1's REAL referencia, so they exercise genuine referencia discrimination
    // rather than the degenerate "undefined never matches".
    //
    // DRIFT NOTE (surfaced to GLaDOS — NOT a re-file of s8v26): amended spec
    // §5.4 goes further than Rex's fix. Inter cannot round-trip referencia at
    // all, so buscarPagamentos must NEVER auto-book `pago`; ANY candidate →
    // `verificando` flagged for HUMAN resolution (resolverManualPago/Falhou).
    // PR #8 still AUTO-books on referencia match (the pre-amendment model);
    // the flagged state + resolverManual* mutations are not yet implemented.
    // The invariant assertions below are written DRIFT-STABLE — they hold
    // under BOTH the current auto-book impl and the future human-resolved
    // model: "one PIX never settles two repasses" and "R2 never adopts R1's
    // payment" are true either way.

    async function seedTwoVerificandoSameChaveSameAmount(lab: Lab) {
      const idCampanha1 = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idCampanha2 = await seedCampanhaComRecebedorPix(lab, CHAVE_COMPARTILHADA);
      const idRepasse1 = await seedRepasseSolicitado(lab, idCampanha1, [4500]);
      const idRepasse2 = await seedRepasseSolicitado(lab, idCampanha2, [4500]);
      const referencia1 = await aprovarPix(lab, idRepasse1);
      const referencia2 = await aprovarPix(lab, idRepasse2);
      // Both crash before capturing a codigo → verificando, codigo null.
      await forcarVerificandoSemCodigo(lab, idRepasse1);
      await forcarVerificandoSemCodigo(lab, idRepasse2);
      return { idRepasse1, idRepasse2, referencia1, referencia2 };
    }

    /**
     * The ONE real payment at Inter — it belongs to repasse 1 and (per Rex's
     * s8v26 fix) carries repasse 1's stable referencia echoed on the search
     * record. repasse 2 must REJECT it because EN<r1> ≠ EN<r2>.
     */
    function pagamentoRealDoRepasse1(referencia1: string): PagamentoEncontrado {
      return {
        codigoSolicitacao: 'inter_real_payment_r1',
        valorCents: 4500 as never,
        chave: CHAVE_COMPARTILHADA,
        referencia: referencia1,
        status: 'pago',
      };
    }

    it('confirmar must NOT adopt a same-valor/same-chave payment that belongs to another repasse', async () => {
      const lab = buildLab();
      const { idRepasse2, referencia1 } = await seedTwoVerificandoSameChaveSameAmount(lab);

      // R2 reconciles first and finds R1's REAL payment (carrying R1's
      // referencia) in the search window. valor + chave match, but the
      // strong referencia key does NOT (EN<r1> ≠ EN<r2>).
      const fake = new RecordingTransferenciaFake({
        buscarResultados: [pagamentoRealDoRepasse1(referencia1)],
        consultSequence: ['pago'],
      });
      await confirmarTransferenciaRepasse(depsWith(lab, fake), {
        idRepasse: idRepasse2 as never,
        tentativaConfirmacao: 1,
      });

      // s8v26 fix: R2 does NOT settle off R1's payment (drift-stable).
      const r2 = await lab.livro.findRepasseById(idRepasse2 as never);
      expect(r2?.status).not.toBe('pago');
      // No codigo was adopted, so no consult was even reached for R2.
      expect(fake.consultarPagamentoCalls).toBe(0);
      const r2Linked = await lancamentosDoRepasse(lab, idRepasse2);
      expect(r2Linked[0]?.transferidoEm).toBeNull();
    });

    it('one real payment must never resolve TWO repasses to pago (double-settlement of a single PIX)', async () => {
      const lab = buildLab();
      const { idRepasse1, idRepasse2, referencia1 } =
        await seedTwoVerificandoSameChaveSameAmount(lab);

      // Both repasses reconcile against the same search reality: the single
      // real payment that belongs to R1 (carrying R1's referencia).
      for (const id of [idRepasse1, idRepasse2]) {
        const fake = new RecordingTransferenciaFake({
          buscarResultados: [pagamentoRealDoRepasse1(referencia1)],
          consultSequence: ['pago'],
        });
        await confirmarTransferenciaRepasse(depsWith(lab, fake), {
          idRepasse: id as never,
          tentativaConfirmacao: 1,
        });
      }

      const r1 = await lab.livro.findRepasseById(idRepasse1 as never);
      const r2 = await lab.livro.findRepasseById(idRepasse2 as never);
      const pagos = [r1, r2].filter((r) => r?.status === 'pago');
      // CENTERPIECE INVARIANT (drift-stable): at most one repasse ever settles
      // from one PIX. Current impl: R1 matches its own referencia → pago; R2's
      // referencia differs → not pago. Future human-resolved: neither auto-books.
      expect(pagos.length).toBeLessThanOrEqual(1);
      // The WRONG repasse (R2) never settles off R1's payment, either way.
      expect(r2?.status).not.toBe('pago');
      const r2Linked = await lancamentosDoRepasse(lab, idRepasse2);
      expect(r2Linked[0]?.transferidoEm).toBeNull();
    });

    it('a chave-less, referencia-less search row is NOT adopted — the tolerant-predicate wildcard door is shut', async () => {
      // BEFORE s8v26: the match predicate treated a missing chave as a
      // wildcard (p.chave === undefined || …), so a chave-less search row
      // settled a repasse on AMOUNT ALONE — the enabling condition for
      // cross-match even across DIFFERENT chaves. AFTER Rex's fix, referencia
      // is a REQUIRED strong key: a row with no referencia can never match, so
      // amount-alone adoption is impossible. This test locks that closure.
      const lab = buildLab();
      const idCampanha = await seedCampanhaComRecebedorPix(lab, 'outra@example.com');
      const idRepasse = await seedRepasseSolicitado(lab, idCampanha, [4500]);
      await aprovarPix(lab, idRepasse);
      await forcarVerificandoSemCodigo(lab, idRepasse);

      const fake = new RecordingTransferenciaFake({
        buscarResultados: [
          {
            codigoSolicitacao: 'inter_chaveless_row',
            valorCents: 4500 as never,
            // chave AND referencia intentionally absent — a same-amount row
            // that must no longer settle anything.
            status: 'pago',
          } as unknown as PagamentoEncontrado,
        ],
        consultSequence: ['pago'],
      });
      await confirmarTransferenciaRepasse(depsWith(lab, fake), {
        idRepasse: idRepasse as never,
        tentativaConfirmacao: 1,
      });

      const repasse = await lab.livro.findRepasseById(idRepasse as never);
      // NOT pago — no referencia → no match → stays verificando (reschedules).
      expect(repasse?.status).toBe('verificando');
      expect(repasse?.interCodigoSolicitacao).toBeNull();
      // The bogus row's codigo was never adopted, so consult was never called.
      expect(fake.consultarPagamentoCalls).toBe(0);
    });
  });
});
