import { randomUUID } from 'node:crypto';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';

/**
 * Test helper (aperture-4n222) — the minimal ServerDeps slice + headers that
 * PASS the admin authz gate, for admin-DATA tests that need to exercise their
 * procedures past the gate without standing up full auth infra.
 *
 * It stubs ONLY the resolver's bare-cookie PATH 1
 * (`authService.validarSessao(token)` → `{ idUsuario, expiraEm }`, then
 * `usuarioRepository.findUsuarioById(idUsuario)` → a Usuario carrying the admin
 * email) and seeds the allowlist with that email. The OAuth `getSession`
 * fallback (PATH 2) is never reached because PATH 1 resolves.
 *
 * The gate's REAL decision logic (anon → 401, non-admin → 403, admin → pass)
 * is proven separately end-to-end in admin-gate.test.ts — this helper exists so
 * the pre-existing admin-router tests keep asserting their DATA behavior after
 * the gate landed, not to re-prove the gate.
 *
 * Usage: `const ctx = { deps: { ...deps, ...a.depsOverrides }, headers: a.headers, resHeaders: new Headers() }`.
 */
const SESSION_COOKIE = 'better-auth.session_token';
const ADMIN_TOKEN = 'admin-test-session-token';

/** Default admin identity seeded into the allowlist for tests. */
export const ADMIN_TEST_EMAIL = 'admin-test@example.com';

export interface AdminAuthOverrides {
  readonly depsOverrides: Pick<
    ServerDeps,
    'authService' | 'usuarioRepository' | 'adminAllowedEmails' | 'sessionCookieName'
  >;
  readonly headers: Headers;
}

export function adminAuthOverrides(email: string = ADMIN_TEST_EMAIL): AdminAuthOverrides {
  const idUsuario = randomUUID();
  const expiraEm = new Date(Date.now() + 60 * 60 * 1000);
  const usuario = {
    id: idUsuario,
    idConta: randomUUID(),
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    email,
    nomeExibicao: 'Admin Test',
    slug: 'admin-test',
  };

  return {
    depsOverrides: {
      authService: {
        validarSessao: async (token: string) =>
          token === ADMIN_TOKEN ? { idUsuario, expiraEm } : null,
      } as unknown as ServerDeps['authService'],
      usuarioRepository: {
        findUsuarioById: async (id: string) => (id === idUsuario ? usuario : undefined),
      } as unknown as ServerDeps['usuarioRepository'],
      adminAllowedEmails: new Set([email.trim().toLowerCase()]),
      sessionCookieName: SESSION_COOKIE,
    },
    headers: new Headers({
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(ADMIN_TOKEN)}`,
    }),
  };
}
