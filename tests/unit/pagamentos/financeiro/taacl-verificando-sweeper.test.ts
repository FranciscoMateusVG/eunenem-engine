/**
 * aperture-taacl — orphaned-verificando sweeper unit suite.
 *
 * The executar handler enqueues confirmar NON-ATOMICALLY after the verificando
 * commit; a crash in that window strands a repasse in verificando with no
 * confirmar job. The sweep re-arms ONLY true orphans: verificando repasses
 * older than the age gate AND with no pending confirmar job. It must NOT
 * disturb a healthy repasse mid-escalation (job scheduled in the future) nor a
 * just-committed verificando (younger than the age gate).
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RecebedorRepositoryMemory } from '../../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import type { RepasseConfirmarJobData } from '../../../../src/adapters/pagamentos/transferencia-enqueuer.js';
import { criarRecebedorInicial } from '../../../../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../../src/observability/tracer.js';
import { gerarTransferReferencia } from '../../../../src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
import {
  SWEEP_MIN_IDADE_MINUTOS_DEFAULT,
  varrerRepassesVerificandoOrfaos,
} from '../../../../src/use-cases/pagamentos/financeiro/varrer-repasses-verificando-orfaos.js';

const T_ENTROU = new Date('2026-07-16T10:00:00.000Z'); // verificando commit moment
const CHAVE_PIX = 'bia@example.com';

interface Rig {
  livro: LivroFinanceiroRepositoryMemory;
  idCampanha: string;
  enqueued: RepasseConfirmarJobData[];
  pending: Set<string>; // idRepasse -> has a live confirmar job
  enqueuer: {
    enqueueExecutar: () => Promise<void>;
    enqueueConfirmar: (d: RepasseConfirmarJobData, delay: number) => Promise<void>;
    hasPendingConfirmar: (id: string) => Promise<boolean>;
  };
  lastDelay: number | null;
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
      criadaEm: T_ENTROU,
    }),
  );
  const rig: Rig = {
    livro,
    idCampanha,
    enqueued: [],
    pending: new Set<string>(),
    lastDelay: null,
    enqueuer: {
      async enqueueExecutar() {},
      async enqueueConfirmar(d, delay) {
        rig.enqueued.push(d);
        rig.lastDelay = delay;
      },
      async hasPendingConfirmar(id) {
        return rig.pending.has(id);
      },
    },
  };
  return rig;
}

function makeLancamento(idCampanha: string, amountCents: number) {
  return {
    id: randomUUID(),
    idPagamento: randomUUID(),
    idContribuicao: randomUUID(),
    idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents,
    criadoEm: T_ENTROU,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
  } as never;
}

/** Seed a repasse into verificando, its verificando-transition committed at `entrouEm`. */
async function seedVerificando(rig: Rig, entrouEm: Date): Promise<string> {
  await rig.livro.saveLancamentos([makeLancamento(rig.idCampanha, 4500)]);
  const idRepasse = randomUUID();
  await rig.livro.solicitarRepasseTransaction({
    idCampanha: rig.idCampanha as never,
    idRepasse: idRepasse as never,
    solicitadoEm: T_ENTROU,
    now: T_ENTROU,
  });
  await rig.livro.aprovarRepassePixTransaction(
    {
      idRepasse: idRepasse as never,
      aprovadoEm: entrouEm,
      transferReferencia: gerarTransferReferencia(idRepasse as never),
    },
    async () => {},
  );
  const ini = await rig.livro.iniciarTransferenciaTransaction({
    idRepasse: idRepasse as never,
    requestSummary: 'seed',
    agora: entrouEm,
  });
  await rig.livro.finalizarTentativaTransferencia({
    idRepasse: idRepasse as never,
    attemptId: ini.attemptId,
    resultado: { tipo: 'verificando', codigoSolicitacao: null },
    agora: entrouEm, // the verificando attempt's finished_at
  });
  return idRepasse;
}

function sweep(rig: Rig, agora: Date, minIdadeMinutos?: number) {
  return varrerRepassesVerificandoOrfaos(
    {
      livroFinanceiroRepository: rig.livro,
      repasseJobEnqueuer: rig.enqueuer as never,
      clock: () => agora,
      observability: { logger: new NoopLogger(), tracer: noopTracer() },
    },
    minIdadeMinutos !== undefined ? { minIdadeMinutos } : {},
  );
}

