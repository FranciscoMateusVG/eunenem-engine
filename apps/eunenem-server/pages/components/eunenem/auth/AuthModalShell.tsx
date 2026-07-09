import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { isValidEmail, type AuthSession } from "@/lib/auth";
import { authClient } from "@/lib/authClient";

// aperture-3mq5q — AuthModalShell (single smart entry).
//
// Camada E collapse: the old two-step (email → password) + two-mode
// (signin/signup) modal is gone. There is now ONE smart passwordless flow —
// the operator's "one smart Entrar". The server figures out existing-vs-new
// when the magic link is clicked, so the client never branches on mode and
// never asks for a password.
//
// Flow (status machine, NOT step/mode):
//   "idle"    → OAuth row + "ou" divider + email input + "enviar link mágico"
//   "sending" → CTA spinner while authClient.signIn.magicLink resolves
//   "sent"    → uniform confirmation (enumeration-safe: NEVER reveals whether
//               the account already existed) + optional "enviar de novo"
//   "error"   → error banner, form still editable so the user can retry
//
// OAuth providers: Google + Microsoft, wired to the real BetterAuth social
// flow (onOauth → authClient.signIn.social). ZERO Apple.
//
// Mode/onModeChange props are retained ONLY so the existing AuthModalProvider
// keeps compiling (it still passes them); they are deliberately ignored —
// there are no modes anymore.
//
// Accessibility:
//   - role="dialog" + aria-modal + aria-labelledby/-describedby
//   - ESC closes (unless mid-send), backdrop click closes (unless mid-send)
//   - Focus trap: Tab cycles within modal; Shift+Tab wraps backward
//   - First focusable element (email input) receives focus on open
//   - Focus returns to the trigger element on close (provider owns the ref)
//   - Body scroll locked while open

export type AuthMode = "signup" | "signin";
type Status = "idle" | "sending" | "sent" | "error";

export interface AuthModalShellProps {
  /**
   * Retained for API compatibility with AuthModalProvider — the single smart
   * flow has no modes, so this is ignored.
   */
  mode?: AuthMode;
  /** Called when the user dismisses (X, ESC, or backdrop click). */
  onClose: () => void;
  /**
   * Retained for API compatibility with AuthModalProvider — there is no
   * mode swap anymore, so this is never called.
   */
  onModeChange?: (next: AuthMode) => void;
  /**
   * Retained for API compatibility. The magic-link flow authenticates via a
   * full-page redirect after the user clicks the emailed link, so the modal
   * never resolves a session inline and never calls this.
   */
  onAuthenticated?: (session: AuthSession) => void;
}

const OAUTH_PROVIDERS = [
  { id: "google", label: "Google", icon: GoogleIcon },
  { id: "microsoft", label: "Microsoft", icon: MicrosoftIcon },
] as const;

