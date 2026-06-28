import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import {
  authErrorMessage,
  isValidEmail,
  MIN_PASSWORD_LENGTH,
  useContinuarComEmail,
  type AuthError,
  type AuthSession,
} from "@/lib/auth";
import { authClient } from "@/lib/authClient";

// aperture-ubpnl + aperture-d0x1w — AuthModalShell.
//
// aperture-d0x1w: swapped the mock contract at `lib/mocks/auth.ts` for the
// real tRPC procedures (Rex's PR #61). Same UX, same per-field error
// routing — just real network calls + real Postgres now.
//
// One component, two modes: "signup" and "signin". The shell is ~90% shared
// between the two reference PNGs (tape, close X, OAuth row, "ou" divider,
// email input, lavender CONTINUAR, fineprint). Mode swaps just retitle the
// header + footer cross-link.
//
// Email-first 2-step flow:
//   step 1 = OAuth row + email + CONTINUAR (the reference PNGs)
//   step 2 = (name for signup) + password + CONTINUAR — Vance designed
//
// OAuth providers: Google + Microsoft are wired to the real BetterAuth social
// flow (onOauth → authClient.signIn.social). Apple was removed (operator
// dropped the dead "em breve" stub — not returning in this redesign).
//
// State machine:
//   open + mode "signup" + step 1 → render signup email step
//   open + mode "signup" + step 2 → render signup password+name step
//   open + mode "signin" + step 1 → render signin email step
//   open + mode "signin" + step 2 → render signin password step
//
// Mode swap via footer cross-link is in-place — no remount. Internal step
// resets to 1 + clears password/name (keeps email so the user doesn't
// retype). Animations are short, opt-out via prefers-reduced-motion.
//
// Accessibility (acceptance criteria):
//   - role="dialog" + aria-modal + aria-labelledby
//   - ESC closes
//   - Backdrop click closes
//   - Focus trap: Tab cycles within modal; Shift+Tab wraps backward
//   - First focusable element receives focus on open (email input on step 1,
//     back-arrow on step 2 so screen readers announce the step change)
//   - Focus returns to the trigger element on close (consumer's hook owns
//     the trigger ref; AuthModalShell calls `onClose` and the hook restores)
//   - Body scroll locked while open

export type AuthMode = "signup" | "signin";
type Step = 1 | 2;

export interface AuthModalShellProps {
  mode: AuthMode;
  /** Called when the user dismisses (X, ESC, or backdrop click). */
  onClose: () => void;
  /** Called when the user toggles signin↔signup via the footer cross-link. */
  onModeChange: (next: AuthMode) => void;
  /** Called when the auth contract returns a successful session. */
  onAuthenticated?: (session: AuthSession) => void;
}

const COPY: Record<AuthMode, {
  eyebrow: string;
  title: string;
  subtitle: string;
  footerPrompt: string;
  footerCta: string;
  footerCtaTarget: AuthMode;
}> = {
  signup: {
    eyebrow: "vamos começar 🌸",
    title: "Crie sua lista grátis",
    subtitle: "Em menos de 5 minutos. Sem cartão, sem mensalidade.",
    footerPrompt: "Já tem conta?",
    footerCta: "Entrar",
    footerCtaTarget: "signin",
  },
  signin: {
    eyebrow: "bom te ver de novo ♡",
    title: "Entrar na sua conta",
    subtitle: "Acesse sua lista, mensagens e saldo.",
    footerPrompt: "Ainda não tem conta?",
    footerCta: "Criar grátis",
    footerCtaTarget: "signup",
  },
};

const OAUTH_PROVIDERS = [
  { id: "google", label: "Google", icon: GoogleIcon },
  { id: "microsoft", label: "Microsoft", icon: MicrosoftIcon },
] as const;

