import { createHash } from 'node:crypto';
/** No provider payload/PII is returned by this policy; references are audit-only. */
export interface RecoveryCandidate {
  readonly e2eId: string | null;
  readonly destination: 'matches' | 'different' | 'unknown';
}
export interface RecoveryEvidence {
  readonly lookup: 'negative' | 'positive' | 'inconclusive';
  readonly candidates: readonly RecoveryCandidate[];
}
export type RecoveryDecision = 'negative' | 'manual_attestation' | 'blocked';
export function decideManualRecovery(evidence: RecoveryEvidence): RecoveryDecision {
  if (
    evidence.lookup === 'positive' ||
    evidence.candidates.some(
      (candidate) => candidate.destination !== 'different' || !candidate.e2eId?.trim(),
    )
  )
    return 'blocked';
  if (evidence.lookup === 'negative' && evidence.candidates.length === 0) return 'negative';
  return 'manual_attestation';
}

export function pixKeyFingerprint(key: string): string {
  return createHash('sha256').update(key.trim().toLowerCase()).digest('hex');
}

export function classifyDestination(
  payment: { chave?: string; recipientName?: string; recipientDocument?: string },
  recipient: { nomeTitular: string; cpfTitular: string } | undefined,
  originalKeyFingerprint: string | null,
): RecoveryCandidate['destination'] {
  const normalizedName = (value: string) =>
    value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const doc = payment.recipientDocument?.replace(/[./ -]/g, '');
  const name = payment.recipientName;
  if (
    payment.chave &&
    originalKeyFingerprint &&
    pixKeyFingerprint(payment.chave) === originalKeyFingerprint
  )
    return 'matches';
  if (
    recipient &&
    ((doc && doc === recipient.cpfTitular.replace(/\D/g, '')) ||
      (name && normalizedName(name) === normalizedName(recipient.nomeTitular)))
  )
    return 'matches';
  // A differing key alone can belong to the same person. Only a complete
  // destination identity supports dismissal, never a masked/partial document.
  if (recipient && doc && /^\d{11}(?:\d{3})?$/.test(doc)) return 'different';
  if (recipient && name && /^[\p{L}][\p{L} .'-]{3,}$/u.test(name)) return 'different';
  return 'unknown';
}
