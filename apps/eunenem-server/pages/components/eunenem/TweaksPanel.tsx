
import { useState } from "react";
import {
  ACCENT_SWATCHES,
  PRIMARY_PRESETS,
  PRIMARY_SWATCHES,
} from "@/lib/mocks/tweaksDefaults";
import { useTweaks } from "./TweaksContext";

// aperture-3d9t — TweaksPanel (floating bottom-right).
//
// Live customisation of baby name + parents + due date + primary +
// accent. State lives in TweaksContext; colour swatches mirror
// PRIMARY_PRESETS so deep+soft variants follow the chosen primary
// as a coherent triad.
//
// Collapsed state: small "Personalizar" pill button.
// Expanded state: card with two sections — Evento + Paleta.
//
// In-memory only. No persistence. Reload resets.

export function TweaksPanel() {
  const { tweaks, setTweak, setTweaks } = useTweaks();
  const [open, setOpen] = useState(false);

  const onPickPrimary = (primary: string) => {
    const preset = PRIMARY_PRESETS[primary];
    if (!preset) return;
    setTweaks({
      primary,
      primaryDeep: preset.deep,
      primarySoft: preset.soft,
    });
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 12,
      }}
    >
      {open && (
        <div
          role="dialog"
          aria-label="Personalizar página"
          style={{
            background: "var(--paper)",
            border: "1px solid var(--line)",
            borderRadius: 20,
            padding: 22,
            width: 320,
            boxShadow: "var(--shadow-lg)",
            maxHeight: "70vh",
            overflowY: "auto",
          }}
        >
          <header className="flex items-center justify-between mb-4">
            <span
              className="eyebrow eyebrow-coral"
              style={{ fontSize: 24 }}
            >
              tweaks
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Fechar painel de tweaks"
              style={{
                background: "var(--cream-2)",
                border: "none",
                width: 28,
                height: 28,
                borderRadius: "50%",
                color: "var(--ink-soft)",
                fontSize: 16,
                cursor: "pointer",
                lineHeight: 1,
                fontWeight: 700,
              }}
            >
              ×
            </button>
          </header>

          <TweakSection title="Evento">
            <TweakText
              label="Nome do bebê"
              value={tweaks.babyName}
              onChange={(v) => setTweak("babyName", v)}
            />
            <TweakText
              label="Papais"
              value={tweaks.parents}
              onChange={(v) => setTweak("parents", v)}
            />
            <TweakText
              label="Data prevista (AAAA-MM-DD)"
              value={tweaks.targetDate}
              onChange={(v) => setTweak("targetDate", v)}
              pattern="^\d{4}-\d{2}-\d{2}$"
            />
          </TweakSection>

          <TweakSection title="Paleta">
            <TweakColor
              label="Primária"
              value={tweaks.primary}
              options={PRIMARY_SWATCHES}
              onChange={onPickPrimary}
            />
            <TweakColor
              label="Acento"
              value={tweaks.accent}
              options={ACCENT_SWATCHES}
              onChange={(v) => setTweak("accent", v)}
            />
          </TweakSection>

          <p
            style={{
              fontSize: 11,
              color: "var(--ink-mute)",
              marginTop: 12,
              textAlign: "center",
            }}
          >
            Pré-visualização — não persiste.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="tweaks-panel"
        className="btn-lilac"
        style={{ padding: "10px 16px", fontSize: 12 }}
      >
        {open ? "Fechar" : "Personalizar"}
      </button>
    </div>
  );
}

function TweakSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--ink-mute)",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function TweakText({
  label,
  value,
  onChange,
  pattern,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  pattern?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: "var(--ink-soft)",
        fontWeight: 600,
      }}
    >
      {label}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        pattern={pattern}
        style={{
          padding: "8px 12px",
          borderRadius: 10,
          border: "1px solid var(--line)",
          fontSize: 14,
          color: "var(--ink)",
          background: "var(--cream)",
          fontFamily: "inherit",
          outline: "none",
        }}
      />
    </label>
  );
}

function TweakColor({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "var(--ink-soft)",
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div className="flex gap-2">
        {options.map((c) => {
          const active = c === value;
          return (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              aria-label={`${label}: ${c}${active ? " (selecionado)" : ""}`}
              aria-pressed={active}
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: c,
                border: active
                  ? "2.5px solid var(--ink)"
                  : "2.5px solid var(--paper)",
                boxShadow: "var(--shadow-sm)",
                cursor: "pointer",
                padding: 0,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
