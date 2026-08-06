// aperture-kuw0o (Inter PIX, spec §4.3) — the two shared pieces of the
// PIX-cobrança checkout flow, consumed by GiftCheckoutModal (single gift)
// and CartDrawer (multi-item cart):
//
//   PixIdentityForm — OUR identity capture (nome + email + recadinho).
//     Stripe collected these inside its iframe via custom_fields; Inter's
//     cob API collects nothing, so the data must exist BEFORE initiation
//     (it rides the mutation and is stamped on the intencao at creation).
//     Email is required by the domain's DadosContribuinte — documented
//     deviation from the spec's "nome/mensagem" shorthand.
//
//   PixQrPanel — the QR screen. Renders the BR Code CLIENT-SIDE from
//     pixCopiaECola via the local `qrcode` encoder (Cipher checklist #8:
//     the BR Code embeds the merchant key — it never leaves our origin;
//     no third-party QR service, ever). Copy button, 1Hz countdown to
//     expiraEm, and a poll against pagina.obterStatusPix that flips the
//     panel to confirmado/expirado/rejeitado. The poll READS state — all
//     transitions happen server-side (webhook/poller, D1 seam).
//
// Visual language: the checkout's own — CSS vars + Patrick Hand/Caveat
// warmth + DM Sans labels + btn-lilac. The QR module itself is pure
// black-on-white: scanner reliability beats brand color, always.

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  useObterStatusPix,
  type ContribuinteInput,
  type PixQrData,
} from "@/lib/paginaApi";
import { formatBRL } from "@/lib/formatBRL";

const FONT_SANS = "var(--font-dm-sans), sans-serif";
const FONT_HAND = "var(--font-patrick-hand), cursive";
const FONT_CAVEAT = "var(--font-caveat), cursive";

// ── shared field styling ──────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontFamily: FONT_SANS,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 600,
  fontSize: 11,
  color: "var(--ink-soft)",
  display: "block",
  marginBottom: 6,
  textAlign: "left",
};

function inputStyle(hasError: boolean): React.CSSProperties {
  return {
    width: "100%",
    fontFamily: FONT_HAND,
    fontSize: 18,
    lineHeight: 1.3,
    color: "var(--ink)",
    background: "var(--cream)",
    border: `1px solid ${hasError ? "#c2566f" : "var(--line)"}`,
    borderRadius: 14,
    padding: "11px 14px",
    outline: "none",
    boxSizing: "border-box",
  };
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return (
    <span
      role="alert"
      style={{
        display: "block",
        marginTop: 4,
        fontSize: 12,
        color: "#c2566f",
        fontFamily: FONT_SANS,
        textAlign: "left",
      }}
    >
      {msg}
    </span>
  );
}

// ── identity form ─────────────────────────────────────────────────────────

interface PixIdentityFormProps {
  /** Total the visitor is about to pay — shown so the step feels anchored. */
  valorCents: number;
  submitting: boolean;
  /** Mutation error to surface (initiation failed server-side). */
  submitError: boolean;
  /** Pre-fill (e.g. retry after an expired QR — don't make them re-type). */
  initial?: ContribuinteInput | null;
  onSubmit: (contribuinte: ContribuinteInput) => void;
  onBack: () => void;
}

interface IdentityErrors {
  nome?: string;
  email?: string;
}

