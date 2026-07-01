/**
 * Admin authz gate — end-to-end proof (aperture-4n222).
 *
 * Exercises the REAL `adminProcedure` middleware through `appRouter.createCaller`
 * against a representative admin procedure (`admin.searchUsers`). Proves all
 * four decision branches of the gate that 4n222 adds to the previously-ungated
 * `admin.*` surface:
 *
 *   1. anon (no session)            → UNAUTHORIZED
 *   2. authed but NOT allowlisted   → FORBIDDEN
 *   3. authed AND allowlisted       → passes the gate
 *   4. empty allowlist              → FORBIDDEN even for an authed user (fail-closed)
 *
 * Plus normalization (case/whitespace-insensitive match). The anon branch is the
 * non-vacuous CONTROL: it confirms the proc is genuinely gated, so the
 * allowlisted-pass assertion means something.
 *
 * `searchUsers({ prefix: '' })` short-circuits to `[]` AFTER the gate (before any
 * repo call), so the allowlisted-pass case proves we cleared authz without
 * needing the data layer wired.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';

const SESSION_COOKIE = 'better-auth.session_token';
const TOKEN = 'admin-gate-test-token';

/**
 * Build a minimal ServerDeps that resolves a session for `email` (or none when
 * `email` is null = anon) and an allowlist. Only the resolver PATH-1 surface
 * (`authService.validarSessao` + `usuarioRepository.findUsuarioById`) and the
 * anon PATH-2 fallback (`auth.api.getSession` → null) are stubbed — the gate
 * runs before any other dep is touched.
 */
function makeDeps(args: { email: string | null; allowlist: readonly string[] }): {
  deps: ServerDeps;
  headers: Headers;
} {
  const idUsuario = randomUUID();
  const usuario = {
    id: idUsuario,
    idConta: randomUUID(),
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    email: args.email ?? '',
    nomeExibicao: 'Gate Test',
    slug: 'gate-test',
  };

  const deps = {
    auth: { api: { getSession: async () => null } },
    authService: {
      validarSessao: async (token: string) =>
        args.email && token === TOKEN
          ? { idUsuario, expiraEm: new Date(Date.now() + 60 * 60 * 1000) }
          : null,
    },
    usuarioRepository: {
      findUsuarioById: async (id: string) => (id === idUsuario ? usuario : undefined),
    },
    adminAllowedEmails: new Set(args.allowlist.map((e) => e.trim().toLowerCase())),
    sessionCookieName: SESSION_COOKIE,
  } as unknown as ServerDeps;

  const headers = args.email
    ? new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(TOKEN)}` })
    : new Headers();

  return { deps, headers };
}

function caller(deps: ServerDeps, headers: Headers) {
  const ctx: TrpcContext = { deps, headers, resHeaders: new Headers() };
  return appRouter.createCaller(ctx);
}

describe('admin authz gate (aperture-4n222)', () => {
  it('(1) anon (no session) → UNAUTHORIZED on an admin proc [CONTROL]', async () => {
    const { deps, headers } = makeDeps({ email: null, allowlist: ['admin@x.com'] });
    await expect(caller(deps, headers).admin.searchUsers({ prefix: 'a' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('(2) authed but NOT allowlisted → FORBIDDEN', async () => {
    const { deps, headers } = makeDeps({ email: 'intruder@x.com', allowlist: ['admin@x.com'] });
    await expect(caller(deps, headers).admin.searchUsers({ prefix: 'a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('(3) authed AND allowlisted → passes the gate', async () => {
    const { deps, headers } = makeDeps({ email: 'admin@x.com', allowlist: ['admin@x.com'] });
    // prefix '' short-circuits to [] AFTER the gate → proves authz cleared.
    await expect(caller(deps, headers).admin.searchUsers({ prefix: '' })).resolves.toEqual([]);
  });

  it('(4) empty allowlist → FORBIDDEN even for an authed user (fail-closed)', async () => {
    const { deps, headers } = makeDeps({ email: 'admin@x.com', allowlist: [] });
    await expect(caller(deps, headers).admin.searchUsers({ prefix: 'a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('(5) allowlist match is case/whitespace-insensitive', async () => {
    const { deps, headers } = makeDeps({ email: ' Admin@X.com ', allowlist: ['admin@x.com'] });
    await expect(caller(deps, headers).admin.searchUsers({ prefix: '' })).resolves.toEqual([]);
  });
});
