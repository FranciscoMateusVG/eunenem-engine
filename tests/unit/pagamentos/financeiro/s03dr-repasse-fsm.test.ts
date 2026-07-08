/**
 * Tests for aperture-s03dr — RepasseRecebedor FSM extension
 * (solicitado → aprovado), id_repasse linkage on lançamentos, and
 * concurrency guard (at-most-one pending per campanha).
 *
 * Covers:
 *   (A) Domain entity: aprovarRepasse transition (forward-only).
 *   (B) Memory adapter ports:
 *       - findLancamentosDisponiveisByIdCampanha (eligible predicate)
 *       - solicitarRepasseTransaction (atomic INSERT + linkage UPDATE)
 *       - aprovarRepasseTransaction (FSM + bulk transferidoEm)
 *   (C) Use-cases:
 *       - solicitarRepasseRecebedor (sweep semantics)
 *       - aprovarRepasseRecebedor (idempotency + status gate)
 *   (D) Concurrency: unique-pending-per-campanha invariant.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import type { LancamentoFinanceiro } from '../../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import {
  aprovarRepasse,
  criarRepasseRecebedorSolicitado,
} from '../../../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { FinanceiroRepasseJaPendenteError } from '../../../../src/errors/pagamentos/financeiro/repasse-ja-pendente.error.js';
import { FinanceiroRepasseNaoEncontradoError } from '../../../../src/errors/pagamentos/financeiro/repasse-nao-encontrado.error.js';
import { FinanceiroRepasseStatusInvalidoError } from '../../../../src/errors/pagamentos/financeiro/repasse-status-invalido.error.js';
import { FinanceiroSaldoDisponivelInsuficienteError } from '../../../../src/errors/pagamentos/financeiro/saldo-disponivel-insuficiente.error.js';
import { NoopLogger } from '../../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../../src/observability/tracer.js';
import { aprovarRepasseRecebedor } from '../../../../src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
import { solicitarRepasseRecebedor } from '../../../../src/use-cases/pagamentos/financeiro/solicitar-repasse-recebedor.js';

const observability = { logger: new NoopLogger(), tracer: noopTracer() };
const T0 = new Date('2026-06-04T10:00:00.000Z');
const T1 = new Date('2026-06-04T11:00:00.000Z');
const clockAt = (d: Date) => () => d;

function seedLancamento(
  overrides: Partial<LancamentoFinanceiro> & { idCampanha: string },
): LancamentoFinanceiro {
  return {
    id: randomUUID(),
    idPagamento: randomUUID(),
    idContribuicao: randomUUID(),
    idCampanha: overrides.idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: 1000,
    criadoEm: T0,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
//  (A) Domain entity — aprovarRepasse forward-only transition
// ────────────────────────────────────────────────────────────────────

describe('aprovarRepasse (domain entity, aperture-s03dr)', () => {
  it('transitions solicitado → aprovado with timestamp + bankTransferRef', () => {
    const repasse = criarRepasseRecebedorSolicitado(
      {
        idRepasse: randomUUID(),
        idCampanha: randomUUID(),
        amountCents: 5000,
      },
      T0,
    );

    const aprovado = aprovarRepasse(repasse, 'E2E-PIX-12345', T1);

    expect(aprovado.status).toBe('aprovado');
    expect(aprovado.aprovadoEm).toEqual(T1);
    expect(aprovado.bankTransferRef).toBe('E2E-PIX-12345');
    expect(aprovado.solicitadoEm).toEqual(T0); // unchanged
    expect(aprovado.id).toBe(repasse.id);
  });

  it('accepts null bankTransferRef (admin not supplying audit ref)', () => {
    const repasse = criarRepasseRecebedorSolicitado(
      { idRepasse: randomUUID(), idCampanha: randomUUID(), amountCents: 1000 },
      T0,
    );
    const aprovado = aprovarRepasse(repasse, null, T1);
    expect(aprovado.bankTransferRef).toBeNull();
    expect(aprovado.status).toBe('aprovado');
  });

  it('refuses to transition an already-aprovado repasse', () => {
    const repasse = criarRepasseRecebedorSolicitado(
      { idRepasse: randomUUID(), idCampanha: randomUUID(), amountCents: 1000 },
      T0,
    );
    const aprovado = aprovarRepasse(repasse, null, T1);
    expect(() => aprovarRepasse(aprovado, 'X', T1)).toThrow(/cannot transition/i);
  });
});

// ────────────────────────────────────────────────────────────────────
//  (B) Memory adapter — port methods
// ────────────────────────────────────────────────────────────────────

describe('LivroFinanceiroRepositoryMemory — findLancamentosDisponiveisByIdCampanha', () => {
  it('returns only un-transferred, un-cancelled, un-claimed recebedor lançamentos', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    const idCampanhaOutra = randomUUID();

    const eligible = seedLancamento({ idCampanha, amountCents: 5000 });
    const transferred = seedLancamento({
      idCampanha,
      amountCents: 9999,
      transferidoEm: T0,
    });
    const cancelled = seedLancamento({
      idCampanha,
      amountCents: 9999,
      canceladoEm: T0,
    });
    const claimedByRepasse = seedLancamento({
      idCampanha,
      amountCents: 9999,
      idRepasse: randomUUID(),
    });
    const platformaReceita = seedLancamento({
      idCampanha,
      amountCents: 9999,
      tipo: 'credito_receita_plataforma',
    });
    const outraCampanha = seedLancamento({ idCampanha: idCampanhaOutra, amountCents: 9999 });

    await livro.saveLancamentos([
      eligible,
      transferred,
      cancelled,
      claimedByRepasse,
      platformaReceita,
      outraCampanha,
    ]);

    const result = await livro.findLancamentosDisponiveisByIdCampanha(idCampanha, T1);
    expect(result.map((l) => l.id)).toEqual([eligible.id]);
  });
});

describe('LivroFinanceiroRepositoryMemory — solicitarRepasseTransaction', () => {
  it('snapshots SUM(amountCents) and stamps id_repasse on the claimed set', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    const l1 = seedLancamento({ idCampanha, amountCents: 3000 });
    const l2 = seedLancamento({ idCampanha, amountCents: 2500 });
    await livro.saveLancamentos([l1, l2]);

    const idRepasse = randomUUID();
    const result = await livro.solicitarRepasseTransaction({
      idCampanha,
      idRepasse,
      solicitadoEm: T0,
      now: T0,
    });

    expect(result.repasse.amountCents).toBe(5500);
    expect(result.repasse.status).toBe('solicitado');
    expect(result.idsLancamentosClaimados.sort()).toEqual([l1.id, l2.id].sort());

    // Re-fetch lançamentos: idRepasse stamped.
    const refetched1 = await livro.findLancamentosByIds([l1.id]);
    expect(refetched1[0]?.idRepasse).toBe(idRepasse);
  });

  it('throws FinanceiroRepasseJaPendenteError when a pending repasse already exists', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    const l = seedLancamento({ idCampanha, amountCents: 1000 });
    await livro.saveLancamentos([l]);

    await livro.solicitarRepasseTransaction({
      idCampanha,
      idRepasse: randomUUID(),
      solicitadoEm: T0,
      now: T0,
    });

    // A NEW lancamento becomes eligible (the first one was already claimed)
    // — but a pending repasse exists, so the second solicitação refuses.
    const l2 = seedLancamento({ idCampanha, amountCents: 2000 });
    await livro.saveLancamentos([l2]);

    await expect(
      livro.solicitarRepasseTransaction({
        idCampanha,
        idRepasse: randomUUID(),
        solicitadoEm: T1,
        now: T1,
      }),
    ).rejects.toBeInstanceOf(FinanceiroRepasseJaPendenteError);
  });

  it('allows a SECOND solicitação after the first is aprovado', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    const l1 = seedLancamento({ idCampanha, amountCents: 1000 });
    await livro.saveLancamentos([l1]);

    const firstId = randomUUID();
    await livro.solicitarRepasseTransaction({
      idCampanha,
      idRepasse: firstId,
      solicitadoEm: T0,
      now: T0,
    });
    await livro.aprovarRepasseTransaction({
      idRepasse: firstId,
      aprovadoEm: T0,
      bankTransferRef: 'E2E-1',
    });

    // After approval, the campanha unblocks. A fresh eligible lançamento
    // can be claimed by a NEW repasse.
    const l2 = seedLancamento({ idCampanha, amountCents: 2000 });
    await livro.saveLancamentos([l2]);

    const secondId = randomUUID();
    const result = await livro.solicitarRepasseTransaction({
      idCampanha,
      idRepasse: secondId,
      solicitadoEm: T1,
      now: T1,
    });

    expect(result.repasse.amountCents).toBe(2000);
    expect(result.idsLancamentosClaimados).toEqual([l2.id]);
  });
});

describe('LivroFinanceiroRepositoryMemory — aprovarRepasseTransaction', () => {
  it('transitions repasse to aprovado AND bulk-stamps transferidoEm on linked lançamentos', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    const l1 = seedLancamento({ idCampanha, amountCents: 1500 });
    const l2 = seedLancamento({ idCampanha, amountCents: 2500 });
    await livro.saveLancamentos([l1, l2]);

    const idRepasse = randomUUID();
    await livro.solicitarRepasseTransaction({
      idCampanha,
      idRepasse,
      solicitadoEm: T0,
      now: T0,
    });

    const result = await livro.aprovarRepasseTransaction({
      idRepasse,
      aprovadoEm: T1,
      bankTransferRef: 'TED-998877',
    });

    expect(result.repasse.status).toBe('aprovado');
    expect(result.repasse.aprovadoEm).toEqual(T1);
    expect(result.repasse.bankTransferRef).toBe('TED-998877');
    expect(result.lancamentosAfetados).toBe(2);

    // Linked lançamentos now carry transferidoEm = aprovadoEm.
    const refetched = await livro.findLancamentosByIds([l1.id, l2.id]);
    for (const l of refetched) {
      expect(l.transferidoEm).toEqual(T1);
      expect(l.idRepasse).toBe(idRepasse);
    }
  });

  it('is idempotent at the same terminal state (same bankTransferRef)', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    await livro.saveLancamentos([seedLancamento({ idCampanha, amountCents: 1000 })]);

    const idRepasse = randomUUID();
    await livro.solicitarRepasseTransaction({
      idCampanha,
      idRepasse,
      solicitadoEm: T0,
      now: T0,
    });
    const first = await livro.aprovarRepasseTransaction({
      idRepasse,
      aprovadoEm: T1,
      bankTransferRef: 'PIX-1',
    });
    const second = await livro.aprovarRepasseTransaction({
      idRepasse,
      aprovadoEm: T1, // ignored when already aprovado
      bankTransferRef: 'PIX-1',
    });

    expect(first.repasse).toEqual(second.repasse);
    expect(second.lancamentosAfetados).toBe(0);
  });

  it('throws FinanceiroRepasseStatusInvalidoError on mismatched audit ref', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    await livro.saveLancamentos([seedLancamento({ idCampanha, amountCents: 1000 })]);

    const idRepasse = randomUUID();
    await livro.solicitarRepasseTransaction({
      idCampanha,
      idRepasse,
      solicitadoEm: T0,
      now: T0,
    });
    await livro.aprovarRepasseTransaction({
      idRepasse,
      aprovadoEm: T1,
      bankTransferRef: 'PIX-1',
    });

    await expect(
      livro.aprovarRepasseTransaction({
        idRepasse,
        aprovadoEm: T1,
        bankTransferRef: 'PIX-DIFFERENT',
      }),
    ).rejects.toBeInstanceOf(FinanceiroRepasseStatusInvalidoError);
  });

  it('throws FinanceiroRepasseNaoEncontradoError when the repasse does not exist', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    await expect(
      livro.aprovarRepasseTransaction({
        idRepasse: randomUUID(),
        aprovadoEm: T1,
        bankTransferRef: null,
      }),
    ).rejects.toBeInstanceOf(FinanceiroRepasseNaoEncontradoError);
  });
});

// ────────────────────────────────────────────────────────────────────
//  (C) Use-cases
// ────────────────────────────────────────────────────────────────────

describe('solicitarRepasseRecebedor — sweep semantics (aperture-s03dr)', () => {
  it('sweeps every eligible lançamento and returns the snapshotted repasse', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    await livro.saveLancamentos([
      seedLancamento({ idCampanha, amountCents: 1000 }),
      seedLancamento({ idCampanha, amountCents: 2000 }),
      seedLancamento({ idCampanha, amountCents: 3000 }),
    ]);

    const idRepasse = randomUUID();
    const repasse = await solicitarRepasseRecebedor(
      { livroFinanceiroRepository: livro, clock: clockAt(T0), observability },
      { idRepasse, idCampanha },
    );

    expect(repasse.amountCents).toBe(6000);
    expect(repasse.status).toBe('solicitado');
    expect(repasse.aprovadoEm).toBeNull();
    expect(repasse.bankTransferRef).toBeNull();
  });

  it('throws FinanceiroSaldoDisponivelInsuficienteError when no eligible lançamentos exist', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    // Seed only ALREADY-TRANSFERRED lançamentos — empty eligible set.
    await livro.saveLancamentos([
      seedLancamento({ idCampanha, amountCents: 5000, transferidoEm: T0 }),
    ]);

    await expect(
      solicitarRepasseRecebedor(
        { livroFinanceiroRepository: livro, clock: clockAt(T0), observability },
        { idRepasse: randomUUID(), idCampanha },
      ),
    ).rejects.toBeInstanceOf(FinanceiroSaldoDisponivelInsuficienteError);
  });

  it('refuses a second solicitação while the first is pending (concurrency guard)', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    await livro.saveLancamentos([
      seedLancamento({ idCampanha, amountCents: 1000 }),
      seedLancamento({ idCampanha, amountCents: 2000 }),
    ]);

    await solicitarRepasseRecebedor(
      { livroFinanceiroRepository: livro, clock: clockAt(T0), observability },
      { idRepasse: randomUUID(), idCampanha },
    );

    // First sweep claimed everything; the eligible set is now empty —
    // so the second call hits the SaldoDisponivelInsuficiente preflight
    // BEFORE reaching the unique-pending guard. To exercise the
    // unique-pending guard at the use-case layer, we need a fresh
    // eligible lançamento.
    await livro.saveLancamentos([seedLancamento({ idCampanha, amountCents: 1500 })]);

    await expect(
      solicitarRepasseRecebedor(
        { livroFinanceiroRepository: livro, clock: clockAt(T1), observability },
        { idRepasse: randomUUID(), idCampanha },
      ),
    ).rejects.toBeInstanceOf(FinanceiroRepasseJaPendenteError);
  });
});

describe('aprovarRepasseRecebedor — admin path', () => {
  async function setupPending() {
    const livro = new LivroFinanceiroRepositoryMemory();
    const idCampanha = randomUUID();
    await livro.saveLancamentos([
      seedLancamento({ idCampanha, amountCents: 4500 }),
      seedLancamento({ idCampanha, amountCents: 1500 }),
    ]);
    const idRepasse = randomUUID();
    await solicitarRepasseRecebedor(
      { livroFinanceiroRepository: livro, clock: clockAt(T0), observability },
      { idRepasse, idCampanha },
    );
    return { livro, idRepasse };
  }

  it('approves a pending repasse + stamps transferidoEm on linked lançamentos', async () => {
    const { livro, idRepasse } = await setupPending();

    const result = await aprovarRepasseRecebedor(
      { livroFinanceiroRepository: livro, clock: clockAt(T1), observability },
      { idRepasse, bankTransferRef: 'E2E-AB12CD' },
    );

    expect(result.repasse.status).toBe('aprovado');
    expect(result.repasse.aprovadoEm).toEqual(T1);
    expect(result.repasse.bankTransferRef).toBe('E2E-AB12CD');
    expect(result.lancamentosAfetados).toBe(2);
  });

  it('accepts a null bankTransferRef (default when admin omits)', async () => {
    const { livro, idRepasse } = await setupPending();
    const result = await aprovarRepasseRecebedor(
      { livroFinanceiroRepository: livro, clock: clockAt(T1), observability },
      { idRepasse, bankTransferRef: null },
    );
    expect(result.repasse.bankTransferRef).toBeNull();
    expect(result.repasse.status).toBe('aprovado');
  });

  it('is idempotent on re-approval with the same bankTransferRef', async () => {
    const { livro, idRepasse } = await setupPending();
    const first = await aprovarRepasseRecebedor(
      { livroFinanceiroRepository: livro, clock: clockAt(T1), observability },
      { idRepasse, bankTransferRef: 'PIX-XYZ' },
    );
    const second = await aprovarRepasseRecebedor(
      { livroFinanceiroRepository: livro, clock: clockAt(T1), observability },
      { idRepasse, bankTransferRef: 'PIX-XYZ' },
    );
    expect(second.repasse).toEqual(first.repasse);
    expect(second.lancamentosAfetados).toBe(0);
  });

  it('rejects re-approval with a mismatched bankTransferRef (no silent overwrite)', async () => {
    const { livro, idRepasse } = await setupPending();
    await aprovarRepasseRecebedor(
      { livroFinanceiroRepository: livro, clock: clockAt(T1), observability },
      { idRepasse, bankTransferRef: 'PIX-FIRST' },
    );
    await expect(
      aprovarRepasseRecebedor(
        { livroFinanceiroRepository: livro, clock: clockAt(T1), observability },
        { idRepasse, bankTransferRef: 'PIX-SECOND' },
      ),
    ).rejects.toBeInstanceOf(FinanceiroRepasseStatusInvalidoError);
  });

  it('throws FinanceiroRepasseNaoEncontradoError for an unknown idRepasse', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    await expect(
      aprovarRepasseRecebedor(
        { livroFinanceiroRepository: livro, clock: clockAt(T1), observability },
        { idRepasse: randomUUID(), bankTransferRef: null },
      ),
    ).rejects.toBeInstanceOf(FinanceiroRepasseNaoEncontradoError);
  });
});
