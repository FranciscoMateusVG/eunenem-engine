// aperture-g1wl4 — unit matrix for the LEGACY-FIRST post-login routing fix
// (Bug 1 from the 2026-07-08 migration test; backend PR #342 + frontend PR #341).
//
// THE BUG: a fresh-signup user whose email matches legacy-1.0-users.json has an
// empty profile (needsOnboarding=true) and was routed into the onboarding
// WIZARD instead of /campanhas, where their 1.0 migration card lives. The fix:
//   - backend (#342): auth.me exposes `isLegacy` — derived server-side as
//     `buscarCampanhasLegado(usuario.email).length > 0` (auth-router.ts `me`).
//   - frontend (#341): both post-login gate sites reorder the decision so
//     legacy OUTRANKS the wizard. The production expression, VERBATIM in
//     AuthModalProvider.tsx (onAuthenticated) AND useOauthReturnRedirect.ts:
//
//       const target = isLegacy(me)
//         ? '/campanhas'
//         : needsOnboarding(me)
//           ? `/painel/${me.slug}`
//           : '/campanhas';
//
// WHAT THIS FILE PINS (the pure helpers — the E2E covers the wiring):
//   1. `isLegacy(me)` (pages/lib/onboarding-gate.ts) has the SAME defensive-read
//      contract as `needsOnboarding`: literal `true` on a non-null object and
//      NOTHING else. Mirrors the 8bac7-onboarding-gate.test.ts matrix so a
//      future "helpful" loosening (truthy check) fails loudly here too.
//   2. The composed precedence: for every {isLegacy, needsOnboarding}
//      combination, the decision expression above resolves to the right target
//      — including the defensive combos where a malformed isLegacy must NOT
//      skip the wizard.
//
// CROSS-REFERENCE — auth.me contract (NOT duplicated here): the server-side
// derivation shipped with its own router suite in
// tests/unit/server/authme-islegacy.test.ts (buildRig through appRouter):
// legacy stub email franciscomateusvg@gmail.com → isLegacy=true (incl. the
// case-insensitive UPPERCASE variant), random email → false, self-only
// (no cross-user leak), anonymous → me is null. Re-running that rig here
// would be verbatim duplication.

import { describe, expect, it } from 'vitest';
import {
  isLegacy,
  needsOnboarding,
} from '../../../apps/eunenem-server/pages/lib/onboarding-gate.js';

describe('isLegacy — the ONLY true case', () => {
  it('literal true on a plain object', () => {
    expect(isLegacy({ isLegacy: true })).toBe(true);
  });

  it('literal true survives extra fields (real auth.me shape)', () => {
    expect(
      isLegacy({
        idUsuario: 'u1',
        email: 'x@y.z',
        slug: 'helena',
        needsOnboarding: true,
        isAdmin: false,
        isLegacy: true,
      }),
    ).toBe(true);
  });
});

describe('isLegacy — everything else is false', () => {
  const cases: readonly [label: string, input: unknown][] = [
    ['false', { isLegacy: false }],
    ['missing field (pre-#342 backend)', { idUsuario: 'u1', email: 'x@y.z' }],
    ['string "true" (JSON-stringified backend drift)', { isLegacy: 'true' }],
    ['number 1 (truthy but not boolean)', { isLegacy: 1 }],
    ['null field', { isLegacy: null }],
    ['undefined field', { isLegacy: undefined }],
    ['object field (truthy)', { isLegacy: {} }],
    ['array field (truthy)', { isLegacy: [true] }],
    ['me is null (logged out)', null],
    ['me is undefined (query not resolved)', undefined],
    ['me is a primitive string', 'isLegacy'],
    ['me is a number', 42],
    ['me is a boolean true (not an object)', true],
    ['me is an empty object', {}],
  ];

  for (const [label, input] of cases) {
    it(label, () => {
      expect(isLegacy(input)).toBe(false);
    });
  }
});

describe('legacy-first precedence — the composed post-login decision', () => {
  /**
   * VERBATIM copy of the production decision expression shared by
   * AuthModalProvider.tsx (onAuthenticated) and useOauthReturnRedirect.ts —
   * see the file header. The expression itself is inline at both sites (no
   * extracted decision function exists on staging), so this matrix pins the
   * HELPERS' composed semantics; the E2E (e2e/g1wl4-islegacy-routing.spec.ts
   * + e2e/8bac7-postlogin-routing.spec.ts) pins that the sites actually run
   * it. If a shared resolvePostLoginTarget() is ever extracted, point this
   * at it and delete the copy.
   */
  function resolveTarget(me: unknown, slug: string): string {
    return isLegacy(me) ? '/campanhas' : needsOnboarding(me) ? `/painel/${slug}` : '/campanhas';
  }

  it('THE BUG SCENARIO: isLegacy=true + needsOnboarding=true → /campanhas (legacy outranks the wizard)', () => {
    expect(resolveTarget({ isLegacy: true, needsOnboarding: true }, 'helena')).toBe('/campanhas');
  });

  it('isLegacy=true + needsOnboarding=false → /campanhas (onboarded legacy user)', () => {
    expect(resolveTarget({ isLegacy: true, needsOnboarding: false }, 'helena')).toBe('/campanhas');
  });

  it('isLegacy=false + needsOnboarding=true → /painel/:slug (aperture-ivu2t wizard gate preserved)', () => {
    expect(resolveTarget({ isLegacy: false, needsOnboarding: true }, 'helena')).toBe(
      '/painel/helena',
    );
  });

  it('isLegacy=false + needsOnboarding=false → /campanhas (aperture-g7l09 default)', () => {
    expect(resolveTarget({ isLegacy: false, needsOnboarding: false }, 'helena')).toBe('/campanhas');
  });

  it('DEFENSIVE: string "true" isLegacy must NOT skip the wizard for a fresh signup', () => {
    expect(resolveTarget({ isLegacy: 'true', needsOnboarding: true }, 'helena')).toBe(
      '/painel/helena',
    );
  });

  it('DEFENSIVE: truthy-number isLegacy must NOT skip the wizard for a fresh signup', () => {
    expect(resolveTarget({ isLegacy: 1, needsOnboarding: true }, 'helena')).toBe('/painel/helena');
  });

  it('DEFENSIVE: missing isLegacy (pre-#342 payload) keeps the ivu2t wizard route', () => {
    expect(resolveTarget({ needsOnboarding: true }, 'helena')).toBe('/painel/helena');
  });
});
