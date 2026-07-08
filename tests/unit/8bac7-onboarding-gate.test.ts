// aperture-8bac7 — defensive-read matrix for the server-authoritative
// onboarding gate (aperture-8ysqu / aperture-ivu2t).
//
// Contract (lib/onboarding-gate.ts): needsOnboarding(me) returns true ONLY
// for a literal `needsOnboarding: true` on a non-null object. EVERYTHING else
// — missing field, false, non-boolean truthy, null/undefined me, primitives —
// means "no onboarding needed". This makes the gate safe BEFORE the backend
// field ships (no-op) and immune to malformed auth.me payloads. This suite
// pins that contract so a future "helpful" loosening (e.g. truthy check)
// fails loudly here.

import { describe, expect, it } from 'vitest';
import { needsOnboarding } from '../../apps/eunenem-server/pages/lib/onboarding-gate.js';

describe('needsOnboarding — the ONLY true case', () => {
  it('literal true on a plain object', () => {
    expect(needsOnboarding({ needsOnboarding: true })).toBe(true);
  });

  it('literal true survives extra fields (real auth.me shape)', () => {
    expect(
      needsOnboarding({
        id: 'u1',
        email: 'x@y.z',
        needsOnboarding: true,
        isAdmin: false,
      }),
    ).toBe(true);
  });
});

describe('needsOnboarding — everything else is false', () => {
  const cases: readonly [label: string, input: unknown][] = [
    ['false', { needsOnboarding: false }],
    ['missing field', { id: 'u1', email: 'x@y.z' }],
    ['string "true" (JSON-stringified backend drift)', { needsOnboarding: 'true' }],
    ['number 1 (truthy but not boolean)', { needsOnboarding: 1 }],
    ['null field', { needsOnboarding: null }],
    ['undefined field', { needsOnboarding: undefined }],
    ['object field (truthy)', { needsOnboarding: {} }],
    ['array field (truthy)', { needsOnboarding: [true] }],
    ['me is null (logged out)', null],
    ['me is undefined (query not resolved)', undefined],
    ['me is a primitive string', 'needsOnboarding'],
    ['me is a number', 42],
    ['me is a boolean true (not an object)', true],
    ['me is an empty object', {}],
  ];

  for (const [label, input] of cases) {
    it(label, () => {
      expect(needsOnboarding(input)).toBe(false);
    });
  }
});
