/**
 * aperture-vvh2j — automated PIX transfer FSM guard tests.
 *
 * Pure domain-level coverage of the new transition guards. This proves the
 * transition MATRIX (legal transitions succeed, illegal ones throw) that
 * carries the "at most one successful PIX per repasse" invariant. The
 * adapter-level (transferido_em-only-at-pago, cancel-clears-id_repasse),
 * handler-level (outcome matrix, reconciliar/transient paths), and
 * adversarial double-pay coverage live in aperture-jguar (Izzy).
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aprovarRepassePix,
  cancelarRepasse,
  criarRepasseRecebedorSolicitado,
  iniciarTransferencia,
  marcarRepasseFalhou,
  marcarRepassePago,
  marcarRepasseVerificando,
  type RepasseRecebedor,
  reverterTransferenciaParaAprovado,
  type StatusRepasse,
} from '../../../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';

const T0 = new Date('2026-07-16T10:00:00.000Z');
const T1 = new Date('2026-07-16T11:00:00.000Z');
const REF = 'ENabcdef0123456789';

function solicitado(): RepasseRecebedor {
  return criarRepasseRecebedorSolicitado(
    { idRepasse: randomUUID(), idCampanha: randomUUID(), amountCents: 5000 },
    T0,
  );
}

/** Advance a repasse to a target status via the legal path, for guard tests. */
function emStatus(alvo: StatusRepasse): RepasseRecebedor {
  const s = solicitado();
  if (alvo === 'solicitado') return s;
  const aprovado = aprovarRepassePix(s, REF, T1);
  if (alvo === 'aprovado') return aprovado;
  const transferindo = iniciarTransferencia(aprovado);
  if (alvo === 'transferindo') return transferindo;
  if (alvo === 'pago') return marcarRepassePago(transferindo, 'inter_1');
  if (alvo === 'verificando') return marcarRepasseVerificando(transferindo, 'inter_1');
  const falhou = marcarRepasseFalhou(transferindo, 'ERRO');
  if (alvo === 'falhou') return falhou;
  return cancelarRepasse(falhou); // cancelado
}

describe('aprovarRepassePix', () => {
  it('solicitado → aprovado, binds the stable referencia, no transferido stamp concept here', () => {
    const r = aprovarRepassePix(solicitado(), REF, T1);
    expect(r.status).toBe('aprovado');
    expect(r.transferReferencia).toBe(REF);
    expect(r.aprovadoEm).toEqual(T1);
    expect(r.transferAttempts).toBe(0);
  });

  it('rejects a non-solicitado source', () => {
    expect(() => aprovarRepassePix(emStatus('aprovado'), REF, T1)).toThrow();
  });
});

describe('iniciarTransferencia', () => {
  it('aprovado → transferindo, increments attempts, reuses referencia', () => {
    const r = iniciarTransferencia(emStatus('aprovado'));
    expect(r.status).toBe('transferindo');
    expect(r.transferAttempts).toBe(1);
    expect(r.transferReferencia).toBe(REF);
  });

  it('falhou → transferindo (admin retry), increments attempts again', () => {
    const r = iniciarTransferencia(emStatus('falhou'));
    expect(r.status).toBe('transferindo');
    expect(r.transferAttempts).toBe(2); // aprovado→transferindo(1)→falhou→retry(2)
  });

  it('rejects a cancelado repasse (never retryable)', () => {
    expect(() => iniciarTransferencia(emStatus('cancelado'))).toThrow();
  });

  it('rejects a pago repasse', () => {
    expect(() => iniciarTransferencia(emStatus('pago'))).toThrow();
  });

  it('rejects entering transferindo without a referencia', () => {
    const semRef = { ...emStatus('aprovado'), transferReferencia: null };
    expect(() => iniciarTransferencia(semRef)).toThrow();
  });
});

describe('marcarRepassePago', () => {
  it('transferindo → pago, records codigoSolicitacao', () => {
    const r = marcarRepassePago(emStatus('transferindo'), 'inter_99');
    expect(r.status).toBe('pago');
    expect(r.interCodigoSolicitacao).toBe('inter_99');
  });

  it('verificando → pago (reconciliation resolves)', () => {
    const r = marcarRepassePago(emStatus('verificando'), 'inter_99');
    expect(r.status).toBe('pago');
  });

  it('rejects pago from aprovado (must go through transferindo)', () => {
    expect(() => marcarRepassePago(emStatus('aprovado'), 'x')).toThrow();
  });
});

describe('marcarRepasseVerificando', () => {
  it('transferindo → verificando, keeps prior codigo when passed null', () => {
    const base = { ...emStatus('transferindo'), interCodigoSolicitacao: 'inter_prev' };
    const r = marcarRepasseVerificando(base, null);
    expect(r.status).toBe('verificando');
    expect(r.interCodigoSolicitacao).toBe('inter_prev');
  });

  it('rejects verificando from a non-transferindo source', () => {
    expect(() => marcarRepasseVerificando(emStatus('aprovado'), null)).toThrow();
  });
});

describe('marcarRepasseFalhou', () => {
  it('transferindo → falhou with error code', () => {
    const r = marcarRepasseFalhou(emStatus('transferindo'), 'INVALID_KEY');
    expect(r.status).toBe('falhou');
    expect(r.lastTransferError).toBe('INVALID_KEY');
  });

  it('verificando → falhou', () => {
    const r = marcarRepasseFalhou(emStatus('verificando'), 'CANCELADO');
    expect(r.status).toBe('falhou');
  });
});

describe('reverterTransferenciaParaAprovado (transient reset)', () => {
  it('transferindo → aprovado, keeps referencia and attempts', () => {
    const t = emStatus('transferindo');
    const r = reverterTransferenciaParaAprovado(t);
    expect(r.status).toBe('aprovado');
    expect(r.transferReferencia).toBe(REF);
    expect(r.transferAttempts).toBe(t.transferAttempts);
  });

  it('rejects revert from a non-transferindo source', () => {
    expect(() => reverterTransferenciaParaAprovado(emStatus('falhou'))).toThrow();
  });
});

describe('cancelarRepasse (only claim-release path)', () => {
  it('falhou → cancelado', () => {
    const r = cancelarRepasse(emStatus('falhou'));
    expect(r.status).toBe('cancelado');
  });

  it('rejects cancel from aprovado/transferindo/verificando/pago', () => {
    for (const s of ['aprovado', 'transferindo', 'verificando', 'pago'] as const) {
      expect(() => cancelarRepasse(emStatus(s))).toThrow();
    }
  });

  it('a cancelled repasse can never be retried', () => {
    expect(() => iniciarTransferencia(emStatus('cancelado'))).toThrow();
  });
});
