import { useRef } from "react";

import { useAuthModal } from "./components/eunenem/auth/AuthModalProvider.js";
import { AUTH_DEMO_HINTS } from "./lib/mocks/auth.js";

// aperture-ubpnl — Dev-only demo surface for the auth modals.
//
// The bead is explicit that WHERE the trigger lives in production app chrome
// is out of scope. This page is the verification surface: 2 trigger buttons
// (signin + signup), plus a hint card with the demo credentials so an
// operator (or QA) can exercise the success + error paths end-to-end without
// guessing what the mock contract accepts.
//
// Routed at /auth-demo via App.tsx::resolveRoute. The route is unlisted in
// any nav — it's reachable only by typing the URL, which is the right
// scope for a v1 dev surface.

export function AuthDemoPage() {
  const auth = useAuthModal();
  const signinBtnRef = useRef<HTMLButtonElement | null>(null);
  const signupBtnRef = useRef<HTMLButtonElement | null>(null);

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "64px 24px",
        background:
          "linear-gradient(180deg, var(--cream) 0%, var(--paper) 60%, var(--lilac-soft) 100%)",
      }}
    >
      <div
        style={{
          maxWidth: 640,
          margin: "0 auto",
          textAlign: "center",
        }}
      >
        <span className="eyebrow eyebrow-coral" style={{ fontSize: 22 }}>
          dev demo ♡
        </span>
        <h1
          style={{
            fontFamily: "var(--font-patrick-hand), cursive",
            fontSize: 42,
            color: "var(--plum)",
            margin: "8px 0 12px",
            lineHeight: 1.1,
          }}
        >
          Auth modals
        </h1>
        <p
          style={{
            fontFamily: "var(--font-dm-sans), sans-serif",
            fontSize: 14,
            color: "var(--ink-soft)",
            margin: "0 0 36px",
            lineHeight: 1.55,
          }}
        >
          Surface for verifying the <code style={{ fontFamily: "var(--font-dm-sans), monospace", fontSize: 12, background: "var(--cream-2)", padding: "1px 6px", borderRadius: 4 }}>aperture-ubpnl</code>{" "}
          AuthModalShell against the mock tRPC contract. Both modes share 90%
          of the chrome; mode toggles in-place via the footer cross-link.
        </p>

        <div
          style={{
            display: "flex",
            gap: 14,
            justifyContent: "center",
            flexWrap: "wrap",
            marginBottom: 40,
          }}
        >
          <button
            ref={signinBtnRef}
            type="button"
            onClick={() => auth.open("signin", signinBtnRef.current)}
            style={{
              padding: "14px 24px",
              background: "var(--lilac)",
              color: "#fff",
              border: "none",
              borderRadius: 14,
              fontFamily: "var(--font-dm-sans), sans-serif",
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              cursor: "pointer",
              boxShadow: "var(--shadow-cta)",
              transition: "transform .12s ease, background .15s ease",
            }}
          >
            Abrir login
          </button>
          <button
            ref={signupBtnRef}
            type="button"
            onClick={() => auth.open("signup", signupBtnRef.current)}
            style={{
              padding: "14px 24px",
              background: "var(--coral-pink)",
              color: "#fff",
              border: "none",
              borderRadius: 14,
              fontFamily: "var(--font-dm-sans), sans-serif",
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              cursor: "pointer",
              boxShadow: "0 8px 20px rgba(231,143,167,.4)",
              transition: "transform .12s ease, background .15s ease",
            }}
          >
            Abrir cadastro
          </button>
        </div>

        <aside
          style={{
            background: "var(--paper)",
            border: "1px solid var(--line)",
            borderRadius: 18,
            padding: "20px 24px",
            textAlign: "left",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-patrick-hand), cursive",
              fontSize: 19,
              color: "var(--plum)",
              margin: "0 0 12px",
              lineHeight: 1.1,
            }}
          >
            Credenciais mock pra exercitar
          </h2>
          <dl
            style={{
              margin: 0,
              fontFamily: "var(--font-dm-sans), sans-serif",
              fontSize: 13,
              color: "var(--ink)",
              lineHeight: 1.7,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <dt style={{ fontWeight: 600, color: "var(--plum)", minWidth: 130 }}>Login ok →</dt>
              <dd style={{ margin: 0 }}>
                <code style={codeStyle}>{AUTH_DEMO_HINTS.signInEmail}</code>{" "}
                + senha <code style={codeStyle}>{AUTH_DEMO_HINTS.signInPassword}</code>
              </dd>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <dt style={{ fontWeight: 600, color: "var(--plum)", minWidth: 130 }}>Login falha →</dt>
              <dd style={{ margin: 0 }}>
                qualquer outro e-mail + senha (≥ {AUTH_DEMO_HINTS.minPasswordLength} chars)
              </dd>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <dt style={{ fontWeight: 600, color: "var(--plum)", minWidth: 130 }}>Cadastro ok →</dt>
              <dd style={{ margin: 0 }}>
                qualquer e-mail novo + nome + senha (≥ {AUTH_DEMO_HINTS.minPasswordLength} chars)
              </dd>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <dt style={{ fontWeight: 600, color: "var(--plum)", minWidth: 130 }}>Email tomado →</dt>
              <dd style={{ margin: 0 }}>
                <code style={codeStyle}>{AUTH_DEMO_HINTS.takenSignupEmail}</code>
              </dd>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <dt style={{ fontWeight: 600, color: "var(--plum)", minWidth: 130 }}>OAuth →</dt>
              <dd style={{ margin: 0 }}>
                qualquer botão dispara toast{" "}
                <code style={codeStyle}>em breve ♡</code>
              </dd>
            </div>
          </dl>
        </aside>

        <p
          style={{
            marginTop: 28,
            fontFamily: "var(--font-caveat), cursive",
            fontSize: 16,
            color: "var(--ink-soft)",
            lineHeight: 1.3,
          }}
        >
          troca de modo: rodapé "Já tem conta? <strong>Entrar</strong>" / "Ainda não tem conta?{" "}
          <strong>Criar grátis</strong>" — sem remount, mantém o e-mail digitado.
        </p>
      </div>

      {/* Modal mounted by AuthModalProvider at the App.tsx root —
       *  this page no longer renders it directly. */}
    </main>
  );
}

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans), monospace",
  fontSize: 12,
  background: "var(--cream-2)",
  padding: "1px 6px",
  borderRadius: 4,
  color: "var(--plum)",
};
