
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ACCENT_SWATCHES,
  PRIMARY_SWATCHES,
} from "@/lib/mocks/tweaksDefaults";
import type { TweaksState } from "@/lib/mocks/tweaksDefaults";
import {
  EDIT_FIELDS,
  type EditableDraft,
  HISTORIA_MAX,
  SECTION_TITLES,
  changedKeys,
  draftValidationError,
  mergeDraftIntoStored,
} from "@/lib/inline-edit";
import {
  contrastWarnings,
  isPresetPrimary,
  normalizeHex,
  triadFor,
} from "@/lib/palette";
import { trpc } from "@/lib/trpc";
import {
  type FotoContentType,
  type FotoSlot,
  PhotoSlot,
} from "./PhotoSlot";
import { useTweaks } from "./TweaksContext";

// aperture-3d9t — TweaksPanel (floating bottom-right).
//
// aperture-whxzg — the OWNER INLINE EDITOR for the public gift page. Was
// palette-only since aperture-ohum1 (event identity lived only in the painel
// Perfil form); the operator now wants the owner to edit the page IN PLACE,
// so this panel carries the supported public-page fields again — but as the
// owner's editor (only mounts when getPerfilPublicoBySlug.isOwner), not a
// guest-view theming toy. The contextual icons on Hero/Story call
// openEditor(field) and this panel scrolls + focuses the matching input.
//
// Sections: Título (nome do bebê) · História (texto + assinatura) · Fotos
// (capa / bebê / história — persisted ON UPLOAD, disclosed before the picker)
// · Paleta (preset swatches + native colour picker + hex input for primária
// and acento; informational contrast warning, never a block/rewrite).
//
// One store: TweaksContext. Edits preview instantly; Salvar persists the
// text/colour draft via perfilCampanha.atualizar (whole-content replacement:
// the stored profile is fetched and ONLY changed keys override it — see
// mergeDraftIntoStored); Cancelar restores the saved baseline. Closing (×)
// keeps the draft on the page and the pill shows an unsaved dot.
//
// Backend contract untouched: corPrimaria/corAcento already accept any
// #rrggbb; photos reuse perfilCampanha.emitirUrlUploadFoto → PUT →
// atualizar (orphan safeguard, same as PerfilBody) and the persist payload
// echoes the STORED text/colours, never the unsaved draft.

const BABY_FALLBACK = "bebê";