export function PixIdentityForm({
  valorCents,
  submitting,
  submitError,
  initial,
  onSubmit,
  onBack,
}: PixIdentityFormProps) {
  const [nome, setNome] = useState(initial?.nome ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [mensagem, setMensagem] = useState(initial?.mensagem ?? "");
  const [showErrors, setShowErrors] = useState(false);

  const errors: IdentityErrors = {};
  if (!nome.trim()) errors.nome = "conta pra gente quem você é ♡";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    errors.email = "precisamos de um email válido ♡";
  }
  const visibleErrors: IdentityErrors = showErrors ? errors : {};

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    const trimmedMensagem = mensagem.trim();
    onSubmit({
      nome: nome.trim(),
      email: email.trim(),
      ...(trimmedMensagem ? { mensagem: trimmedMensagem } : {}),
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate style={{ textAlign: "center" }}>
      <span className="eyebrow eyebrow-coral" style={{ fontSize: 16 }}>
        quase lá ♡
      </span>
      <h3
        id="gift-checkout-title"
        style={{
          fontFamily: FONT_HAND,
          fontSize: 30,
          color: "var(--plum)",
          margin: "6px 0 4px",
          fontWeight: 400,
        }}
      >
        de quem vem esse carinho?
      </h3>
      <p
        style={{
          fontFamily: FONT_SANS,
          fontSize: 14,
          color: "var(--ink-soft)",
          margin: "0 0 20px",
        }}
      >
        no pix o recadinho fica com a gente — preenche aqui antes de pagar{" "}
        {formatBRL(valorCents)}.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label>
          <span style={labelStyle}>seu nome</span>
          <input
            type="text"
            value={nome}
            maxLength={120}
            placeholder="Ana & João"
            aria-invalid={visibleErrors.nome ? true : undefined}
            style={inputStyle(Boolean(visibleErrors.nome))}
            onChange={(e) => setNome(e.target.value)}
          />
          <FieldError msg={visibleErrors.nome} />
        </label>

        <label>
          <span style={labelStyle}>seu email</span>
          <input
            type="email"
            value={email}
            maxLength={320}
            placeholder="ana@email.com"
            aria-invalid={visibleErrors.email ? true : undefined}
            style={inputStyle(Boolean(visibleErrors.email))}
            onChange={(e) => setEmail(e.target.value)}
          />
          <FieldError msg={visibleErrors.email} />
        </label>

        <label>
          <span style={labelStyle}>recadinho (opcional)</span>
          <textarea
            value={mensagem}
            maxLength={255}
            placeholder="a gente já te ama tanto ♡"
            style={{
              ...inputStyle(false),
              fontFamily: FONT_CAVEAT,
              fontSize: 20,
              minHeight: 84,
              resize: "vertical",
            }}
            onChange={(e) => setMensagem(e.target.value)}
          />
        </label>
      </div>

      {submitError && (
        <p
          role="alert"
          style={{
            fontFamily: FONT_SANS,
            fontSize: 13,
            color: "#c2566f",
            margin: "14px 0 0",
          }}
        >
          não conseguimos iniciar o pix agora — tenta de novo?
        </p>
      )}

      <button
        type="submit"
        className="btn-lilac"
        disabled={submitting}
        style={{ width: "100%", marginTop: 20, opacity: submitting ? 0.7 : 1 }}
      >
        {submitting ? "gerando o pix…" : "continuar para o pix ♡"}
      </button>
      <button
        type="button"
        onClick={onBack}
        disabled={submitting}
        style={{
          background: "transparent",
          border: "none",
          fontFamily: FONT_SANS,
          fontSize: 13,
          color: "var(--ink-mute)",
          textDecoration: "underline",
          cursor: "pointer",
          marginTop: 12,
        }}
      >
        voltar
      </button>
    </form>
  );
}

// ── QR panel ──────────────────────────────────────────────────────────────

interface PixQrPanelProps {
  slug: string;
  pix: PixQrData;
  valorCents: number;
  /** Fired ONCE when the poll reports 'confirmado'. */
  onConfirmed: () => void;
  /** Charge expired or rejected — caller sends the visitor back to retry. */
  onRetry: () => void;
}

function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function PixQrPanel({
  slug,
  pix,
  valorCents,
  onConfirmed,
  onRetry,
}: PixQrPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [msLeft, setMsLeft] = useState<number>(() =>
    Math.max(0, new Date(pix.expiraEm).getTime() - Date.now()),
  );
  const confirmedFiredRef = useRef(false);

  // Client-side BR Code render — local encoder, nothing leaves the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    void QRCode.toCanvas(canvas, pix.pixCopiaECola, {
      width: 216,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#1f1218", light: "#ffffff" },
    });
  }, [pix.pixCopiaECola]);

  // 1Hz countdown to expiraEm (no ticker exists in the codebase since
  // aperture-xijyq removed the day-countdown's interval — this one is
  // deliberately local to the panel and unmount-safe).
  useEffect(() => {
    const t = setInterval(() => {
      setMsLeft(Math.max(0, new Date(pix.expiraEm).getTime() - Date.now()));
    }, 1000);
    return () => clearInterval(t);
  }, [pix.expiraEm]);

  const countdownExpired = msLeft <= 0;

  // Poll stays enabled even past the local countdown — a payment that
  // lands at the buzzer must still flip to confirmado (the server's
  // consult is authoritative; refetchInterval stops on terminal states).
  const statusQuery = useObterStatusPix(slug, pix.txid);
  const polledStatus = statusQuery.data?.status ?? "pendente";

  // The server's word beats the local clock: only treat the charge as
  // expired when the countdown ran out AND the poll hasn't confirmed.
  const isConfirmed = polledStatus === "confirmado";
  const isRejected = polledStatus === "rejeitado";
  const isExpired = !isConfirmed && (polledStatus === "expirado" || countdownExpired);

  useEffect(() => {
    if (isConfirmed && !confirmedFiredRef.current) {
      confirmedFiredRef.current = true;
      onConfirmed();
    }
  }, [isConfirmed, onConfirmed]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(pix.pixCopiaECola);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (older browsers / permissions) — select-fallback.
      const ta = document.createElement("textarea");
      ta.value = pix.pixCopiaECola;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [pix.pixCopiaECola]);

  if (isExpired || isRejected) {
    return (
      <div style={{ textAlign: "center" }} aria-live="polite">
        <span className="eyebrow" style={{ fontSize: 16 }}>
          {isRejected ? "pagamento não aprovado" : "o pix expirou"}
        </span>
        <h3
          id="gift-checkout-title"
          style={{
            fontFamily: FONT_HAND,
            fontSize: 30,
            color: "var(--plum)",
            margin: "6px 0 8px",
            fontWeight: 400,
          }}
        >
          {isRejected ? "esse pix não passou ♡" : "esse QR já dormiu ♡"}
        </h3>
        <p
          style={{
            fontFamily: FONT_SANS,
            fontSize: 14,
            color: "var(--ink-soft)",
            margin: "0 0 20px",
          }}
        >
          {isRejected
            ? "nada foi cobrado — dá pra tentar de novo quando quiser."
            : "o código pix vale 10 minutinhos. gera outro que a gente te espera."}
        </p>
        <button type="button" className="btn-lilac" onClick={onRetry} style={{ width: "100%" }}>
          gerar um novo pix
        </button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: "center" }} aria-live="polite">
      <span className="eyebrow eyebrow-coral" style={{ fontSize: 16 }}>
        falta só escanear ♡
      </span>
      <h3
        id="gift-checkout-title"
        style={{
          fontFamily: FONT_HAND,
          fontSize: 30,
          color: "var(--plum)",
          margin: "6px 0 4px",
          fontWeight: 400,
        }}
      >
        paga com pix — {formatBRL(valorCents)}
      </h3>
      <p
        style={{
          fontFamily: FONT_SANS,
          fontSize: 13.5,
          color: "var(--ink-soft)",
          margin: "0 0 16px",
        }}
      >
        abre o app do seu banco, escaneia o código (ou copia e cola) e pronto —
        a confirmação aparece aqui sozinha.
      </p>

      {/* QR card — pure black-on-white module for scanner reliability. */}
      <div
        style={{
          display: "inline-block",
          background: "#ffffff",
          border: "1px solid var(--line)",
          borderRadius: 18,
          padding: 10,
          boxShadow: "var(--shadow-sm)",
          lineHeight: 0,
        }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="QR code do pagamento pix"
          style={{ borderRadius: 10 }}
        />
      </div>

      <div
        style={{
          fontFamily: FONT_SANS,
          fontSize: 12.5,
          color: "var(--ink-mute)",
          marginTop: 10,
        }}
      >
        expira em{" "}
        <strong
          style={{
            fontVariantNumeric: "tabular-nums",
            color: msLeft < 60_000 ? "#c2566f" : "var(--ink-soft)",
          }}
        >
          {formatCountdown(msLeft)}
        </strong>
      </div>

      {/* copia-e-cola */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "stretch",
          marginTop: 14,
        }}
      >
        <input
          type="text"
          readOnly
          value={pix.pixCopiaECola}
          aria-label="código pix copia e cola"
          onFocus={(e) => e.currentTarget.select()}
          style={{
            ...inputStyle(false),
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            color: "var(--ink-soft)",
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        />
        <button
          type="button"
          onClick={handleCopy}
          className="btn-lilac"
          style={{ whiteSpace: "nowrap", padding: "0 16px" }}
        >
          {copied ? "copiado ♡" : "copiar"}
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          marginTop: 18,
          fontFamily: FONT_SANS,
          fontSize: 13,
          color: "var(--ink-soft)",
        }}
      >
        <PulseDot />
        aguardando o pagamento…
      </div>
    </div>
  );
}

/** Soft awaiting-pulse — honors prefers-reduced-motion (falls to static). */
function PulseDot() {
  return (
    <>
      <style>{`
        @keyframes pix-pulse {
          0%, 100% { opacity: 0.35; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1); }
        }
        .pix-pulse-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--lilac-deep);
          animation: pix-pulse 1.6s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .pix-pulse-dot { animation: none; opacity: 0.8; }
        }
      `}</style>
      <span className="pix-pulse-dot" aria-hidden="true" />
    </>
  );
}