export function AuthModalShell({
  mode,
  onClose,
  onModeChange,
  onAuthenticated,
}: AuthModalShellProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();

  // Step machine. Mode swap resets step to 1 (handled in the cross-link
  // callback below — not in a useEffect, to avoid re-resetting on
  // unrelated rerenders).
  const [step, setStep] = useState<Step>(1);

  // Form state. Email survives mode swap; password resets on swap.
  // aperture-d7993 — the name field is gone: the unified email-first flow
  // derives nomeExibicao from the email and the onboarding wizard collects the
  // real display/baby name, so signup no longer asks for a name here.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Per-field errors + global submit state.
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // aperture-d7993 — one unified submit (Option B). The server decides
  // login-vs-create; we never pre-check email existence (no enumeration
  // oracle). Hook at top-level so rules-of-hooks holds across step changes.
  const { continuarComEmail } = useContinuarComEmail();

  const copy = COPY[mode];

  // ── Lifecycle: ESC, body scroll lock ──────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, isSubmitting]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // ── Focus trap + initial focus on step change ────────────────────────────
  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return;
    const focusables = getFocusables(root);
    // On step 1: focus the email input. On step 2: focus the back arrow so
    // SRs announce the step change cleanly. Falls back to the close button.
    const initial = root.querySelector<HTMLElement>(
      step === 1 ? "[data-autofocus='email']" : "[data-autofocus='back']",
    );
    (initial ?? focusables[0])?.focus();
  }, [step, mode]);

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
  const swapMode = useCallback(() => {
    setStep(1);
    setPassword("");
    setEmailError(null);
    setPasswordError(null);
    setSubmitError(null);
    setShowPassword(false);
    onModeChange(copy.footerCtaTarget);
  }, [copy.footerCtaTarget, onModeChange]);

  // aperture-8655f (Google) + aperture-y5ual (Microsoft/Entra) — both wired to
  // the real BetterAuth social flow; Apple stays a stub (sonner toast) until its
  // provider lands. `signIn.social` redirects to the provider, then BetterAuth's
  // callback at /api/auth/callback/<provider> returns the browser to `callbackURL`.
  //
  // aperture-ydj4a — callbackURL is "/?oauth=1" (NOT bare "/"). The OAuth return
  // is a full page load, so AuthModalProvider.onAuthenticated never runs to
  // forward the user to their painel (the email flow's redirect). The ?oauth=1
  // marker lets useOauthReturnRedirect (mounted on the landing) reproduce that
  // redirect: resolve auth.me, forward to /painel/<slug>. The marker is a fixed
  // same-origin literal and the redirect slug comes from the server, so this is
  // not an open-redirect surface. If auth.me can't resolve, the marker is
  // cleared and the user stays signed-in on the landing.
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

  const onStep1Submit = (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setSubmitError(null);
    if (!email.trim()) {
      setEmailError("preenche aqui pra eu te encontrar ♡");
      return;
    }
    if (!isValidEmail(email)) {
      setEmailError("esse e-mail tá meio torto — confere pra mim?");
      return;
    }
    setStep(2);
  };

  const onBack = () => {
    if (isSubmitting) return;
    setStep(1);
    setPasswordError(null);
    setSubmitError(null);
  };

  const onStep2Submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setSubmitError(null);
    if (!password) {
      setPasswordError("escolhe uma senha pra fechar a porta ♡");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(
        `a senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres ♡`,
      );
      return;
    }

    setIsSubmitting(true);
    try {
      // aperture-d7993 — one unified call. The server decides login-vs-create
      // and reports it via `session.criado`; the consumer (AuthModalProvider)
      // routes a brand-new account to onboarding and an existing login to the
      // painel. We surface an honest toast now that we know the outcome.
      const session = await continuarComEmail({ email, password });
      toast.success(session.criado ? "conta criada ♡" : "bem-vinda de volta ♡", {
        description: session.user.email,
      });
      onAuthenticated?.(session);
      onClose();
    } catch (err) {
      const e = err as AuthError;
      // Per-field routing — credentials + email-taken should land on the
      // password / email field respectively so the user knows where to fix.
      if (e.kind === "credentials") {
        setPasswordError(authErrorMessage(e));
      } else if (e.kind === "email-taken") {
        setSubmitError(authErrorMessage(e));
      } else if (e.kind === "short-password") {
        setPasswordError(authErrorMessage(e));
      } else if (e.kind === "invalid-email") {
        setSubmitError(authErrorMessage(e));
      } else {
        setSubmitError(authErrorMessage(e ?? { kind: "network" }));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="auth-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
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
          onClick={() => !isSubmitting && onClose()}
          disabled={isSubmitting}
          aria-label="Fechar"
          className="auth-close"
        >
          ×
        </button>

        {/* header — shared between steps + modes */}
        <header className="auth-head">
          {step === 2 && (
            <button
              type="button"
              onClick={onBack}
              disabled={isSubmitting}
              aria-label="Voltar para o passo anterior"
              data-autofocus="back"
              className="auth-back"
            >
              ← voltar
            </button>
          )}
          <p className="auth-eyebrow">{copy.eyebrow}</p>
          <h2 id={titleId} className="auth-title">
            {copy.title}
          </h2>
          <p id={subtitleId} className="auth-subtitle">
            {step === 1 ? copy.subtitle : `é só a senha pra ${email} ♡`}
          </p>
        </header>

        {/* body — branches on step */}
        {step === 1 ? (
          <StepOne
            email={email}
            setEmail={setEmail}
            emailError={emailError}
            onSubmit={onStep1Submit}
            onOauth={onOauth}
          />
        ) : (
          <StepTwo
            email={email}
            password={password}
            setPassword={setPassword}
            passwordError={passwordError}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            isSubmitting={isSubmitting}
            onSubmit={onStep2Submit}
          />
        )}

        {/* submit-level error (network, email-taken etc.) */}
        {submitError && (
          <p role="alert" className="auth-error-banner">
            {submitError}
          </p>
        )}

        {/* footer cross-link */}
        <p className="auth-footer">
          {copy.footerPrompt}{" "}
          <button
            type="button"
            onClick={swapMode}
            disabled={isSubmitting}
            className="auth-swap"
          >
            {copy.footerCta}
          </button>
        </p>

        {/* fineprint — signup-only, step-1-only (matches PNG) */}
        {mode === "signup" && step === 1 && (
          <p className="auth-fineprint">
            Ao criar a conta você concorda com os{" "}
            <a href="/termos" target="_blank" rel="noopener noreferrer">
              Termos de uso
            </a>{" "}
            e a{" "}
            <a href="/privacidade" target="_blank" rel="noopener noreferrer">
              Política de privacidade
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Step 1 — email + OAuth row (matches the reference PNGs verbatim)
// ════════════════════════════════════════════════════════════════════════════
function StepOne({
  email,
  setEmail,
  emailError,
  onSubmit,
  onOauth,
}: {
  email: string;
  setEmail: (v: string) => void;
  emailError: string | null;
  onSubmit: (e: React.FormEvent) => void;
  onOauth: (id: string, label: string) => void;
}) {
  const emailId = useId();
  return (
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
          data-autofocus="email"
          className="auth-input"
        />
      </div>
      {emailError && (
        <p id={`${emailId}-err`} role="alert" className="auth-field-error">
          {emailError}
        </p>
      )}

      <button type="submit" className="auth-cta">
        CONTINUAR <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Step 2 — name (signup only) + password — Vance-designed, mirrors step 1's
// visual identity: same card chrome, same label style, same lavender CTA.
// Password has a show/hide toggle. Submit button shows spinner while pending.
// ════════════════════════════════════════════════════════════════════════════
// aperture-d7993 — unified password step (Option B). No name field (the email
// derives nomeExibicao; the onboarding wizard collects the real name) and no
// mode branching: the copy is deliberately AMBIGUOUS ("sua senha — ou crie
// uma") because the server, not the client, decides login-vs-create at submit.
function StepTwo({
  email,
  password,
  setPassword,
  passwordError,
  showPassword,
  setShowPassword,
  isSubmitting,
  onSubmit,
}: {
  email: string;
  password: string;
  setPassword: (v: string) => void;
  passwordError: string | null;
  showPassword: boolean;
  setShowPassword: (v: boolean) => void;
  isSubmitting: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const passwordId = useId();
  return (
    <form onSubmit={onSubmit} className="auth-form" noValidate>
      {/* Hidden username field so password managers associate the credential
          with the email captured in step 1. */}
      <input
        type="email"
        value={email}
        autoComplete="username"
        readOnly
        aria-hidden="true"
        tabIndex={-1}
        style={{ display: "none" }}
      />

      <label htmlFor={passwordId} className="auth-label">
        Sua senha — ou crie uma
      </label>
      <div className={`auth-input-wrap ${passwordError ? "has-error" : ""}`}>
        <LockIcon />
        <input
          id={passwordId}
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres`}
          aria-required="true"
          aria-invalid={passwordError ? true : false}
          aria-describedby={passwordError ? `${passwordId}-err` : undefined}
          disabled={isSubmitting}
          className="auth-input"
        />
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          aria-label={showPassword ? "Esconder senha" : "Mostrar senha"}
          aria-pressed={showPassword}
          className="auth-pw-toggle"
          disabled={isSubmitting}
          tabIndex={0}
        >
          {showPassword ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {passwordError && (
        <p id={`${passwordId}-err`} role="alert" className="auth-field-error">
          {passwordError}
        </p>
      )}

      <button
        type="submit"
        className="auth-cta"
        disabled={isSubmitting}
        aria-busy={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <Spinner />
            CONTINUANDO…
          </>
        ) : (
          <>
            CONTINUAR <span aria-hidden="true">→</span>
          </>
        )}
      </button>
    </form>
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
// Google/Apple/Microsoft logos match the reference PNGs.
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

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
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
