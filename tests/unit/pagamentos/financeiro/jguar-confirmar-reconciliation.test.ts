/**
 * aperture-jguar — `confirmarTransferenciaRepasse` reconciliation suite.
 *
 * Handler-level coverage of stale `repasse.confirmar` jobs after payout
 * confirmation polling was retired. Jobs are drained without provider calls,
 * state mutation, ledger mutation or rescheduling.
 *
 * THE invariant, asserted in every single test: confirmar NEVER calls
 * pagarPix (`fake.pagarPixCalls === 0`). `verificando` is the shut
 * double-pay door and this handler performs no provider observation.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
  proximoDelayConfirmacao,
} from '../../../../src/use-cases/pagamentos/financeiro/confirmar-transferencia-repasse.js';

const T0 = new Date('2026-07-16T10:00:00.000Z');
const T1 = new Date('2026-07-16T11:00:00.000Z');
const T2 = new Date('2026-07-16T12:00:00.000Z');
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

describe('confirmarTransferenciaRepasse — automatic payout polling retired', () => {
  it.each([
    ['known receipt', 'inter_known'],
    ['ambiguous without receipt', null],
  ] as const)('drains a stale job for %s without provider, state, ledger or requeue changes', async (_label, codigo) => {
    const rig = await buildRig();
    const { idRepasse, idsLancamentos } = await seedVerificando(rig, { codigo });
    const provider = fake({
      consultSequence: ['pago'],
      buscarResultados: [
        {
          codigoSolicitacao: 'would-have-been-read',
          valorCents: 3000 as never,
          referencia: 'ignored',
          status: 'PAGO',
        },
      ],
    });
    const buscarSpy = vi.spyOn(provider, 'buscarPagamentos');
    const before = await rig.livro.findRepasseById(idRepasse as never);
    const attemptsBefore = await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never);

    await confirmar(rig, provider, idRepasse, 1, true);

    expect(provider.consultarPagamentoCalls).toBe(0);
    expect(buscarSpy).not.toHaveBeenCalled();
    expect(provider.pagarPixCalls).toBe(0);
    expect(rig.enqueued.confirmar).toEqual([]);
    expect(await rig.livro.findRepasseById(idRepasse as never)).toEqual(before);
    expect(await rig.livro.findTransferAttemptsByRepasseId(idRepasse as never)).toEqual(
      attemptsBefore,
    );
    for (const lancamento of await rig.livro.findLancamentosByIds(idsLancamentos as never)) {
      expect(lancamento.transferidoEm).toBeNull();
    }
  });

  it('drains an unknown repasse without provider calls or requeue', async () => {
    const rig = await buildRig();
    const provider = fake({ consultSequence: ['pago'] });
    const buscarSpy = vi.spyOn(provider, 'buscarPagamentos');

    await confirmar(rig, provider, randomUUID(), 7, true);

    expect(provider.consultarPagamentoCalls).toBe(0);
    expect(buscarSpy).not.toHaveBeenCalled();
    expect(provider.pagarPixCalls).toBe(0);
    expect(rig.enqueued.confirmar).toEqual([]);
  });

  it('publishes no future automatic confirmation delay', () => {
    expect(proximoDelayConfirmacao(1)).toBeNull();
    expect(proximoDelayConfirmacao(12)).toBeNull();
    expect(proximoDelayConfirmacao(999)).toBeNull();
  });
});
