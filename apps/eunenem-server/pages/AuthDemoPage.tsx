import { useRef } from "react";

import { useAuthModal } from "./components/eunenem/auth/AuthModalProvider.js";
import { MIN_PASSWORD_LENGTH, useMe, useSignOut } from "./lib/auth.js";

// aperture-ubpnl + aperture-d0x1w — Dev demo surface for the auth modals.
//
// The bead is explicit that WHERE the trigger lives in production app chrome
// is out of scope. This page is the verification surface: 2 trigger buttons
// (signin + signup), plus a "current session" card so an operator (or QA)
// can exercise the success + error paths end-to-end against the real
// backend.
//
// aperture-d0x1w: removed the mock-creds hint card (mock contract is gone —
// every signup creates a real user row in Postgres). Added a live session
// card that reads `auth.me` so you can see the cookie round-trip without
// shelling into psql for each verify.
//
// Routed at /auth-demo via App.tsx::resolveRoute. The route is unlisted in
// any nav — it's reachable only by typing the URL, which is the right
// scope for a v1 dev surface.

export function AuthDemoPage() {
  const auth = useAuthModal();
  const signinBtnRef = useRef<HTMLButtonElement | null>(null);
  const signupBtnRef = useRef<HTMLButtonElement | null>(null);

  const me = useMe();
  const { signOut, isPending: isSigningOut } = useSignOut();

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
          Surface for verifying the{" "}
          <code style={inlineCode}>aperture-ubpnl</code> AuthModalShell against
          the real tRPC contract (
          <code style={inlineCode}>aperture-d0x1w</code> swap from mock →{" "}
          <code style={inlineCode}>auth.signUp / signIn / signOut / me</code>).
          Both modes share 90% of the chrome; mode toggles in-place via the
          footer cross-link.
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
            Sessão atual
          </h2>
          {me.isLoading ? (
            <p style={{ ...textBody, color: "var(--ink-mute)" }}>
              Verificando sessão…
            </p>
          ) : me.data ? (
            <>
              <dl
                style={{
                  margin: 0,
                  fontFamily: "var(--font-dm-sans), sans-serif",
                  fontSize: 13,
                  color: "var(--ink)",
                  lineHeight: 1.7,
                }}
              >
                <Row label="Nome">
                  <code style={codeStyle}>{me.data.nomeExibicao}</code>
                </Row>
                <Row label="E-mail">
                  <code style={codeStyle}>{me.data.email}</code>
                </Row>
                <Row label="idUsuario">
                  <code style={codeStyle}>{me.data.idUsuario}</code>
                </Row>
                <Row label="idConta">
                  <code style={codeStyle}>{me.data.idConta}</code>
                </Row>
                <Row label="Plataforma">
                  <code style={codeStyle}>{me.data.idPlataforma}</code>
                </Row>
                <Row label="Sessão expira">
                  <code style={codeStyle}>
                    {new Date(me.data.expiraEm).toLocaleString("pt-BR")}
                  </code>
                </Row>
              </dl>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={isSigningOut}
                style={{
                  marginTop: 16,
                  padding: "10px 18px",
                  background: "transparent",
                  color: "var(--plum)",
                  border: "1.5px solid var(--lilac-deep)",
                  borderRadius: 10,
                  fontFamily: "var(--font-dm-sans), sans-serif",
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  cursor: isSigningOut ? "not-allowed" : "pointer",
                  opacity: isSigningOut ? 0.6 : 1,
                  transition: "background .15s ease, color .15s ease",
                }}
              >
                {isSigningOut ? "Saindo…" : "Sair"}
              </button>
            </>
          ) : (
            <>
              <p style={textBody}>
                Sem sessão ativa. Use{" "}
                <strong style={{ color: "var(--plum)" }}>Abrir cadastro</strong>{" "}
                pra criar uma conta real (a linha aparece em{" "}
                <code style={codeStyle}>users</code> no Postgres) ou{" "}
                <strong style={{ color: "var(--plum)" }}>Abrir login</strong>{" "}
                pra entrar com uma conta existente.
              </p>
              <p
                style={{
                  ...textBody,
                  marginTop: 12,
                  fontSize: 12,
                  color: "var(--ink-mute)",
                }}
              >
                Senhas precisam de no mínimo <strong>{MIN_PASSWORD_LENGTH}</strong>{" "}
                caracteres. OAuth (Google / Apple / Microsoft) ainda é stub —
                clicar dispara toast <code style={codeStyle}>em breve ♡</code>.
              </p>
            </>
          )}
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
          troca de modo: rodapé "Já tem conta? <strong>Entrar</strong>" / "Ainda
          não tem conta? <strong>Criar grátis</strong>" — sem remount, mantém o
          e-mail digitado.
        </p>
      </div>

      {/* Modal mounted by AuthModalProvider at the App.tsx root —
       *  this page no longer renders it directly. */}
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <dt style={{ fontWeight: 600, color: "var(--plum)", minWidth: 130 }}>
        {label} →
      </dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
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

const inlineCode: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans), monospace",
  fontSize: 12,
  background: "var(--cream-2)",
  padding: "1px 6px",
  borderRadius: 4,
};

const textBody: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-dm-sans), sans-serif",
  fontSize: 13,
  color: "var(--ink)",
  lineHeight: 1.55,
};
