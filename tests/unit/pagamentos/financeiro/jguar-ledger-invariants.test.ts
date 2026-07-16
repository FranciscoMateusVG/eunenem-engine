/**
 * aperture-jguar — money/ledger invariants of the repasse transfer FSM.
 *
 * Rex's §10.1 decision (aperture-vvh2j): the ledger is credit-only and the
 * "debit" is the `transferido_em` stamp on the linked
 * `credito_saldo_recebedor` rows, deferred to `pago`. Consequences under
 * test here:
 *
 *   - No in-flight state (aprovado/transferindo/verificando/falhou) ever
 *     stamps `transferidoEm`.
 *   - Only `pago` stamps — exactly once, even across falhou → retry → pago.
 *   - `falhou` books ZERO compensating ledger rows (no estorno).
 *   - `cancelado` is the ONLY claim release: clears id_repasse on exactly
 *     the linked un-transferred lançamentos, returning them to disponivel.
 *   - While id_repasse is set (any in-flight state incl. falhou), the
 *     lançamentos are invisible to the disponivel/solicitar computation —
 *     saldo is never re-exposed mid-transfer.
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
  type ExecutarTransferenciaRepasseDeps,
  executarTransferenciaRepasse,
} from '../../../../src/use-cases/pagamentos/financeiro/executar-transferencia-repasse.js';

const T0 = new Date('2026-07-16T10:00:00.000Z');
const T1 = new Date('2026-07-16T11:00:00.000Z');
const T2 = new Date('2026-07-16T12:00:00.000Z');
const T3 = new Date('2026-07-16T13:00:00.000Z');
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

/** Seed two lançamentos and a repasse claimed over them, approved for pix. */
async function seedRepasseAprovado(
  rig: Rig,
  idCampanha: string = rig.idCampanha,
): Promise<{ idRepasse: string; idsLancamentos: string[] }> {
  const l1 = makeLancamento({ idCampanha, amountCents: 3000 });
  const l2 = makeLancamento({ idCampanha, amountCents: 1500 });
  await rig.livro.saveLancamentos([l1, l2]);

  const idRepasse = randomUUID();
  await rig.livro.solicitarRepasseTransaction({
    idCampanha: idCampanha as never,
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
  return {
    idRepasse,
    idsLancamentos: [String((l1 as { id: string }).id), String((l2 as { id: string }).id)],
  };
}

function makeDeps(rig: Rig, provider: TransferenciaProviderFake): ExecutarTransferenciaRepasseDeps {
  return {
    livroFinanceiroRepository: rig.livro,
    transferenciaProvider: provider,
    repasseJobEnqueuer: rig.enqueuer,
    clock: rig.clock,
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
  };
}

function executar(rig: Rig, provider: TransferenciaProviderFake, idRepasse: string): Promise<void> {
  return executarTransferenciaRepasse(makeDeps(rig, provider), { idRepasse: idRepasse as never });
}

function fake(options: TransferenciaProviderFakeOptions = {}): TransferenciaProviderFake {
  return new TransferenciaProviderFake(options);
}

async function transferidoEmDe(rig: Rig, ids: string[]): Promise<Array<Date | null>> {
  const lancamentos = await rig.livro.findLancamentosByIds(ids as never);
  return lancamentos.map((l) => l.transferidoEm);
}

describe('ledger invariant — transferidoEm stays null through every in-flight state', () => {
  it('aprovado → transferindo → verificando → falhou: all linked lançamentos keep transferidoEm null', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedRepasseAprovado(rig);

    // aprovado (pix approval books nothing).
    expect(await transferidoEmDe(rig, idsLancamentos)).toEqual([null, null]);

    // transferindo (intent committed, PIX in flight).
    const iniciado = await rig.livro.iniciarTransferenciaTransaction({
      idRepasse: idRepasse as never,
      requestSummary: 'invariant-walk',
      agora: T1,
    });
    expect(await transferidoEmDe(rig, idsLancamentos)).toEqual([null, null]);

    // verificando (ambiguous outcome).
    await rig.livro.finalizarTentativaTransferencia({
      idRepasse: idRepasse as never,
      attemptId: iniciado.attemptId,
      resultado: { tipo: 'verificando', codigoSolicitacao: 'inter_x' },
      agora: T1,
    });
    expect(await transferidoEmDe(rig, idsLancamentos)).toEqual([null, null]);

    // falhou (confirmed no money moved).
    await rig.livro.resolverVerificacaoTransferencia({
      idRepasse: idRepasse as never,
      resultado: { tipo: 'falhou', erro: 'CONSULTA_REJEITADO' },
      reconciliacaoResumo: 'consulta:rejeitado',
      agora: T2,
    });
    expect(await transferidoEmDe(rig, idsLancamentos)).toEqual([null, null]);

    const repasse = await rig.livro.findRepasseById(idRepasse as never);
    expect(repasse?.status).toBe('falhou');
  });
});

describe('ledger invariant — only pago stamps, and exactly once', () => {
  it('falhou → retry → pago stamps EXACTLY once, at the pago moment, never re-stamped', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedRepasseAprovado(rig);

    // Attempt 1 fails cleanly → falhou, nothing stamped.
    await executar(rig, fake({ pagarPixOutcome: 'rejeitado' }), idRepasse);
    expect((await rig.livro.findRepasseById(idRepasse as never))?.status).toBe('falhou');
    expect(await transferidoEmDe(rig, idsLancamentos)).toEqual([null, null]);

    // Admin retry at T2 succeeds → pago stamps with the pago-time clock.
    rig.setAgora(T2);
    await executar(rig, fake({ pagarPixOutcome: 'pago' }), idRepasse);
    expect((await rig.livro.findRepasseById(idRepasse as never))?.status).toBe('pago');
    expect(await transferidoEmDe(rig, idsLancamentos)).toEqual([T2, T2]);

    // A later re-delivered job at T3 is a no-op — timestamps stay identical
    // (a re-stamp would have moved them to T3).
    rig.setAgora(T3);
    const redelivered = fake({ pagarPixOutcome: 'pago' });
    await executar(rig, redelivered, idRepasse);
    expect(redelivered.pagarPixCalls).toBe(0);
    expect(await transferidoEmDe(rig, idsLancamentos)).toEqual([T2, T2]);

    // A stale reconciliation resolve is equally a no-op on a pago repasse.
    await rig.livro.resolverVerificacaoTransferencia({
      idRepasse: idRepasse as never,
      resultado: { tipo: 'pago', codigoSolicitacao: 'inter_stale' },
      reconciliacaoResumo: 'stale',
      agora: T3,
    });
    expect(await transferidoEmDe(rig, idsLancamentos)).toEqual([T2, T2]);
  });

  it('falhou books ZERO new ledger rows — no estorno/compensating entry', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedRepasseAprovado(rig);
    const antes = await rig.livro.findLancamentosByIdCampanha(rig.idCampanha as never);
    expect(antes).toHaveLength(2);

    await executar(rig, fake({ pagarPixOutcome: 'rejeitado' }), idRepasse);

    expect((await rig.livro.findRepasseById(idRepasse as never))?.status).toBe('falhou');
    const depois = await rig.livro.findLancamentosByIdCampanha(rig.idCampanha as never);
    // Same rows, same count — the "debit" model needs no compensating entry.
    expect(depois).toHaveLength(2);
    expect(new Set(depois.map((l) => l.id))).toEqual(new Set(antes.map((l) => l.id)));
  });
});