export function AuthModalShell({ onClose }: AuthModalShellProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();
  const emailId = useId();

  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  const isSending = status === "sending";

  // ── Lifecycle: ESC, body scroll lock ──────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSending) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, isSending]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ── Initial / status-change focus ─────────────────────────────────────────
  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return;
    const focusables = getFocusables(root);
    const initial = root.querySelector<HTMLElement>("[data-autofocus]");
    (initial ?? focusables[0])?.focus();
  }, [status]);

  // ── Focus trap ────────────────────────────────────────────────────────────
  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = getFocusables(root);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  // aperture-8655f (Google) + aperture-y5ual (Microsoft/Entra) — wired to the
  // real BetterAuth social flow. `signIn.social` redirects to the provider,
  // then BetterAuth's callback at /api/auth/callback/<provider> returns the
  // browser to `callbackURL`.
  //
  // aperture-ydj4a — callbackURL is "/?oauth=1" (NOT bare "/"). The OAuth return
  // is a full page load, so the ?oauth=1 marker lets useOauthReturnRedirect
  // (mounted on the landing) resolve auth.me and forward to /painel/<slug>.
  const onOauth = async (id: string, label: string) => {
    if (id !== "google" && id !== "microsoft") {
      toast("em breve ♡", {
        description: `login com ${label} chega numa próxima entrega`,
      });
      return;
    }
    try {
      await authClient.signIn.social({
        provider: id as "google" | "microsoft",
        callbackURL: "/?oauth=1",
      });
      // On success the browser is navigating away — nothing else to do.
    } catch {
      toast(`não consegui abrir o ${label} agora ♡`, {
        description: "tenta de novo em instantes",
      });
    }
  };

  // aperture-3mq5q — single passwordless submit. We never pre-check whether the
  // email exists (no enumeration oracle): BetterAuth sends a magic link either
  // way and the "sent" confirmation is uniform. The server decides
  // login-vs-create when the link is clicked.
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setSubmitError(null);
    if (!email.trim()) {
      setEmailError("preenche aqui pra eu te enviar o link ♡");
      return;
    }
    if (!isValidEmail(email)) {
      setEmailError("esse e-mail tá meio torto — confere pra mim?");
      return;
    }

    setStatus("sending");
    try {
      await authClient.signIn.magicLink({
        email,
        callbackURL: `${window.location.origin}/?oauth=1`,
      });
      setStatus("sent");
    } catch {
      setStatus("error");
      setSubmitError("não consegui enviar agora — tenta de novo em instantes ♡");
    }
  };

  const onResend = () => {
    setStatus("idle");
    setSubmitError(null);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="auth-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSending) onClose();
      }}
    >
      <style>{AUTH_CSS}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        className="auth-card"
      >
        {/* washi tape */}
        <span aria-hidden="true" className="auth-tape" />

        <button
          type="button"
          onClick={() => !isSending && onClose()}
          disabled={isSending}
          aria-label="Fechar"
          className="auth-close"
        >
          ×
        </button>

        {status === "sent" ? (
          // ── Confirmation — uniform + enumeration-safe ──────────────────────
          // CRITICAL: this copy must NOT reveal whether the account already
          // existed. It covers both cases in one breath on purpose.
          <>
            <header className="auth-head">
              <p className="auth-eyebrow">quase lá ♡</p>
              <h2 id={titleId} className="auth-title">
                confere seu email ♡
              </h2>
              <p id={subtitleId} className="auth-subtitle">
                se você já tem conta, enviamos um link de acesso pra{" "}
                <strong>{email}</strong>. se ainda não tem, o link cria sua
                conta. é só clicar ♡
              </p>
            </header>
            <button
              type="button"
              onClick={onResend}
              data-autofocus
              className="auth-cta"
            >
              não recebeu? enviar de novo
            </button>
          </>
        ) : (
          // ── Idle / error — the single smart entry form ─────────────────────
          <>
            <header className="auth-head">
              <p className="auth-eyebrow">entra que é rapidinho ♡</p>
              <h2 id={titleId} className="auth-title">
                entrar ou criar sua lista
              </h2>
              <p id={subtitleId} className="auth-subtitle">
                sem senha — a gente te manda um link mágico ♡
              </p>
            </header>

            <form onSubmit={onSubmit} className="auth-form" noValidate>
              <div className="auth-oauth-row">
                {OAUTH_PROVIDERS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onOauth(id, label)}
                    aria-label={`Continuar com ${label}`}
                    className="auth-oauth"
                  >
                    <Icon />
                    <span>Continuar com <strong>{label}</strong></span>
                  </button>
                ))}
              </div>

              <div className="auth-divider" aria-hidden="true">
                <span className="auth-divider-line" />
                <span className="auth-divider-label">ou</span>
                <span className="auth-divider-line" />
              </div>

              <label htmlFor={emailId} className="auth-label">
                Seu e-mail
              </label>
              <div className={`auth-input-wrap ${emailError ? "has-error" : ""}`}>
                <EnvelopeIcon />
                <input
                  id={emailId}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Digite o endereço de e-mail"
                  aria-required="true"
                  aria-invalid={emailError ? true : false}
                  aria-describedby={emailError ? `${emailId}-err` : undefined}
                  disabled={isSending}
                  data-autofocus
                  className="auth-input"
                />
              </div>
              {emailError && (
                <p id={`${emailId}-err`} role="alert" className="auth-field-error">
                  {emailError}
                </p>
              )}

              <button
                type="submit"
                className="auth-cta"
                disabled={isSending}
                aria-busy={isSending}
              >
                {isSending ? (
                  <>
                    <Spinner />
                    ENVIANDO…
                  </>
                ) : (
                  <>enviar link mágico ♡</>
                )}
              </button>
            </form>

            {/* submit-level error (network etc.) */}
            {submitError && (
              <p role="alert" className="auth-error-banner">
                {submitError}
              </p>
            )}

            {/* fineprint — always shown: a single entry can create accounts */}
            <p className="auth-fineprint">
              Ao criar minha conta, declaro que li e aceito os{" "}
              <a href="/termos-de-uso" target="_blank" rel="noopener noreferrer">
                Termos de uso
              </a>{" "}
              e a{" "}
              <a href="/privacidade" target="_blank" rel="noopener noreferrer">
                Política de Privacidade
              </a>
              {" "}da EuNeném.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Focusable-element selector — small custom focus trap. Excludes hidden + disabled.