export function TweaksPanel({
  idCampanha,
  canSave = false,
  creatorName = "",
}: {
  idCampanha?: string;
  /**
   * Whether the editor should render at all. The perfilCampanha.atualizar
   * mutation is ALWAYS server-side owner-gated (resolverCampanhaAdministrada)
   * regardless of this flag — this only controls the UX. Callers decide it
   * from context they already have: PaginaPage is PUBLIC, so it passes the
   * `isOwner` bit from getPerfilPublicoBySlug (true only when the visitor is
   * logged in AND administers this campanha).
   */
  canSave?: boolean;
  /**
   * aperture-whxzg — the creator's display name: the Story signature falls
   * back to it when `papais` is null (PaginaPage seeds parents that way), so
   * an emptied assinatura input previews exactly what a reload will show.
   */
  creatorName?: string;
}) {
  const {
    tweaks,
    setTweaks,
    baseline,
    dirty,
    markSaved,
    resetToBaseline,
    editor,
    openEditor,
    closeEditor,
    clearFocusRequest,
  } = useTweaks();
  const open = editor.open;

  const utils = trpc.useUtils();
  const showSave = canSave && Boolean(idCampanha);
  const perfilQuery = trpc.perfilCampanha.get.useQuery(
    idCampanha ? { idCampanha } : (undefined as never),
    { enabled: showSave, staleTime: 60_000 },
  );
  const atualizar = trpc.perfilCampanha.atualizar.useMutation();
  const emitirUpload = trpc.perfilCampanha.emitirUrlUploadFoto.useMutation();

  // Raw input text for the two fields with a display fallback (nome do bebê →
  // "bebê", assinatura → creatorName). The INPUT shows what the owner typed;
  // the PAGE previews the fallback the moment the input is emptied — same
  // thing a reload would render.
  const [nomeInput, setNomeInput] = useState(() =>
    tweaks.babyName === BABY_FALLBACK ? "" : tweaks.babyName,
  );
  const [papaisInput, setPapaisInput] = useState("");
  // Hex text inputs — may hold an in-progress/invalid value; only a
  // normalized hex ever reaches the store/CSS.
  const [primaryHex, setPrimaryHex] = useState(tweaks.primary);
  const [accentHex, setAccentHex] = useState(tweaks.accent);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hydrated = useRef(false);

  // Hydrate the persisted fields once the OWNER profile loads (the public
  // projection already seeded name/palette; this adds papais/historia/photo
  // urls and re-baselines so dirty === "differs from what is stored").
  useEffect(() => {
    const perfil = perfilQuery.data;
    if (!perfil || hydrated.current) return;
    hydrated.current = true;
    const patch: Partial<TweaksState> = {};
    if (perfil.nomeBebe) patch.babyName = perfil.nomeBebe;
    patch.parents = perfil.papais ?? creatorName;
    patch.historia = perfil.historia ?? "";
    patch.fotoCapaUrl = perfil.fotoCapaUrl;
    patch.fotoPerfilUrl = perfil.fotoPerfilUrl;
    patch.fotoHistoriaUrl = perfil.fotoHistoriaUrl;
    const primary = normalizeHex(perfil.corPrimaria);
    if (primary) Object.assign(patch, triadFor(primary));
    const accent = normalizeHex(perfil.corAcento);
    if (accent) patch.accent = accent;
    markSaved(patch);
    setNomeInput(perfil.nomeBebe ?? "");
    setPapaisInput(perfil.papais ?? "");
    setPrimaryHex(primary ?? tweaks.primary);
    setAccentHex(accent ?? tweaks.accent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfilQuery.data]);

  // Focus the requested field once the panel is open (icons → openEditor).
  useEffect(() => {
    if (!open || !editor.focusField) return;
    const spec = EDIT_FIELDS[editor.focusField];
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(spec.inputId);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        (el as HTMLElement).focus({ preventScroll: true });
      }
      clearFocusRequest();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, editor.focusField, editor.focusNonce, clearFocusRequest]);

  // Unsaved text/colour edits → warn on navigation away.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Escape closes (keeps the draft, like ×).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEditor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeEditor]);

  const onPickPrimary = (hex: string) => {
    const n = normalizeHex(hex);
    if (!n) return;
    setTweaks(triadFor(n));
    setPrimaryHex(n);
  };
  const onPickAccent = (hex: string) => {
    const n = normalizeHex(hex);
    if (!n) return;
    setTweaks({ accent: n });
    setAccentHex(n);
  };
  const onPrimaryHexText = (raw: string) => {
    setPrimaryHex(raw);
    const n = normalizeHex(raw);
    if (n) setTweaks(triadFor(n));
  };
  const onAccentHexText = (raw: string) => {
    setAccentHex(raw);
    const n = normalizeHex(raw);
    if (n) setTweaks({ accent: n });
  };

  const currentDraft = (): EditableDraft => ({
    babyName: tweaks.babyName,
    parents: tweaks.parents,
    historia: tweaks.historia ?? "",
    primary: tweaks.primary,
    accent: tweaks.accent,
  });

  const salvando = atualizar.isPending;

  const onCancel = () => {
    resetToBaseline();
    setNomeInput(baseline.babyName === BABY_FALLBACK ? "" : baseline.babyName);
    setPapaisInput(baseline.parents === creatorName ? "" : baseline.parents);
    setPrimaryHex(baseline.primary);
    setAccentHex(baseline.accent);
    setSaveError(null);
  };

  const onSave = async () => {
    if (!showSave || !idCampanha) return;
    const draft = currentDraft();
    const invalid = draftValidationError(draft);
    if (invalid) {
      setSaveError(invalid);
      return;
    }
    setSaveError(null);
    try {
      const atual = perfilQuery.data ?? (await utils.perfilCampanha.get.fetch({ idCampanha }));
      const changed = new Set(changedKeys(draft, baseline));
      const merged = mergeDraftIntoStored(atual, draft, baseline);
      const fresh = await atualizar.mutateAsync({
        idCampanha,
        // Whole-content-replacement contract: everything not edited here is
        // echoed VERBATIM from the stored profile (mergeDraftIntoStored).
        nomeBebe: changed.has("babyName") ? nomeInput.trim() || null : atual.nomeBebe,
        papais: changed.has("parents") ? papaisInput.trim() || null : atual.papais,
        relacao: atual.relacao,
        historia: merged.historia,
        dataNascimento: atual.dataNascimento ? new Date(atual.dataNascimento) : null,
        dataEvento: atual.dataEvento ? new Date(atual.dataEvento) : null,
        tipoEvento: atual.tipoEvento,
        genero: atual.genero,
        fotoPerfilKey: atual.fotoPerfilKey,
        fotoCapaKey: atual.fotoCapaKey,
        fotoHistoriaKey: atual.fotoHistoriaKey,
        corPrimaria: merged.corPrimaria,
        corAcento: merged.corAcento,
      });
      utils.perfilCampanha.get.setData({ idCampanha }, fresh);
      const primary = normalizeHex(fresh.corPrimaria);
      const accent = normalizeHex(fresh.corAcento);
      markSaved({
        babyName: fresh.nomeBebe ?? BABY_FALLBACK,
        parents: fresh.papais ?? creatorName,
        historia: fresh.historia ?? "",
        ...(primary ? triadFor(primary) : {}),
        ...(accent ? { accent } : {}),
      });
      setNomeInput(fresh.nomeBebe ?? "");
      setPapaisInput(fresh.papais ?? "");
      toast.success("Personalização salva ♡");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "não consegui salvar — tenta de novo?";
      setSaveError(msg);
      toast.error(msg);
    }
  };

  // Photo: presign → PUT → persist the key with the STORED text/colours
  // echoed (never the unsaved draft) → preview the fresh URL. Throws so
  // PhotoSlot shows the inline error; on failure nothing changes.
  const uploadFoto = async (slot: FotoSlot, blob: Blob, contentType: FotoContentType) => {
    if (!idCampanha) throw new Error("sem campanha");
    const { uploadUrl, objectKey } = await emitirUpload.mutateAsync({
      idCampanha,
      slot,
      contentType,
    });
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: blob,
    });
    if (!res.ok) throw new Error(`upload falhou (${res.status})`);
    const atual = await utils.perfilCampanha.get.fetch({ idCampanha });
    const fresh = await atualizar.mutateAsync({
      idCampanha,
      nomeBebe: atual.nomeBebe,
      papais: atual.papais,
      relacao: atual.relacao,
      historia: atual.historia,
      dataNascimento: atual.dataNascimento ? new Date(atual.dataNascimento) : null,
      dataEvento: atual.dataEvento ? new Date(atual.dataEvento) : null,
      tipoEvento: atual.tipoEvento,
      genero: atual.genero,
      fotoPerfilKey: slot === "perfil" ? objectKey : atual.fotoPerfilKey,
      fotoCapaKey: slot === "capa" ? objectKey : atual.fotoCapaKey,
      fotoHistoriaKey: slot === "historia" ? objectKey : atual.fotoHistoriaKey,
      corPrimaria: atual.corPrimaria,
      corAcento: atual.corAcento,
    });
    utils.perfilCampanha.get.setData({ idCampanha }, fresh);
    setTweaks({
      fotoCapaUrl: fresh.fotoCapaUrl,
      fotoPerfilUrl: fresh.fotoPerfilUrl,
      fotoHistoriaUrl: fresh.fotoHistoriaUrl,
    });
  };

  // The whole affordance (the "Personalizar" toggle + panel) only exists for
  // whoever can actually save it — a logged-out visitor or a non-admin
  // shouldn't even see the entry point, not just have the Save button
  // hidden inside it.
  if (!showSave) return null;

  // Informational contrast check — surfaced only for CUSTOM colours. The
  // curated preset swatches are the brand palette (deliberately pastel); a
  // warning on every first open would be noise, not information.
  const primaryIsCustom = !isPresetPrimary(tweaks.primary);
  const accentIsCustom = !ACCENT_SWATCHES.some(
    (c) => c.toUpperCase() === tweaks.accent.toUpperCase(),
  );
  const warnings = contrastWarnings({ primary: tweaks.primary, accent: tweaks.accent });
  const primaryWarning = primaryIsCustom ? warnings.find((w) => w.field === "primary") : undefined;
  const accentWarning = accentIsCustom ? warnings.find((w) => w.field === "accent") : undefined;
  const historiaLen = (tweaks.historia ?? "").length;

  return (
    <div className="tweaks-dock">
      {open && (
        <div
          id="tweaks-panel"
          className="tweaks-panel"
          role="dialog"
          aria-label="Personalizar página"
          data-dirty={dirty ? "true" : "false"}
        >
          <header className="tweaks-panel-head">
            <span className="eyebrow eyebrow-coral" style={{ fontSize: 24 }}>
              tweaks
            </span>
            <button
              type="button"
              onClick={closeEditor}
              aria-label="Fechar painel de tweaks"
              className="tweaks-close"
            >
              ×
            </button>
          </header>

          <TweakSection title={SECTION_TITLES.titulo}>
            <TweakField
              inputId={EDIT_FIELDS.nomeBebe.inputId}
              label={EDIT_FIELDS.nomeBebe.label}
              hint="aparece no título, na história e no polaroid"
            >
              <input
                id={EDIT_FIELDS.nomeBebe.inputId}
                className="perfil-input"
                value={nomeInput}
                maxLength={120}
                placeholder={BABY_FALLBACK}
                onChange={(e) => {
                  setNomeInput(e.target.value);
                  setTweaks({ babyName: e.target.value.trim() || BABY_FALLBACK });
                }}
              />
            </TweakField>
          </TweakSection>

          <TweakSection title={SECTION_TITLES.historia}>
            <TweakField
              inputId={EDIT_FIELDS.historia.inputId}
              label={EDIT_FIELDS.historia.label}
              hint={`${historiaLen}/${HISTORIA_MAX}`}
            >
              <textarea
                id={EDIT_FIELDS.historia.inputId}
                className="perfil-input perfil-textarea"
                value={tweaks.historia ?? ""}
                maxLength={HISTORIA_MAX}
                rows={5}
                placeholder="como esse neném chegou na vida de vocês?"
                onChange={(e) => setTweaks({ historia: e.target.value })}
              />
            </TweakField>
            <TweakField
              inputId={EDIT_FIELDS.papais.inputId}
              label={EDIT_FIELDS.papais.label}
              hint={
                creatorName
                  ? `vazio = assina como ${creatorName}`
                  : "quem assina a história"
              }
            >
              <input
                id={EDIT_FIELDS.papais.inputId}
                className="perfil-input"
                value={papaisInput}
                maxLength={120}
                placeholder={creatorName || "Mari & Rodrigo"}
                onChange={(e) => {
                  setPapaisInput(e.target.value);
                  setTweaks({ parents: e.target.value.trim() || creatorName });
                }}
              />
            </TweakField>
          </TweakSection>

          <TweakSection title={SECTION_TITLES.fotos}>
            <PhotoSlot
              slot="capa"
              inline
              label={EDIT_FIELDS.fotoCapa.label}
              dropzoneId={EDIT_FIELDS.fotoCapa.inputId}
              displayUrl={tweaks.fotoCapaUrl ?? null}
              onUpload={uploadFoto}
            />
            <PhotoSlot
              slot="perfil"
              inline
              label={EDIT_FIELDS.fotoPerfil.label}
              dropzoneId={EDIT_FIELDS.fotoPerfil.inputId}
              displayUrl={tweaks.fotoPerfilUrl ?? null}
              onUpload={uploadFoto}
            />
            <PhotoSlot
              slot="historia"
              inline
              label={EDIT_FIELDS.fotoHistoria.label}
              dropzoneId={EDIT_FIELDS.fotoHistoria.inputId}
              displayUrl={tweaks.fotoHistoriaUrl ?? null}
              onUpload={uploadFoto}
            />
          </TweakSection>

          <TweakSection title={SECTION_TITLES.paleta}>
            <TweakColor
              inputId={EDIT_FIELDS.corPrimaria.inputId}
              label={EDIT_FIELDS.corPrimaria.label}
              value={tweaks.primary}
              hexText={primaryHex}
              options={PRIMARY_SWATCHES}
              custom={primaryIsCustom}
              warning={primaryWarning?.message ?? null}
              onPick={onPickPrimary}
              onHexText={onPrimaryHexText}
            />
            <TweakColor
              inputId={EDIT_FIELDS.corAcento.inputId}
              label={EDIT_FIELDS.corAcento.label}
              value={tweaks.accent}
              hexText={accentHex}
              options={ACCENT_SWATCHES}
              custom={accentIsCustom}
              warning={accentWarning?.message ?? null}
              onPick={onPickAccent}
              onHexText={onAccentHexText}
            />
          </TweakSection>

          {saveError && (
            <p role="alert" className="tweaks-error">
              {saveError}
            </p>
          )}

          <div className="tweaks-actions">
            <button
              type="button"
              onClick={onCancel}
              disabled={!dirty || salvando}
              className="btn-outline tweaks-btn"
              title="descarta só o texto e as cores não salvos — as fotos já enviadas ficam"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || salvando}
              className="btn-lilac tweaks-btn"
            >
              {salvando ? "Salvando..." : "Salvar"}
            </button>
          </div>
          <p className="tweaks-footnote">
            {dirty
              ? "alterações de texto e cor ainda não salvas · Cancelar desfaz só elas — fotos enviadas já estão salvas"
              : "tudo salvo · fotos são salvas na hora do envio"}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => (open ? closeEditor() : openEditor())}
        aria-expanded={open}
        aria-controls="tweaks-panel"
        aria-label={
          open
            ? "Fechar"
            : dirty
              ? "Personalizar (alterações não salvas)"
              : "Personalizar"
        }
        className="btn-lilac tweaks-toggle"
        data-dirty={dirty ? "true" : "false"}
      >
        {open ? "Fechar" : "Personalizar"}
        {!open && dirty && (
          <span className="tweaks-dirty-dot" aria-hidden="true" />
        )}
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
    <section className="tweaks-section" aria-label={title}>
      <div className="tweaks-section-title">{title}</div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function TweakField({
  inputId,
  label,
  hint,
  children,
}: {
  inputId: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="tweaks-field">
      <label htmlFor={inputId} className="tweaks-label">
        {label}
      </label>
      {children}
      {hint && <span className="perfil-field-hint">{hint}</span>}
    </div>
  );
}

function TweakColor({
  inputId,
  label,
  value,
  hexText,
  options,
  custom,
  warning,
  onPick,
  onHexText,
}: {
  inputId: string;
  label: string;
  /** Current normalized hex applied to the page. */
  value: string;
  /** Raw text in the hex input (may be mid-edit / invalid). */
  hexText: string;
  options: string[];
  custom: boolean;
  warning: string | null;
  onPick: (hex: string) => void;
  onHexText: (raw: string) => void;
}) {
  const hexValid = normalizeHex(hexText) !== null;
  const warnId = `${inputId}-warn`;
  const hexId = `${inputId}-hex`;
  return (
    <div className="tweaks-field" data-testid={`color-${inputId}`}>
      <span className="tweaks-label" id={`${inputId}-label`}>
        {label}
      </span>
      <div className="flex items-center gap-2 flex-wrap">
        {options.map((c) => {
          const active = c.toUpperCase() === value.toUpperCase();
          return (
            <button
              key={c}
              type="button"
              onClick={() => onPick(c)}
              aria-label={`${label}: ${c}${active ? " (selecionado)" : ""}`}
              aria-pressed={active}
              className={`tweaks-swatch${active ? " tweaks-swatch--active" : ""}`}
              style={{ background: c }}
            />
          );
        })}
        <label
          className={`tweaks-swatch tweaks-swatch--custom${custom ? " tweaks-swatch--active" : ""}`}
          style={{ background: custom ? value : undefined }}
          title={`${label}: escolher qualquer cor`}
        >
          <input
            id={inputId}
            type="color"
            value={value}
            aria-label={`${label}: escolher qualquer cor`}
            onChange={(e) => onPick(e.target.value)}
          />
        </label>
        <input
          id={hexId}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          className="perfil-input tweaks-hex"
          value={hexText}
          maxLength={7}
          aria-label={`${label}: código hex`}
          aria-invalid={!hexValid}
          aria-describedby={warning ? warnId : undefined}
          placeholder="#RRGGBB"
          onChange={(e) => onHexText(e.target.value)}
          onBlur={() => {
            // Snap the text back to the applied colour when left invalid.
            if (!hexValid) onHexText(value);
          }}
        />
      </div>
      {!hexValid && (
        <span className="perfil-field-hint" style={{ color: "var(--coral-pink)" }}>
          use um hex como #C9A5D8
        </span>
      )}
      {warning && (
        <span id={warnId} className="tweaks-warning" role="status">
          ⚠ {warning}
        </span>
      )}
    </div>
  );
}
