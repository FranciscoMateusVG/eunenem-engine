import { useEffect, useRef, useState } from "react";

/**
 * Shared presentational primitives for the /admin/catalogo tabs (F1,
 * aperture-ytct2). Kept in one file so PRODUTOS / LISTAS / CATEGORIAS reuse
 * an identical visual language — admin card chrome, mono-uppercase headers,
 * and (critically, per surface-fetch-errors) an ERROR surface that is
 * visually distinct from an EMPTY surface.
 */

/* -----------------------------------------------------------------------
 * The six catalog bgColor tokens. MUST match the server enum exactly
 * (admin-router.ts BG_COLOR_TOKENS @ PR #38) — createProduct/updateProduct
 * reject anything else with BAD_REQUEST.
 * --------------------------------------------------------------------- */
export const BG_COLOR_TOKENS = [
  "var(--blue)",
  "var(--blue-soft)",
  "var(--cream-2)",
  "var(--lilac-soft)",
  "var(--pink-soft)",
  "var(--yellow-soft)",
] as const;
export type BgColorToken = (typeof BG_COLOR_TOKENS)[number];

/** Max upload size — mirrors MAX_CATALOGO_IMAGEM_SIZE_BYTES (5 MiB). */
export const MAX_CATALOGO_IMAGEM_SIZE_BYTES = 5_242_880;

/* -----------------------------------------------------------------------
 * Async-state blocks — loading / error / empty, each a distinct surface.
 * --------------------------------------------------------------------- */

export function LoadingBlock() {
  return (
    <div className="space-y-2 rounded-md border border-line bg-paper p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-cream-2" />
      ))}
    </div>
  );
}

export function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-800">
        erro
      </p>
      <p className="mt-1">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-red-300 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-red-800 transition-colors hover:bg-red-100"
        >
          tentar de novo
        </button>
      )}
    </div>
  );
}

export function EmptyBlock({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-paper px-5 py-10 text-center">
      <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
        {message}
      </p>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Modal shell — mirrors WebhookEventDetailModal chrome. Escape-to-close +
 * backdrop click. Body scrolls; header/footer stay pinned.
 * --------------------------------------------------------------------- */

export function ModalShell({
  title,
  eyebrow,
  onClose,
  children,
  footer,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        tabIndex={-1}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
      />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-line bg-cream-2/40 px-5 py-3">
          <div>
            {eyebrow && (
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
                {eyebrow}
              </p>
            )}
            <h3 className="font-mono text-[13px] uppercase tracking-[0.1em] text-ink">
              {title}
            </h3>
          </div>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="font-mono text-[16px] leading-none text-ink-soft transition-colors hover:text-plum"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-cream-2/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Form field atoms — shared input/select/label tokens (focus:border-plum
 * focus:ring-2 focus:ring-lilac-soft, matching the admin surface).
 * --------------------------------------------------------------------- */

const FIELD_CLS =
  "block w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-mute focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft";

export function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft"
    >
      {children}
    </label>
  );
}

export function TextField({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  maxLength,
  inputMode,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  maxLength?: number;
  inputMode?: "text" | "decimal" | "numeric";
}) {
  return (
    <input
      id={id}
      type="text"
      inputMode={inputMode}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD_CLS} ${invalid ? "border-red-300 focus:border-red-400 focus:ring-red-100" : ""}`}
    />
  );
}

export function SelectField({
  id,
  value,
  onChange,
  invalid,
  children,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD_CLS} ${invalid ? "border-red-300 focus:border-red-400 focus:ring-red-100" : ""}`}
    >
      {children}
    </select>
  );
}

/* -----------------------------------------------------------------------
 * Buttons — primary (plum fill) + ghost (outline), admin tokens.
 * --------------------------------------------------------------------- */

const BTN_BASE =
  "rounded border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed";

export function PrimaryButton({
  children,
  onClick,
  type = "button",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${BTN_BASE} border-plum bg-plum text-paper hover:bg-plum/90 disabled:border-line disabled:bg-paper/50 disabled:text-ink-mute`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? undefined : undefined}
      className={`${BTN_BASE} ${
        danger
          ? "border-line bg-paper text-red-700 hover:border-red-400 hover:text-red-800"
          : "border-line bg-paper text-ink-soft hover:border-plum hover:text-plum"
      } disabled:bg-paper/50 disabled:text-ink-mute disabled:hover:border-line`}
    >
      {children}
    </button>
  );
}

/* -----------------------------------------------------------------------
 * SwatchSelect — the six bgColor tokens as clickable chips.
 * --------------------------------------------------------------------- */

export function SwatchSelect({
  value,
  onChange,
}: {
  value: BgColorToken;
  onChange: (v: BgColorToken) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {BG_COLOR_TOKENS.map((token) => {
        const selected = token === value;
        return (
          <button
            key={token}
            type="button"
            aria-pressed={selected}
            aria-label={token}
            onClick={() => onChange(token)}
            style={{ backgroundColor: token }}
            className={[
              "size-8 rounded-md border transition-all",
              selected
                ? "border-plum ring-2 ring-plum/40 ring-offset-1 ring-offset-paper"
                : "border-line hover:border-ink-soft",
            ].join(" ")}
          />
        );
      })}
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Ativo badge — the active/inactive pill used in all catalog tables.
 * --------------------------------------------------------------------- */

export function AtivoBadge({ ativo }: { ativo: boolean }) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]",
        ativo
          ? "bg-green/15 text-green-deep"
          : "bg-cream-2 text-ink-mute",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={`inline-block size-[6px] rounded-full ${ativo ? "bg-green-deep" : "bg-ink-mute"}`}
      />
      {ativo ? "ativo" : "inativo"}
    </span>
  );
}

/* -----------------------------------------------------------------------
 * useDebouncedValue — debounce a rapidly-changing value (search box).
 * --------------------------------------------------------------------- */

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    timer.current = setTimeout(() => setDebounced(value), delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delayMs]);
  return debounced;
}

/* -----------------------------------------------------------------------
 * parsePriceToCents / centsToPriceInput — BRL text field <-> integer cents.
 * Accepts "29,90" / "29.90" / "1.234,56"; returns null on unparseable.
 * --------------------------------------------------------------------- */

export function parsePriceToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip currency symbols/spaces; normalize BR "1.234,56" and "29,90".
  let s = trimmed.replace(/[R$\s]/g, "");
  if (s.includes(",")) {
    // Comma is the decimal sep → dots are thousands.
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const value = Number(s);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function centsToPriceInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}