// 20 min after the verificando commit — well past the default 10-min gate.
const T_AGORA = new Date(T_ENTROU.getTime() + 20 * 60_000);

describe('varrerRepassesVerificandoOrfaos', () => {
  it('re-arms a stale verificando with NO pending confirmar job (tentativa 1, delay 0)', async () => {
    const rig = await buildRig();
    const idRepasse = await seedVerificando(rig, T_ENTROU);
    // no pending job → orphaned

    const out = await sweep(rig, T_AGORA);

    expect(out.examinados).toBe(1);
    expect(out.reenfileirados).toBe(1);
    expect(rig.enqueued).toEqual([{ idRepasse, tentativaConfirmacao: 1 }]);
    expect(rig.lastDelay).toBe(0);
    // The repasse itself is untouched (still verificando) — confirmar resolves it.
    expect((await rig.livro.findRepasseById(idRepasse as never))?.status).toBe('verificando');
  });

  it('does NOT re-arm a healthy verificando that still has a pending confirmar job', async () => {
    const rig = await buildRig();
    const idRepasse = await seedVerificando(rig, T_ENTROU);
    rig.pending.add(idRepasse); // healthy: a confirmar poll is scheduled

    const out = await sweep(rig, T_AGORA);

    expect(out.examinados).toBe(1); // examined (stale enough)…
    expect(out.reenfileirados).toBe(0); // …but not re-armed
    expect(rig.enqueued).toHaveLength(0);
  });

  it('does NOT examine a verificando younger than the age gate', async () => {
    const rig = await buildRig();
    // entered verificando only 2 minutes ago — inside the 10-min gate.
    await seedVerificando(rig, new Date(T_AGORA.getTime() - 2 * 60_000));

    const out = await sweep(rig, T_AGORA);

    expect(out.examinados).toBe(0);
    expect(out.reenfileirados).toBe(0);
    expect(rig.enqueued).toHaveLength(0);
  });

  it('ignores non-verificando repasses (a solicitado repasse is never swept)', async () => {
    const rig = await buildRig();
    await rig.livro.saveLancamentos([makeLancamento(rig.idCampanha, 4500)]);
    const idRepasse = randomUUID();
    await rig.livro.solicitarRepasseTransaction({
      idCampanha: rig.idCampanha as never,
      idRepasse: idRepasse as never,
      solicitadoEm: T_ENTROU,
      now: T_ENTROU,
    });

    const out = await sweep(rig, T_AGORA);

    expect(out.examinados).toBe(0);
    expect(rig.enqueued).toHaveLength(0);
  });

  it('re-arms multiple orphans and skips the one with a pending job in the same sweep', async () => {
    const rig = await buildRig();
    const orphanA = await seedVerificando(rig, T_ENTROU);
    const healthy = await seedVerificando(rig, T_ENTROU);
    const orphanB = await seedVerificando(rig, T_ENTROU);
    rig.pending.add(healthy);

    const out = await sweep(rig, T_AGORA);

    expect(out.examinados).toBe(3);
    expect(out.reenfileirados).toBe(2);
    const ids = rig.enqueued.map((e) => e.idRepasse).sort();
    expect(ids).toEqual([orphanA, orphanB].sort());
    expect(ids).not.toContain(healthy);
  });

  it('honours an overridden minIdadeMinutos', async () => {
    const rig = await buildRig();
    // entered 8 min ago: inside the default 10 gate, but outside a 5-min gate.
    await seedVerificando(rig, new Date(T_AGORA.getTime() - 8 * 60_000));

    expect((await sweep(rig, T_AGORA)).examinados).toBe(0); // default 10 → not yet
    expect((await sweep(rig, T_AGORA, 5)).examinados).toBe(1); // override 5 → swept
  });

  it('exposes the default age gate as 10 minutes', () => {
    expect(SWEEP_MIN_IDADE_MINUTOS_DEFAULT).toBe(10);
  });
});
