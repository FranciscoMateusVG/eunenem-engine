import { describe, expect, it } from 'vitest';
import {
  classifyDestination,
  decideManualRecovery,
} from '../../../../../src/use-cases/pagamentos/financeiro/manual-recovery-policy.js';

describe('45h33 lookup evidence precedence', () => {
  it('definitive negative without debit permits automatic negative resolution', () => {
    expect(decideManualRecovery({ lookup: 'negative', candidates: [] })).toBe('negative');
  });
  it('positive lookup can never be overridden by an attestation', () => {
    expect(decideManualRecovery({ lookup: 'positive', candidates: [] })).toBe('blocked');
  });
  it('matching recipient debit blocks even when lookup is negative', () => {
    expect(
      decideManualRecovery({
        lookup: 'negative',
        candidates: [{ e2eId: 'E1', destination: 'matches' }],
      }),
    ).toBe('blocked');
  });
  it('a debit without destination blocks without override', () => {
    expect(
      decideManualRecovery({
        lookup: 'inconclusive',
        candidates: [{ e2eId: 'E1', destination: 'unknown' }],
      }),
    ).toBe('blocked');
  });
  it('clearly different recipient requires manual attestation of every E2E', () => {
    expect(
      decideManualRecovery({
        lookup: 'negative',
        candidates: [{ e2eId: 'E1', destination: 'different' }],
      }),
    ).toBe('manual_attestation');
  });
  it('a different recipient without an auditable E2E cannot be dismissed', () => {
    expect(
      decideManualRecovery({
        lookup: 'inconclusive',
        candidates: [{ e2eId: null, destination: 'different' }],
      }),
    ).toBe('blocked');
  });
  it('empty statement is inconclusive, never proof of non-payment', () => {
    expect(decideManualRecovery({ lookup: 'inconclusive', candidates: [] })).toBe(
      'manual_attestation',
    );
  });
});

describe('45h33 candidate destination', () => {
  const receiver = { nomeTitular: 'Ana Teste', cpfTitular: '12345678901' };
  it('matches normalized name even when a key differs', () => {
    expect(
      classifyDestination({ recipientName: ' ANA  TESTE ', chave: 'other' }, receiver, null),
    ).toBe('matches');
  });
  it('different complete document is dismissible but missing fields are unknown', () => {
    expect(classifyDestination({ recipientDocument: '99999999999' }, receiver, null)).toBe(
      'different',
    );
    expect(classifyDestination({}, receiver, null)).toBe('unknown');
  });
  it('partial masked identity cannot prove a different recipient', () => {
    expect(classifyDestination({ recipientDocument: '***.456.***-**' }, receiver, null)).toBe(
      'unknown',
    );
  });
});
