/**
 * aperture-4ifbm — E2E magic-chave outcome selection on TransferenciaProviderFake.
 *
 * Gives browser E2E per-repasse control of pagarPix outcomes (and the consult
 * follow-up + search reconciliation) against a SINGLE booted server, selected
 * by the recebedor's chave PIX. Double-gated: fake-only + the e2eMagicOutcomes
 * flag (EUNENEM_FAKE_E2E_MAGIC). When off — or when the chave carries no marker
 * — behaviour is IDENTICAL to the constructor-driven fake.
 */

import { describe, expect, it } from 'vitest';
import {
  parseE2eMagicChave,
  TransferenciaProviderFake,
} from '../../../src/adapters/pagamentos/transferencia-provider.fake.js';
import { TransferenciaTransitoriaError } from '../../../src/adapters/pagamentos/transferencia-provider.js';

function pagarInput(chave: string, valorCents = 4500) {
  return {
    chave,
    valorCents: valorCents as never,
    descricao: 'EuNeném — repasse e2e',
    referencia: 'ENe2eref',
  };
}

describe('parseE2eMagicChave (pure)', () => {
  it('parses outcome only, defaulting consult=pago and searchHit=false', () => {
    expect(parseE2eMagicChave('e2e-outcome-pago@fake.test')).toEqual({
      outcome: 'pago',
      consultToken: 'pago',
      searchHit: false,
    });
  });

  it('maps the agendado token to agendado_aprovacao and parses -consult-<status>', () => {
    expect(parseE2eMagicChave('e2e-outcome-agendado-consult-rejeitado@fake.test')).toEqual({
      outcome: 'agendado_aprovacao',
      consultToken: 'rejeitado',
      searchHit: false,
    });
  });

  it('parses -search-hit', () => {
    expect(parseE2eMagicChave('e2e-outcome-ambiguo-search-hit@fake.test')).toEqual({
      outcome: 'ambiguo',
      consultToken: 'pago',
      searchHit: true,
    });
  });

  it('returns null for a non-marker chave or an unknown outcome token', () => {
    expect(parseE2eMagicChave('bia@example.com')).toBeNull();
    expect(parseE2eMagicChave('e2e-outcome-bogus@fake.test')).toBeNull();
    expect(parseE2eMagicChave(undefined)).toBeNull();
  });

  it('falls back to consult=pago when the consult token is unknown', () => {
    expect(parseE2eMagicChave('e2e-outcome-agendado-consult-bogus@fake.test')?.consultToken).toBe(
      'pago',
    );
  });
});

describe('TransferenciaProviderFake — magic DISABLED (default)', () => {
  it('ignores the magic chave entirely — uses the constructor outcome', async () => {
    const fake = new TransferenciaProviderFake({ pagarPixOutcome: 'pago' });
    // A magic-marker chave, but the flag is off → constructor 'pago' wins.
    const out = await fake.pagarPix(pagarInput('e2e-outcome-rejeitado@fake.test'));
    expect(out.outcome).toBe('pago');
  });
});

describe('TransferenciaProviderFake — magic ENABLED: pagarPix outcomes', () => {
  const magic = () => new TransferenciaProviderFake({ e2eMagicOutcomes: true });

  it('pago', async () => {
    const out = await magic().pagarPix(pagarInput('e2e-outcome-pago@fake.test'));
    expect(out.outcome).toBe('pago');
    expect(out.outcome === 'pago' && out.codigoSolicitacao).toBeTruthy();
  });

  it('agendado → agendado_aprovacao (NOT success — diverts to verificando)', async () => {
    const out = await magic().pagarPix(pagarInput('e2e-outcome-agendado@fake.test'));
    expect(out.outcome).toBe('agendado_aprovacao');
  });

  it('rejeitado (clean rejection)', async () => {
    const out = await magic().pagarPix(pagarInput('e2e-outcome-rejeitado@fake.test'));
    expect(out.outcome).toBe('rejeitado');
  });

  it('transitorio → throws TransferenciaTransitoriaError (safe-to-retry)', async () => {
    await expect(
      magic().pagarPix(pagarInput('e2e-outcome-transitorio@fake.test')),
    ).rejects.toBeInstanceOf(TransferenciaTransitoriaError);
  });

  it('ambiguo → throws a plain Error (payment MAY exist → verificando)', async () => {
    await expect(
      magic().pagarPix(pagarInput('e2e-outcome-ambiguo@fake.test')),
    ).rejects.not.toBeInstanceOf(TransferenciaTransitoriaError);
    await expect(magic().pagarPix(pagarInput('e2e-outcome-ambiguo@fake.test'))).rejects.toThrow();
  });

  it('timeout → throws a plain Error (ambiguous)', async () => {
    await expect(magic().pagarPix(pagarInput('e2e-outcome-timeout@fake.test'))).rejects.toThrow();
  });

  it('a non-marker chave falls back to the constructor default (pago)', async () => {
    const out = await magic().pagarPix(pagarInput('bia@example.com'));
    expect(out.outcome).toBe('pago');
  });

  it('is evaluated PER-CALL, not cached — two calls with different chaves diverge', async () => {
    const fake = magic();
    const first = await fake.pagarPix(pagarInput('e2e-outcome-pago@fake.test'));
    const second = await fake.pagarPix(pagarInput('e2e-outcome-rejeitado@fake.test'));
    expect(first.outcome).toBe('pago');
    expect(second.outcome).toBe('rejeitado');
  });
});

