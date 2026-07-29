import { describe, expect, it } from 'vitest';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';

/**
 * aperture-cusen — contract pin for the server-side password capability kill.
 *
 * This deliberately inspects the composed application router rather than a
 * test-only auth router. If a future edit re-adds any password procedure to
 * production composition, the flattened procedure inventory changes here.
 */
describe('password authentication retirement', () => {
  it('exposes only session inspection and logout under auth.*', () => {
    const authProcedures = Object.keys(appRouter._def.procedures)
      .filter((name) => name.startsWith('auth.'))
      .sort();

    expect(authProcedures).toEqual(['auth.me', 'auth.signOut']);
  });

  it('does not expose the retired password procedures', () => {
    const procedures = appRouter._def.procedures;

    expect(procedures).not.toHaveProperty('auth.signUp');
    expect(procedures).not.toHaveProperty('auth.signIn');
    expect(procedures).not.toHaveProperty('auth.continuarComEmail');
  });
});
