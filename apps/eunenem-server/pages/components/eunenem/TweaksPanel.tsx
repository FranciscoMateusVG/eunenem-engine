
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ACCENT_SWATCHES,
  PRIMARY_PRESETS,
  PRIMARY_SWATCHES,
} from "@/lib/mocks/tweaksDefaults";
import type { TweaksState } from "@/lib/mocks/tweaksDefaults";
import { trpc } from "@/lib/trpc";
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
// Live-preview is in-memory only (TweaksContext). "Salvar" persists
// babyName/parents/targetDate/primary/accent to perfil_campanhas via
// perfilCampanha.atualizar — a whole-content-replacement upsert, so the
// current profile is fetched first and merged, mirroring PerfilBody.tsx's
// campanhaPayload()/salvarCampanha() pattern.

function formatBR(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function TweaksPanel({
  idCampanha,
  canSave = false,
}: {
  idCampanha?: string;
  /**
   * Whether the "Salvar" affordance should render at all. The
   * perfilCampanha.atualizar mutation is ALWAYS server-side owner-gated
   * (resolverCampanhaAdministrada) regardless of this flag — this only
   * controls the UX. Callers decide it from context they already have:
   * PainelLayout is an authed-only route (always true); PaginaPage is
   * PUBLIC, so it passes the `isOwner` bit from getPerfilPublicoBySlug (true
   * only when the visitor is logged in AND administers this campanha).
   */
  canSave?: boolean;
}) {
  const { tweaks, setTweak, setTweaks } = useTweaks();
  const [open, setOpen] = useState(false);

  const utils = trpc.useUtils();
  const showSave = canSave && Boolean(idCampanha);
  const perfilQuery = trpc.perfilCampanha.get.useQuery(
    idCampanha ? { idCampanha } : (undefined as never),
    { enabled: showSave, staleTime: 60_000 },
  );
  const atualizar = trpc.perfilCampanha.atualizar.useMutation();

  // Hydrate the persisted fields once the profile loads — the live-preview
  // fields TweaksState already seeds from other props (babyName/genero/
  // targetDate) may be overwritten here with the saved parents/colors, which
  // have no other seeding path.
  useEffect(() => {
    const perfil = perfilQuery.data;
    if (!perfil) return;
    const patch: Partial<TweaksState> = {};
    if (perfil.papais) patch.parents = perfil.papais;
    if (perfil.corPrimaria) patch.primary = perfil.corPrimaria;
    if (perfil.corAcento) patch.accent = perfil.corAcento;
    const preset = perfil.corPrimaria ? PRIMARY_PRESETS[perfil.corPrimaria] : undefined;
    if (preset) {
      patch.primaryDeep = preset.deep;
      patch.primarySoft = preset.soft;
    }
    if (Object.keys(patch).length > 0) setTweaks(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfilQuery.data]);

  const onPickPrimary = (primary: string) => {
    const preset = PRIMARY_PRESETS[primary];
    if (!preset) return;
    setTweaks({
      primary,
      primaryDeep: preset.deep,
      primarySoft: preset.soft,
    });
  };

  const salvando = atualizar.isPending;

  const onSave = async () => {
    if (!showSave || !idCampanha) return;
    try {
      const atual = perfilQuery.data ?? (await utils.perfilCampanha.get.fetch({ idCampanha }));
      await atualizar.mutateAsync({
        idCampanha,
        relacao: atual.relacao,
        historia: atual.historia,
        dataNascimento: atual.dataNascimento ? new Date(atual.dataNascimento) : null,
        tipoEvento: atual.tipoEvento,
        genero: atual.genero,
        fotoPerfilKey: atual.fotoPerfilKey,
        fotoCapaKey: atual.fotoCapaKey,
        fotoHistoriaKey: atual.fotoHistoriaKey,
        // Fields TweaksPanel actually edits:
        nomeBebe: tweaks.babyName.trim() || null,
        papais: tweaks.parents.trim() || null,
        dataEvento: tweaks.targetDate ? new Date(tweaks.targetDate) : null,
        corPrimaria: tweaks.primary || null,
        corAcento: tweaks.accent || null,
      });
      void utils.perfilCampanha.get.invalidate({ idCampanha });
      toast.success("Personalização salva ♡");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "não consegui salvar — tenta de novo?");
    }
  };

  // The whole affordance (the "Personalizar" toggle + panel) only exists for
  // whoever can actually save it — a logged-out visitor or a non-admin
  // shouldn't even see the entry point, not just have the Save button
  // hidden inside it.
  if (!showSave) return null;

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
            <TweakDate
              label="Data prevista"
              value={tweaks.targetDate}
              onChange={(v) => setTweak("targetDate", v)}
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

          {showSave && (
            <button
              type="button"
              onClick={onSave}
              disabled={salvando}
              className="btn-lilac"
              style={{
                width: "100%",
                padding: "10px 16px",
                fontSize: 13,
                marginTop: 4,
                opacity: salvando ? 0.6 : 1,
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                textAlign: "center",
              }}
            >
              {salvando ? "Salvando..." : "Salvar"}
            </button>
          )}
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

// aperture — targetDate is already ISO YYYY-MM-DD in TweaksState (unlike
// PerfilBody's dd/mm/aaaa fields), so this only needs a display formatter,
// not the brToISO/isoToBR round-trip PerfilDateField carries. The native
// <input type="date"> is visually hidden and opened via showPicker() from
// the calendar button — same trick as PerfilDateField in PerfilBody.tsx.
function TweakDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const dateRef = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    const el = dateRef.current as
      | (HTMLInputElement & { showPicker?: () => void })
      | null;
    if (!el) return;
    try {
      el.showPicker?.();
    } catch {
      // Older browsers without showPicker(): clicking still focuses it.
    }
  };
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
      <span style={{ position: "relative", display: "flex" }}>
        <input
          type="text"
          value={value ? formatBR(value) : ""}
          readOnly
          placeholder="dd/mm/aaaa"
          onClick={openPicker}
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid var(--line)",
            fontSize: 14,
            color: "var(--ink)",
            background: "var(--cream)",
            fontFamily: "inherit",
            outline: "none",
            cursor: "pointer",
          }}
        />
        <button
          type="button"
          onClick={openPicker}
          aria-label="Abrir calendário"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--ink-soft)",
            cursor: "pointer",
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            width={18}
            height={18}
            aria-hidden="true"
          >
            <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
            <path d="M3.5 10h17M8 3v4M16 3v4" />
          </svg>
        </button>
        <input
          ref={dateRef}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
      </span>
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
