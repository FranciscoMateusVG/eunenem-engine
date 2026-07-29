import { initTRPC } from '@trpc/server';
import { type IdCampanhaEvento } from '../../../../src/index.js';
import { buscarCampanhasLegado } from '../../lib/legacy-users.js';
import { isEmailAdmin } from '../auth/admin-allowlist.js';
import type { TrpcContext } from './context.js';
import {
  readSessionCookie,
  resolverUsuarioAutenticadoOuNull,
} from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

/**
 * Clear the legacy bare engine-session cookie while the retirement window is
 * open. Password authentication is no longer exposed, but sessions minted
 * before the removal remain valid until their normal seven-day expiry and
 * must still be revocable on sign-out.
 */
function clearSessionCookie(
  resHeaders: Headers,
  name: string,
  useSecureCookies: boolean,
): void {
  const parts = [`${name}=`, `Max-Age=0`, `Path=/`, `HttpOnly`, `SameSite=Lax`];
  if (useSecureCookies) parts.push('Secure');
  resHeaders.append('set-cookie', parts.join('; '));
}

/**
 * Passwordless auth router (aperture-cusen).
 *
 * Account creation and login happen only through BetterAuth's OAuth or
 * magic-link routes. The former public password procedures (`signUp`,
 * `signIn`, and `continuarComEmail`) were removed rather than hidden behind a
 * client-side gate. This router now owns only session inspection and logout.
 */