// ════════════════════════════════════════════════════════════════════════════
const FOCUSABLE_SEL = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SEL)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Inline SVG icons — vendored so the modal has zero asset dependencies.
// Google + Microsoft logos match the reference PNGs. (Apple dropped — Camada E.)
// ════════════════════════════════════════════════════════════════════════════

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C33.8 6.2 29.1 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16.2 19 13 24 13c3.1 0 5.8 1.2 8 3l5.7-5.7C33.8 6.2 29.1 4 24 4c-7.5 0-14 4.1-17.7 10.7z"/>
      <path fill="#4CAF50" d="M24 44c5 0 9.6-1.9 13-5.1l-6-5.1c-2 1.5-4.4 2.4-7 2.4-5.3 0-9.7-3.4-11.3-8l-6.6 5.1C9.9 39.8 16.4 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4 5.6l6 5.1c-.4.4 6.7-4.9 6.7-14.7 0-1.3-.1-2.4-.4-3.5z"/>
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 23 23" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF"/>
      <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
    </svg>
  );
}

function EnvelopeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className="auth-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// CSS — scoped to the .auth-* selector namespace. Uses the eunenem-server
// design tokens already declared in tailwind.css.
// ════════════════════════════════════════════════════════════════════════════
// aperture-84a21 — exported so the OnboardingWizard reuses the exact modal CSS.
export const AUTH_CSS = `
.auth-backdrop{
  position:fixed;inset:0;z-index:120;
  background:rgba(107,60,94,.45);
  backdrop-filter:blur(8px);
  -webkit-backdrop-filter:blur(8px);
  display:flex;align-items:center;justify-content:center;
  padding:16px;
  animation:authFadeIn .18s ease-out;
}
@keyframes authFadeIn{from{opacity:0}to{opacity:1}}

.auth-card{
  position:relative;
  background:#fff;
  border-radius:24px;
  width:100%;max-width:480px;
  padding:36px 32px 24px;
  box-shadow:0 24px 48px rgba(107,60,94,.25), 0 4px 12px rgba(107,60,94,.1);
  animation:authPopIn .22s cubic-bezier(.2,.9,.3,1.2);
}
@keyframes authPopIn{
  from{opacity:0;transform:translateY(8px) scale(.97)}
  to{opacity:1;transform:translateY(0) scale(1)}
}

.auth-tape{
  position:absolute;
  top:-14px;left:50%;
  width:88px;height:26px;
  transform:translateX(-50%) rotate(-4deg);
  background:repeating-linear-gradient(
    45deg,
    rgba(255,255,255,.45) 0,rgba(255,255,255,.45) 4px,
    transparent 4px,transparent 9px),
    var(--lilac-soft);
  box-shadow:0 1px 3px rgba(107,60,94,.15);
  border-radius:1px;
}

.auth-close{
  position:absolute;top:16px;right:16px;
  width:34px;height:34px;border-radius:50%;
  background:var(--cream-2);color:var(--ink-soft);
  border:none;cursor:pointer;
  font-size:22px;line-height:1;font-weight:300;
  display:flex;align-items:center;justify-content:center;
  transition:background .15s ease,color .15s ease,transform .12s ease;
}
.auth-close:hover:not(:disabled){background:var(--lilac-soft);color:var(--plum);transform:scale(1.05)}
.auth-close:focus-visible{outline:2px solid var(--lilac-deep);outline-offset:3px}
.auth-close:disabled{opacity:.4;cursor:not-allowed}

.auth-head{
  text-align:center;
  margin:0 0 22px;
  position:relative;
}
.auth-back{
  position:absolute;top:-12px;left:-8px;
  background:transparent;border:none;cursor:pointer;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:12px;font-weight:600;letter-spacing:.08em;
  color:var(--ink-soft);
  padding:8px 12px;border-radius:999px;
  transition:background .15s ease,color .15s ease;
}
.auth-back:hover:not(:disabled){background:var(--cream-2);color:var(--plum)}
.auth-back:focus-visible{outline:2px solid var(--lilac-deep);outline-offset:2px}
.auth-back:disabled{opacity:.4;cursor:not-allowed}

.auth-eyebrow{
  margin:0 0 2px;
  font-family:var(--font-caveat),cursive;
  font-size:22px;line-height:1;
  color:var(--coral-pink);
}
.auth-title{
  margin:0 0 6px;
  font-family:var(--font-patrick-hand),cursive;
  font-size:28px;line-height:1.1;
  color:var(--plum);
  font-weight:600;
  letter-spacing:-.005em;
}
.auth-subtitle{
  margin:0;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:13px;line-height:1.45;
  color:var(--ink-soft);
  max-width:380px;
  margin-left:auto;margin-right:auto;
}

.auth-form{display:flex;flex-direction:column;gap:0}

.auth-oauth-row{display:flex;flex-direction:column;gap:10px;margin-bottom:18px}
.auth-oauth{
  display:flex;align-items:center;gap:14px;
  padding:12px 16px;
  background:#fff;
  border:1.5px solid var(--line);
  border-radius:14px;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:14px;font-weight:500;
  color:var(--ink);
  cursor:pointer;
  text-align:left;
  transition:border-color .15s ease,background .15s ease,transform .12s ease;
}
.auth-oauth strong{font-weight:600;color:var(--plum)}
.auth-oauth:hover{border-color:var(--lilac);background:var(--lilac-soft)}
.auth-oauth:focus-visible{outline:2px solid var(--lilac-deep);outline-offset:2px}
.auth-oauth svg{flex:0 0 auto}

.auth-divider{
  display:flex;align-items:center;gap:12px;
  margin:8px 0 16px;
}
.auth-divider-line{
  flex:1;height:1px;
  background-image:linear-gradient(to right,var(--line) 50%,transparent 50%);
  background-size:6px 1px;background-repeat:repeat-x;
}
.auth-divider-label{
  font-family:var(--font-dm-sans),sans-serif;
  font-size:11px;font-weight:500;letter-spacing:.12em;
  text-transform:uppercase;color:var(--ink-mute);
}

.auth-label{
  display:block;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:12px;font-weight:500;
  color:var(--ink-soft);
  margin:0 0 6px 4px;
}

.auth-input-wrap{
  display:flex;align-items:center;gap:10px;
  background:rgba(245,240,243,.4);
  border:1.5px solid var(--line);
  border-radius:14px;
  padding:0 14px;
  transition:border-color .15s ease,background .15s ease;
  margin-bottom:6px;
}
.auth-input-wrap:focus-within{
  border-color:var(--lilac-deep);
  background:#fff;
}
.auth-input-wrap.has-error{
  border-color:var(--coral-pink);
  background:rgba(251,224,234,.25);
}
.auth-input-wrap > svg:first-child{color:var(--ink-mute);flex:0 0 auto}
.auth-input{
  flex:1;min-width:0;
  background:transparent;border:none;outline:none;
  padding:13px 0;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:14px;
  color:var(--ink);
}
.auth-input::placeholder{color:var(--ink-mute)}
.auth-input:disabled{cursor:not-allowed;color:var(--ink-mute)}

.auth-pw-toggle{
  background:transparent;border:none;cursor:pointer;
  color:var(--ink-mute);
  padding:6px;border-radius:8px;
  display:flex;align-items:center;justify-content:center;
  transition:color .15s ease,background .15s ease;
}
.auth-pw-toggle:hover:not(:disabled){color:var(--plum);background:var(--cream-2)}
.auth-pw-toggle:focus-visible{outline:2px solid var(--lilac-deep);outline-offset:2px}
.auth-pw-toggle:disabled{opacity:.4;cursor:not-allowed}

.auth-field-error{
  margin:6px 4px 12px;
  font-family:var(--font-caveat),cursive;
  font-size:16px;line-height:1.2;
  color:var(--coral-pink);
}
.auth-error-banner{
  margin:14px 0 0;
  padding:10px 14px;
  background:rgba(231,143,167,.12);
  border:1px solid var(--coral-pink);
  border-radius:12px;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:13px;line-height:1.4;
  color:var(--plum);
  text-align:center;
}

.auth-cta{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  width:100%;
  margin-top:18px;
  padding:16px 20px;
  background:var(--lilac);
  color:#fff;
  border:none;border-radius:14px;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:13px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;
  cursor:pointer;
  box-shadow:var(--shadow-cta);
  transition:transform .12s ease,background .15s ease,box-shadow .2s ease;
}
.auth-cta:hover:not(:disabled){background:var(--lilac-deep);transform:translateY(-1px)}
.auth-cta:focus-visible{outline:2px solid var(--lilac-deep);outline-offset:3px}
.auth-cta:disabled{opacity:.7;cursor:not-allowed;box-shadow:none}

.auth-spin{animation:authSpin .9s linear infinite}
@keyframes authSpin{to{transform:rotate(360deg)}}

.auth-footer{
  margin:18px 0 0;text-align:center;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:13px;color:var(--ink-soft);
}
.auth-swap{
  background:transparent;border:none;cursor:pointer;padding:0 2px;
  font-family:inherit;font-size:inherit;font-weight:600;
  color:var(--coral-pink);
  text-decoration:underline;text-decoration-thickness:1.5px;text-underline-offset:3px;
  transition:color .15s ease;
}
.auth-swap:hover:not(:disabled){color:var(--plum)}
.auth-swap:focus-visible{outline:2px solid var(--lilac-deep);outline-offset:3px;border-radius:4px}
.auth-swap:disabled{opacity:.5;cursor:not-allowed}

.auth-fineprint{
  margin:14px 0 0;text-align:center;
  font-family:var(--font-dm-sans),sans-serif;
  font-size:11px;line-height:1.5;
  color:var(--ink-mute);
  padding:0 4px;
}
.auth-fineprint a{
  color:var(--coral-pink);
  text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px;
}
.auth-fineprint a:hover{color:var(--plum)}

/* narrow viewports — keep the card breathing room */
@media (max-width:520px){
  .auth-card{padding:32px 22px 20px;border-radius:20px}
  .auth-title{font-size:24px}
  .auth-subtitle{font-size:12.5px}
  .auth-oauth{padding:11px 14px;font-size:13.5px}
}

@media (prefers-reduced-motion:reduce){
  .auth-backdrop,.auth-card,.auth-cta,.auth-oauth,.auth-close,.auth-back,
  .auth-input-wrap,.auth-pw-toggle,.auth-spin,.auth-swap{
    animation:none;transition:none;
  }
}
`;