describe('cancelarRepasseTransaction — the only claim-release path', () => {
  it('clears id_repasse on exactly the linked lançamentos, returns them to disponivel, audits', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedRepasseAprovado(rig);
    // Control group: an unrelated campanha with its own claimed repasse.
    const outraCampanha = randomUUID();
    const outro = await seedRepasseAprovado(rig, outraCampanha);

    await executar(rig, fake({ pagarPixOutcome: 'rejeitado' }), idRepasse);
    expect((await rig.livro.findRepasseById(idRepasse as never))?.status).toBe('falhou');

    const { repasse, lancamentosLiberados } = await rig.livro.cancelarRepasseTransaction({
      idRepasse: idRepasse as never,
      canceladoPor: 'admin@eunenem',
      agora: T2,
    });

    expect(repasse.status).toBe('cancelado');
    expect(lancamentosLiberados).toBe(2);

    // Linked lançamentos: claim released, still never transferred.
    const liberados = await rig.livro.findLancamentosByIds(idsLancamentos as never);
    for (const l of liberados) {
      expect(l.idRepasse).toBeNull();
      expect(l.transferidoEm).toBeNull();
    }
    // They return to the disponivel bucket naturally.
    const disponiveis = await rig.livro.findLancamentosDisponiveisByIdCampanha(
      rig.idCampanha as never,
      T2,
    );
    expect(new Set(disponiveis.map((l) => String(l.id)))).toEqual(new Set(idsLancamentos));

    // The OTHER campanha's claim is untouched.
    const outros = await rig.livro.findLancamentosByIds(outro.idsLancamentos as never);
    for (const l of outros) {
      expect(l.idRepasse).toBe(outro.idRepasse);
    }

    // Cancel audit row carries the acting admin.
    const attempts = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);
    const auditoria = attempts.at(-1);
    expect(auditoria?.outcome).toBe('cancelado');
    expect(auditoria?.requestSummary).toContain('admin@eunenem');
  });

  it('an abandoned falhou repasse keeps the claim: not disponivel, not paid', async () => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedRepasseAprovado(rig);
    await executar(rig, fake({ pagarPixOutcome: 'rejeitado' }), idRepasse);

    // No cancel, no retry — the repasse just sits in falhou.
    const lancamentos = await rig.livro.findLancamentosByIds(idsLancamentos as never);
    for (const l of lancamentos) {
      expect(l.idRepasse).toBe(idRepasse); // claim still held
      expect(l.transferidoEm).toBeNull(); // money never marked moved
    }
    const disponiveis = await rig.livro.findLancamentosDisponiveisByIdCampanha(
      rig.idCampanha as never,
      T2,
    );
    expect(disponiveis).toHaveLength(0); // saldo never re-exposed mid-retry-window
  });
});

