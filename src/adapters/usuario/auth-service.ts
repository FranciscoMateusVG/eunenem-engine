import type { EmailUsuario } from '../../domain/usuario/value-objects/email-usuario.js';
import type { IdPlataformaReferencia, IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import type { TokenSessao } from '../../domain/usuario/value-objects/token-sessao.js';

/**
 * Authentication port for the Usuario BC (aperture-ibbet — foundation for
 * BetterAuth Pattern A, recon source aperture-q2i8l §5).
 *
 * Two adapters in flight:
 *   - `AuthServiceMemoria` — in-process, deterministic, replaces the old
 *     SenhaSimulada + TokenSessao adapter pair. Used by all tests + the
 *     example.
 *   - `AuthServiceBetterAuth` (FUTURE, aperture-g7f68) — wraps BetterAuth's
 *     `auth.api.signUp / signInEmail / getSession / revokeSession /
 *     setUserPassword`. Shares the engine's Kysely instance via
 *     `createKyselyAdapter(existingKysely)`.
 *
 * **Why each method takes `idPlataforma`** (deviation from the literal bead
 * spec, justified by operator decision #2 — preserve composite email
 * uniqueness `(idPlataforma, email)`): the engine supports the same email
 * registered on multiple plataformas as distinct users. BetterAuth's user
 * table has globally unique email; the adapter is responsible for
 * translating the composite key. Passing `idPlataforma` on
 * `criarConta`/`iniciarSessao` lets the adapter scope correctly without
 * leaking that translation into the domain.
 *
 * **Compensation contract** (T3 from monorepo-incluir): mutating methods
 * commit on their own connection in the BetterAuth-future adapter — they
 * are NOT enrolled in any wrapping transaction. Callers that need an undo
 * path must use `removerConta` as a compensation step (the in-memory
 * adapter respects the same contract from day one so the discipline is
 * baked in).
 */
export interface AuthService {
  /**
   * Create an auth principal. The caller supplies `idUsuario` so the engine
   * keeps caller-controlled UUIDs (consistent with the rest of the codebase
   * — Campanha, Contribuicao, Pagamento all take their id as input).
   *
   * The adapter MAY reject duplicate `(idPlataforma, email)` or duplicate
   * `idUsuario` — those should surface as typed errors from the caller's
   * pre-check, not from this port. In normal operation the caller runs
   * `usuarioRepository.findUsuarioByEmail(idPlataforma, email)` before
   * calling `criarConta`.
   */
  criarConta(input: {
    readonly idUsuario: IdUsuario;
    readonly idPlataforma: IdPlataformaReferencia;
    readonly email: EmailUsuario;
    readonly senha: string;
    readonly nome: NomeExibicaoUsuario;
  }): Promise<{ readonly idUsuario: IdUsuario }>;

  /**
   * Verify credentials and issue a session. Returns `idUsuario` so the
   * caller can derive `idConta` via `Usuario.idConta` (the auth principal
   * in this BC is Conta, but auth identity is Usuario — see recon §8 #4).
   *
   * Throws `UsuarioInputInvalidoError` on bad credentials. Does NOT
   * distinguish "wrong email" from "wrong password" (intentional, prevents
   * user-enumeration).
   */
  iniciarSessao(input: {
    readonly idPlataforma: IdPlataformaReferencia;
    readonly email: EmailUsuario;
    readonly senha: string;
  }): Promise<{
    readonly idUsuario: IdUsuario;
    readonly token: TokenSessao;
    readonly expiraEm: Date;
  }>;

  /**
   * Resolve a session token. Returns `null` (NOT throws) for unknown,
   * expired, or revoked tokens — call sites already throw the typed
   * `UsuarioSessaoInvalidaError` so collapsing all those cases into `null`
   * keeps the port simple and avoids leaking adapter-specific error shapes.
   */
  validarSessao(token: TokenSessao): Promise<{
    readonly idUsuario: IdUsuario;
    readonly expiraEm: Date;
  } | null>;

  /** Revoke a single session token. Idempotent — revoking an unknown token is a no-op. */
  revogarSessao(token: TokenSessao): Promise<void>;

  /** Change the stored credential for a given user. No effect on existing sessions. */
  alterarSenha(input: { readonly idUsuario: IdUsuario; readonly novaSenha: string }): Promise<void>;

  /**
   * Compensation hook: tear down the auth principal AND all its sessions.
   * Idempotent — calling for a non-existent user is a no-op. Used by
   * `registrarContaUsuario` to roll back the BetterAuth-side write when
   * the domain `saveRegistroDomain` fails.
   */
  removerConta(idUsuario: IdUsuario): Promise<void>;
}
