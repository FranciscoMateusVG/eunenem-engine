import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../src/adapters/plataforma/repository.memory.js';
import type { AuthService } from '../../src/adapters/usuario/auth-service.js';
import { TokenSessaoSchema } from '../../src/domain/usuario/value-objects/token-sessao.js';
import { UsuarioEmailJaExisteError } from '../../src/errors/usuario/email-ja-existe.error.js';
import { UsuarioInputInvalidoError } from '../../src/errors/usuario/input-invalido.error.js';

interface ConformanceOptions {
  /**
   * Build a FRESH `AuthService` for each test (so token gens and clocks
   * are deterministic per assertion). Implementations should pass a
   * fixed `clock` + `sessionTtlMs` if they want exact `expiraEm`
   * comparisons.
   */
  readonly factory: () => AuthService | Promise<AuthService>;
  /** Truncate any persistent state between tests (postgres only). */
  readonly resetState?: () => Promise<void>;
}

/**
 * Parameterized conformance suite for `AuthService` (aperture-g7f68).
 *
 * Same test cases drive `AuthServiceMemoria` AND `AuthServiceBetterAuth`.
 * Adapter parity — credential round-trip, ambiguous error on bad creds,
 * compensation hook (`removerConta`), expiry handling, multi-tenant
 * scoping (operator decision #2) — is enforced by running identical
 * assertions against both implementations.
 *
 * Each test makes its own users so they don't collide across cases (the
 * suite can run sequentially under the SAME `AuthService` instance after
 * `resetState` clears state).
 */
export function describeAuthServiceConformance(name: string, options: ConformanceOptions) {
  describe(`AuthService conformance — ${name}`, () => {
    let auth: AuthService;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      auth = await options.factory();
    });

    it('criarConta → iniciarSessao → validarSessao → revogarSessao round-trip', async () => {
      const idUsuario = randomUUID();
      await auth.criarConta({
        idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'rt@example.com',
        senha: 'super-secret',
        nome: 'Round Tripper',
      });

      const sessao = await auth.iniciarSessao({
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'rt@example.com',
        senha: 'super-secret',
      });
      expect(sessao.idUsuario).toBe(idUsuario);
      expect(sessao.token.length).toBeGreaterThanOrEqual(32);
      expect(sessao.expiraEm.getTime()).toBeGreaterThan(Date.now());

      const validated = await auth.validarSessao(sessao.token);
      expect(validated?.idUsuario).toBe(idUsuario);
      expect(validated?.expiraEm.getTime()).toBe(sessao.expiraEm.getTime());

      await auth.revogarSessao(sessao.token);
      expect(await auth.validarSessao(sessao.token)).toBeNull();
    });

    it('iniciarSessao throws ambiguous UsuarioInputInvalidoError on wrong password', async () => {
      await auth.criarConta({
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'wp@example.com',
        senha: 'right-one',
        nome: 'Wrong Password Target',
      });
      await expect(
        auth.iniciarSessao({
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'wp@example.com',
          senha: 'wrong-one',
        }),
      ).rejects.toThrow(UsuarioInputInvalidoError);
    });

    it('iniciarSessao throws ambiguous UsuarioInputInvalidoError on unknown email', async () => {
      await expect(
        auth.iniciarSessao({
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'ghost@example.com',
          senha: 'whatever',
        }),
      ).rejects.toThrow(UsuarioInputInvalidoError);
    });

    it('iniciarSessao refuses cross-plataforma sign-in (operator decision #2)', async () => {
      await auth.criarConta({
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'only-eunenem@example.com',
        senha: 'p',
        nome: 'Eunenem Only',
      });
      await expect(
        auth.iniciarSessao({
          idPlataforma: ID_PLATAFORMA_EUCASEI,
          email: 'only-eunenem@example.com',
          senha: 'p',
        }),
      ).rejects.toThrow(UsuarioInputInvalidoError);
    });

    it('criarConta throws UsuarioEmailJaExisteError on duplicate (idPlataforma, email)', async () => {
      await auth.criarConta({
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'dup@example.com',
        senha: 'p',
        nome: 'First',
      });
      await expect(
        auth.criarConta({
          idUsuario: randomUUID(),
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'dup@example.com',
          senha: 'p',
          nome: 'Second',
        }),
      ).rejects.toThrow(UsuarioEmailJaExisteError);
    });

    it('criarConta allows the same email across different plataformas (operator decision #2)', async () => {
      const email = 'cross-tenant@example.com';
      const idA = randomUUID();
      const idB = randomUUID();
      await auth.criarConta({
        idUsuario: idA,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email,
        senha: 'pa',
        nome: 'On Eunenem',
      });
      await auth.criarConta({
        idUsuario: idB,
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        email,
        senha: 'pb',
        nome: 'On Eucasei',
      });

      const onEunenem = await auth.iniciarSessao({
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email,
        senha: 'pa',
      });
      const onEucasei = await auth.iniciarSessao({
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        email,
        senha: 'pb',
      });
      expect(onEunenem.idUsuario).toBe(idA);
      expect(onEucasei.idUsuario).toBe(idB);
    });

    it('removerConta tears down the auth principal (T3 compensation)', async () => {
      const idUsuario = randomUUID();
      await auth.criarConta({
        idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'tomato@example.com',
        senha: 'sauce',
        nome: 'Tomato',
      });
      await auth.removerConta(idUsuario);
      // Re-sign-in fails (no principal).
      await expect(
        auth.iniciarSessao({
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'tomato@example.com',
          senha: 'sauce',
        }),
      ).rejects.toThrow(UsuarioInputInvalidoError);
      // Re-create with the same id + email succeeds (state is clean).
      await expect(
        auth.criarConta({
          idUsuario,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'tomato@example.com',
          senha: 'sauce',
          nome: 'Tomato Retry',
        }),
      ).resolves.toBeDefined();
    });

    it('removerConta is idempotent', async () => {
      await expect(auth.removerConta(randomUUID())).resolves.toBeUndefined();
    });

    it('alterarSenha updates the credential and invalidates the old one', async () => {
      const idUsuario = randomUUID();
      await auth.criarConta({
        idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'rotate@example.com',
        senha: 'old',
        nome: 'Rotator',
      });

      await auth.alterarSenha({ idUsuario, novaSenha: 'new' });

      await expect(
        auth.iniciarSessao({
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'rotate@example.com',
          senha: 'old',
        }),
      ).rejects.toThrow(UsuarioInputInvalidoError);

      const sessao = await auth.iniciarSessao({
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'rotate@example.com',
        senha: 'new',
      });
      expect(sessao.idUsuario).toBe(idUsuario);
    });

    it('validarSessao returns null for unknown tokens', async () => {
      const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
      expect(await auth.validarSessao(token)).toBeNull();
    });
  });
}