export const authRouter = t.router({
  signOut: t.procedure.mutation(async ({ ctx }) => {
    const { deps, headers, resHeaders } = ctx;

    // ── PATH 1 — pre-retirement engine session (bare cookie) ──────────
    // A bare `better-auth.session_token` minted before password auth was
    // removed remains revocable until its normal seven-day expiry.
    const token = readSessionCookie(headers, deps.sessionCookieName);
    if (token) {
      // Validate-then-strip on the way out — TokenSessaoSchema requires
      // ≥32 chars, so a garbage cookie value would throw. Silently
      // ignore that: signing out should never error on a malformed
      // cookie.
      try {
        await deps.authService.revogarSessao(token);
      } catch {
        // ignore — cookie is being cleared anyway
      }
    }
    clearSessionCookie(
      resHeaders,
      deps.sessionCookieName,
      deps.auth.options.advanced?.useSecureCookies ?? false,
    );

    // ── PATH 2 — BetterAuth/OAuth session (aperture-qpvdh, folds p9td2) ─
    // The MIRROR of the A2 read-fallback in session-resolver.ts. Under
    // `useSecureCookies` (staging/prod) a Google OAuth session lives in the
    // `__Secure-`-PREFIXED, HMAC-SIGNED cookie that the bare read+clear
    // above can NOT see. Before this, an OAuth user's signOut was a no-op:
    // `revogarSessao` was never called (bare token absent → session row
    // survived) AND only the bare cookie was cleared (the `__Secure-` one
    // stayed in the browser) → the next `auth.me` re-resolved them via
    // getSession → still logged in. That was the p9td2 symptom.
    //
    // Delegate to BetterAuth's PROGRAMMATIC signOut (a direct function
    // call, NOT the denied `/api/auth/sign-out` HTTP route): it natively
    // reads the signed cookie, REVOKES the session server-side
    // (internalAdapter.deleteSession), and emits the matching Set-Cookie
    // clear. We forward those Set-Cookie header(s) onto resHeaders so the
    // browser drops the `__Secure-` cookie too. `asResponse` is used so we
    // get a real Headers object whose multiple Set-Cookie values survive
    // (getSetCookie()) rather than being comma-collapsed.
    //
    // Fail-open on the LOGOUT direction is intended: a signOut that can't
    // reach BetterAuth has already cleared the engine cookie and must never
    // throw. For a pre-retirement bare-cookie session there is no signed cookie
    // to find, so BetterAuth emits an idempotent clear — harmless.
    try {
      const betterAuthResponse = await deps.auth.api.signOut({
        headers,
        asResponse: true,
      });
      for (const setCookie of betterAuthResponse.headers.getSetCookie()) {
        resHeaders.append('set-cookie', setCookie);
      }
    } catch {
      // Never let logout error — the engine session/cookie is already gone.
    }

    return { ok: true as const };
  }),

  /**
   * Probe: returns the currently-authenticated user's id + session expiry
   * if the cookie maps to a live session, or `null` otherwise.
   * Frontend's "am I logged in?" check.
   *
   * Post-aperture-p8i01: also returns `idCampanha` + `idOpcaoPresentes`
   * so the frontend can render the user's Lista de presentes without a
   * follow-up round-trip. The signup saga guarantees both exist for
   * every signed-up user. For backfilled users (pre-p8i01) the values
   * resolve via `campanhaRepository.findFirstByAdministrador`; if the
   * backfill hasn't run yet (or somehow missed a user) both fields are
   * `null` and the client falls back to an empty-list UX.
   */
  me: t.procedure.query(async ({ ctx }) => {
    const { deps, headers } = ctx;

    // aperture-6wo1f: resolve the session through the shared central resolver —
    // A2 (bare-cookie path with a BetterAuth `getSession` fallback for the prod
    // OAuth __Secure-/signed cookie) fused with the OAuth-orphan self-heal. The
    // `OuNull` variant returns null (rather than throwing) on no-session or a
    // failed heal — the `me` probe's logged-out signal. All A2 + heal logic +
    // Cipher's atomicity invariant live in session-resolver.ts.
    const resolvido = await resolverUsuarioAutenticadoOuNull(deps, headers);
    if (!resolvido) return null;
    const { usuario, expiraEm } = resolvido;

    // p8i01: resolve the user's default Campanha + the 'presente' opcao
    // inside it. Single DB hit (findFirstByAdministrador joins
    // campanhas + campanha_administradores + opcoes_contribuicao).
    const campanha = await deps.campanhaRepository.findFirstByAdministrador(usuario.idConta);
    const opcaoPresentes = campanha?.opcoes.find((o) => o.tipo === 'presente');

    // aperture-b6xr8 / aperture-lrl1h — server-side onboarding signal for the
    // wizard gate (Vance's aperture-8ysqu). PROVIDER-AGNOSTIC: it keys off
    // profile STATE, not how the user authenticated (email / Google / Microsoft
    // y5ual / lazily-provisioned OAuth orphans).
    //
    // The signal means "the user has NO usable campaign at all". It is derived
    // from whether ANY of the user's campanhas has a non-empty nomeBebe — NOT
    // just the OLDEST one. aperture-lrl1h fixed a false-wizard bug: a non-legacy
    // user whose OLDEST campanha had an empty nomeBebe but who owned NEWER named
    // lists was wrongly sent to the wizard. Read perfil_campanhas (where the
    // wizard WRITES via perfilCampanha.atualizar), never the legacy per-user
    // perfil_criadores (reading that would loop a fresh signup at true).
    //
    // Gap 4 — an editable nomeBebe must not un-onboard a user who has a list.
    // Latch `onboarding_concluido_em` the first time we observe a named campanha
    // (best-effort: a write failure never breaks auth.me; first-write-wins in
    // the repo). Once latched, needsOnboarding stays false even if the user
    // later clears nomeBebe. Self-heals existing users on their next login with
    // NO backfill — they already read not-needing-onboarding via the named-
    // campanha derivation, and the latch fills in lazily. isLegacy still
    // outranks this downstream (a fresh legacy signup is empty but must route
    // to /campanhas, never the wizard).
    const campanhasDoUsuario = await deps.campanhaRepository.findCampanhasByAdministrador(
      usuario.idConta,
    );
    const perfisDoUsuario = await Promise.all(
      campanhasDoUsuario.map((c) => deps.perfilCampanhaRepository.findByIdCampanha(c.id)),
    );
    const temCampanhaNomeada = perfisDoUsuario.some(
      (p) => (p?.conteudo.nomeBebe ?? '').trim().length > 0,
    );
    let onboardingConcluidoEm = usuario.onboardingConcluidoEm;
    if (temCampanhaNomeada && onboardingConcluidoEm === null) {
      const agora = new Date();
      try {
        await deps.usuarioRepository.marcarOnboardingConcluido(usuario.id, agora);
        onboardingConcluidoEm = agora;
      } catch {
        // Best-effort latch — never break auth.me. needsOnboarding still reads
        // correct this request via temCampanhaNomeada; the latch retries on a
        // future login.
      }
    }
    const needsOnboarding = onboardingConcluidoEm === null && !temCampanhaNomeada;

    // aperture-mu1v9 (uxv83 rider) — the default campanha's event date,
    // sourced from the `eventos` single source (the same value the convite
    // and the perfil page show). The painel countdown's TODO(aperture-uxv83)
    // in pages/lib/mocks/painelDemo.ts explicitly waits for "campanha.
    // dataEvento … on auth.me"; this is that wire surface. Null when the
    // campanha has no evento row or the date is undecided.
    const eventoDefault = campanha
      ? await deps.eventoRepository.findByIdCampanha(campanha.id as IdCampanhaEvento)
      : undefined;
    const dataEvento = eventoDefault?.dataHora?.toISOString() ?? null;

    // aperture — legacy-first routing signal. `true` when the caller's OWN
    // email matches the 1.0 legacy list, via the SAME matcher campanhas.list
    // uses (buscarCampanhasLegado, case-insensitive, self-only — no client
    // email input). The frontend routes a legacy user to /campanhas BEFORE the
    // needsOnboarding wizard gate: a fresh-signup legacy user has an empty
    // profile (needsOnboarding=true) but must land on /campanhas to see their
    // 1.0 card, never the onboarding wizard. Pure in-memory match over the
    // static snapshot — no extra DB call, no legacy-system runtime call.
    const isLegacy = buscarCampanhasLegado(usuario.email).length > 0;

    return {
      idUsuario: usuario.id,
      idConta: usuario.idConta,
      idPlataforma: usuario.idPlataforma,
      email: usuario.email,
      nomeExibicao: usuario.nomeExibicao,
      /**
       * aperture-4n222 — admin flag for the frontend `/admin` UX gate. The
       * email is in the `ADMIN_ALLOWED_EMAILS` allowlist (same normalized Set
       * the server-side `adminProcedure` gate enforces — single source, no
       * drift). This is a UX SIGNAL ONLY; the real boundary is the backend 403
       * on every admin route. No extra DB call.
       */
      isAdmin: isEmailAdmin(deps.adminAllowedEmails ?? new Set<string>(), usuario.email),
      /**
       * Public URL slug (aperture-khbow). Lets the client redirect to
       * `/painel/<slug>` post-auth in one round-trip — no follow-up call
       * to fetch the user's own slug.
       */
      slug: usuario.slug,
      /**
       * Default Campanha id (aperture-p8i01). null only if backfill
       * has not yet been applied to a pre-p8i01 user.
       */
      idCampanha: campanha?.id ?? null,
      /**
       * Initial 'presente' OpcaoContribuicao id inside the default
       * Campanha (aperture-p8i01). Same caveat as idCampanha.
       */
      idOpcaoPresentes: opcaoPresentes?.id ?? null,
      /**
       * aperture-mu1v9 (uxv83 rider) — ISO-8601 event date of the default
       * campanha, from the `eventos` single source. Null when no evento row
       * exists yet or the creator hasn't decided the date. Feeds the painel
       * countdown (see TODO(aperture-uxv83) in painelDemo.ts).
       */
      dataEvento,
      /**
       * aperture-0bynm — Solicitar Transferência onboarding embed.
       * `true` when the user's default campanha has an active recebedor
       * linked; `false` otherwise (first-time onboarding required).
       * Derived from the campanha aggregate's `idRecebedor` field
       * (Plan 0015 invariant — `idRecebedor` and `dadosRecebedor` are
       * either BOTH null or BOTH set). NO extra DB call.
       *
       * Frontend's TransferModal reads this to decide whether to embed
       * the BancariosBody onboarding form or proceed straight to
       * solicitarRepasse. `false` when `idCampanha` is null (the
       * pre-p8i01 backfill caveat) — frontend treats both the
       * no-campanha and no-recebedor cases as "render the form".
       */
      hasRecebedor: campanha?.idRecebedor != null,
      /**
       * aperture-b6xr8 — true when this account still needs the onboarding
       * wizard (creator profile has no baby name yet). The authoritative,
       * provider-agnostic gate the frontend (aperture-8ysqu) mounts the
       * OnboardingWizard on — replaces the brittle client-only `criado` flag
       * so Google/Microsoft OAuth signups (which never re-enter the auth
       * modal) also get onboarded. Flips to false once the wizard persists a
       * baby name via perfil.atualizar.
       */
      needsOnboarding,
      /**
       * aperture — `true` when the caller's email is in the 1.0 legacy list
       * (same case-insensitive matcher as campanhas.list; self-only). The
       * frontend routing signal that takes PRECEDENCE over needsOnboarding: a
       * legacy user always lands on /campanhas (to see their 1.0 card), even
       * on a fresh signup where their empty profile would otherwise route them
       * into the onboarding wizard. Provider-agnostic (keys off email, not how
       * they authenticated). No extra DB call — in-memory snapshot match.
       */
      isLegacy,
      expiraEm,
    };
  }),
});

export type AuthRouter = typeof authRouter;
