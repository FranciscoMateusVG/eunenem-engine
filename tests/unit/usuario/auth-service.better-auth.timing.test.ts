import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * aperture-olgk2 — timing-oracle regression test for the BetterAuth
 * adapter's `iniciarSessao`.
 *
 * WHY THE BETTERAUTH ADAPTER SPECIFICALLY (not the memory adapter):
 * `AuthServiceMemoria` is branch-SYMMETRIC — its unknown-email and
 * wrong-password paths are structurally identical, so a memory-adapter
 * test would pass even if the BetterAuth fix regressed. The oracle lived
 * ONLY in `AuthServiceBetterAuth`, whose no-user branch used to `throw`
 * WITHOUT running scrypt while the user-exists branch paid one
 * `verifyPassword`. This test pins the fix at the layer where the bug
 * was: it asserts that BOTH the unknown-email branch AND the
 * wrong-password branch invoke `verifyPassword` exactly once.
 *
 * The Postgres-backed conformance suite
 * (tests/integration/auth-service-better-auth.postgres.test.ts) covers
 * functional behavior. Here we mock the db query (no-row vs row) and spy
 * on the `better-auth/crypto` import so the assertion is purely about the
 * scrypt CALL COUNT per branch — no container needed.
 */

// Spy on the crypto import the adapter pulls from 'better-auth/crypto'.
// hashPassword returns a deterministic fake (the dummy-hash mechanism
// only needs SOME string); verifyPassword is a spy whose call count we
// assert. We never exercise real scrypt here — this test is about which
// branches REACH the verify path, not about cryptographic correctness.
const hashPasswordSpy = vi.fn(async (_plain: string) => 'fake-scrypt-hash');
const verifyPasswordSpy = vi.fn(async (_args: { hash: string; password: string }) => false);

vi.mock('better-auth/crypto', () => ({
  hashPassword: (plain: string) => hashPasswordSpy(plain),
  verifyPassword: (args: { hash: string; password: string }) => verifyPasswordSpy(args),
}));

// Import AFTER the mock is registered (vi.mock is hoisted, but keep the
// import here for clarity).
const { AuthServiceBetterAuth } = await import(
  '../../../src/adapters/usuario/auth-service.better-auth.js'
);
const { UsuarioInputInvalidoError } = await import(
  '../../../src/errors/usuario/input-invalido.error.js'
);

const ID_PLATAFORMA = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'someone@example.com';
const SENHA = 'qualquer-senha-123';

/**
 * Minimal fake Kysely chain covering exactly the calls `iniciarSessao`
 * makes on the SELECT path:
 *   selectFrom('users').innerJoin(...).select(...).where(...).where(...)
 *     .where(...).executeTakeFirst()
 * `executeTakeFirst` resolves to `selectResult` (undefined ⇒ no-user
 * branch; a row ⇒ user-exists branch). The INSERT path used after a
 * successful verify is NOT exercised in these tests (verify returns false
 * for the wrong-password case), so its chain is left unimplemented.
 */
function makeFakeDb(selectResult: unknown) {
  const selectChain: Record<string, unknown> = {};
  selectChain.innerJoin = () => selectChain;
  selectChain.select = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.executeTakeFirst = async () => selectResult;
  return {
    selectFrom: () => selectChain,
  } as never;
}

describe('AuthServiceBetterAuth.iniciarSessao — timing-oracle (aperture-olgk2)', () => {
  beforeEach(() => {
    hashPasswordSpy.mockClear();
    verifyPasswordSpy.mockClear();
    verifyPasswordSpy.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('UNKNOWN-EMAIL branch (no row) runs verifyPassword exactly once before throwing', async () => {
    const service = new AuthServiceBetterAuth(makeFakeDb(undefined));

    await expect(
      service.iniciarSessao({
        idPlataforma: ID_PLATAFORMA as never,
        email: EMAIL as never,
        senha: SENHA,
      }),
    ).rejects.toBeInstanceOf(UsuarioInputInvalidoError);

    // The dummy-hash mechanism: the no-user branch MUST pay one scrypt.
    expect(verifyPasswordSpy).toHaveBeenCalledTimes(1);
    // And it must verify against the dummy hash (the value hashPassword
    // produced), with the attacker-supplied password.
    expect(verifyPasswordSpy).toHaveBeenCalledWith({
      hash: 'fake-scrypt-hash',
      password: SENHA,
    });
  });

  it('WRONG-PASSWORD branch (row exists, verify=false) runs verifyPassword exactly once before throwing', async () => {
    const service = new AuthServiceBetterAuth(
      makeFakeDb({ id: 'user-123', password: 'real-account-hash' }),
    );

    await expect(
      service.iniciarSessao({
        idPlataforma: ID_PLATAFORMA as never,
        email: EMAIL as never,
        senha: SENHA,
      }),
    ).rejects.toBeInstanceOf(UsuarioInputInvalidoError);

    expect(verifyPasswordSpy).toHaveBeenCalledTimes(1);
    // The user-exists branch verifies against the REAL account hash.
    expect(verifyPasswordSpy).toHaveBeenCalledWith({
      hash: 'real-account-hash',
      password: SENHA,
    });
  });

  it('both branches throw the SAME ambiguous error message (no enumeration via message either)', async () => {
    const unknownEmail = new AuthServiceBetterAuth(makeFakeDb(undefined));
    const wrongPassword = new AuthServiceBetterAuth(
      makeFakeDb({ id: 'user-123', password: 'real-account-hash' }),
    );

    const errUnknown = await unknownEmail
      .iniciarSessao({ idPlataforma: ID_PLATAFORMA as never, email: EMAIL as never, senha: SENHA })
      .catch((e: unknown) => e as Error);
    const errWrong = await wrongPassword
      .iniciarSessao({ idPlataforma: ID_PLATAFORMA as never, email: EMAIL as never, senha: SENHA })
      .catch((e: unknown) => e as Error);

    expect(errUnknown).toBeInstanceOf(UsuarioInputInvalidoError);
    expect(errWrong).toBeInstanceOf(UsuarioInputInvalidoError);
    expect(errUnknown.message).toContain('Email ou senha invalidos');
    expect(errWrong.message).toBe(errUnknown.message);
  });
});