describe('solicitar eligibility — claimed lançamentos are excluded in every in-flight state', () => {
  it('disponivel is empty through aprovado/transferindo/verificando/falhou; a new solicitar claims nothing', async () => {
    const rig = await buildRig();
    const { idRepasse } = await seedRepasseAprovado(rig);

    const disponiveis = () =>
      rig.livro.findLancamentosDisponiveisByIdCampanha(rig.idCampanha as never, T2);

    // aprovado.
    expect(await disponiveis()).toHaveLength(0);

    // transferindo.
    const iniciado = await rig.livro.iniciarTransferenciaTransaction({
      idRepasse: idRepasse as never,
      requestSummary: 'eligibility-walk',
      agora: T1,
    });
    expect(await disponiveis()).toHaveLength(0);

    // verificando.
    await rig.livro.finalizarTentativaTransferencia({
      idRepasse: idRepasse as never,
      attemptId: iniciado.attemptId,
      resultado: { tipo: 'verificando', codigoSolicitacao: null },
      agora: T1,
    });
    expect(await disponiveis()).toHaveLength(0);

    // falhou.
    await rig.livro.resolverVerificacaoTransferencia({
      idRepasse: idRepasse as never,
      resultado: { tipo: 'falhou', erro: 'NAO_ENCONTRADO_NA_BUSCA' },
      reconciliacaoResumo: 'busca:sem_match',
      agora: T2,
    });
    expect(await disponiveis()).toHaveLength(0);

    // A fresh solicitar while the falhou repasse holds the claim sweeps
    // NOTHING — the funds are not double-claimable.
    const novoId = randomUUID();
    const novo = await rig.livro.solicitarRepasseTransaction({
      idCampanha: rig.idCampanha as never,
      idRepasse: novoId as never,
      solicitadoEm: T2,
      now: T2,
    });
    expect(novo.idsLancamentosClaimados).toHaveLength(0);
    expect(novo.repasse.amountCents).toBe(0);

    // The original claim is untouched by the new solicitar.
    const originais = await rig.livro.findLancamentosByIdRepasse(idRepasse as never);
    expect(originais).toHaveLength(2);
  });
});