describe('TransferenciaProviderFake — magic ENABLED: consult follow-up encoding', () => {
  const magic = () => new TransferenciaProviderFake({ e2eMagicOutcomes: true });

  it('agendado default → consultarPagamento resolves pago', async () => {
    const fake = magic();
    const out = await fake.pagarPix(pagarInput('e2e-outcome-agendado@fake.test'));
    const codigo = out.outcome === 'agendado_aprovacao' ? out.codigoSolicitacao : '';
    const consulta = await fake.consultarPagamento(codigo);
    expect(consulta.status).toBe('pago');
  });

  it('agendado -consult-rejeitado → consultarPagamento resolves rejeitado', async () => {
    const fake = magic();
    const out = await fake.pagarPix(pagarInput('e2e-outcome-agendado-consult-rejeitado@fake.test'));
    const codigo = out.outcome === 'agendado_aprovacao' ? out.codigoSolicitacao : '';
    const consulta = await fake.consultarPagamento(codigo);
    expect(consulta.status).toBe('rejeitado');
  });

  it('agendado -consult-processando → consultarPagamento resolves em_processamento (non-terminal)', async () => {
    const fake = magic();
    const out = await fake.pagarPix(
      pagarInput('e2e-outcome-agendado-consult-processando@fake.test'),
    );
    const codigo = out.outcome === 'agendado_aprovacao' ? out.codigoSolicitacao : '';
    const consulta = await fake.consultarPagamento(codigo);
    expect(consulta.status).toBe('em_processamento');
  });

  it('a non-magic codigo still uses the scripted consult queue', async () => {
    const fake = new TransferenciaProviderFake({
      e2eMagicOutcomes: true,
      consultSequence: ['aguardando_aprovacao'],
    });
    const consulta = await fake.consultarPagamento('inter_fake_plain_123');
    expect(consulta.status).toBe('aguardando_aprovacao');
  });
});

describe('TransferenciaProviderFake — magic ENABLED: search reconciliation', () => {
  const magic = () => new TransferenciaProviderFake({ e2eMagicOutcomes: true });

  it('ambiguo -search-hit → buscarPagamentos returns ONE candidate matching this repasse (valor + chave)', async () => {
    const fake = magic();
    const chave = 'e2e-outcome-ambiguo-search-hit@fake.test';
    // pagarPix throws (ambiguo) but records the candidate first.
    await expect(fake.pagarPix(pagarInput(chave, 7777))).rejects.toThrow();

    const found = await fake.buscarPagamentos({ dataInicio: '2026-07-01', dataFim: '2026-07-31' });
    expect(found).toHaveLength(1);
    expect(found[0]?.valorCents).toBe(7777);
    expect(found[0]?.chave).toBe(chave);
    expect(found[0]?.referencia).toBe('ENe2eref');
  });

  it('ambiguo WITHOUT -search-hit → buscarPagamentos stays empty (disarmed zero-candidate path)', async () => {
    const fake = magic();
    await expect(fake.pagarPix(pagarInput('e2e-outcome-ambiguo@fake.test'))).rejects.toThrow();
    const found = await fake.buscarPagamentos({ dataInicio: '2026-07-01', dataFim: '2026-07-31' });
    expect(found).toHaveLength(0);
  });
});
