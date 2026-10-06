// aperture-whxzg — owner inline-edit field map + draft/dirty projection.
//
// One source of truth for "which page element edits which supported profile
// field": the contextual edit icons on Hero/Story reference these ids, the
// TweaksPanel renders one input per id, and openEditor(field) focuses the
// matching input. Pure module (no React, no DOM) — unit-tested in node.

export type EditField =
  | "nomeBebe"
  | "papais"
  | "historia"
  | "fotoCapa"
  | "fotoPerfil"
  | "fotoHistoria"
  | "corPrimaria"
  | "corAcento";

export type EditSection = "titulo" | "historia" | "fotos" | "paleta";

export interface EditFieldSpec {
  id: EditField;
  section: EditSection;
  /** DOM id of the focus target inside the panel. */
  inputId: string;
  /** aria-label of the contextual edit icon on the page. */
  iconLabel: string;
  /** Visible label inside the panel. */
  label: string;
}

export const EDIT_FIELDS: Record<EditField, EditFieldSpec> = {
  nomeBebe: {
    id: "nomeBebe",
    section: "titulo",
    inputId: "tweaks-nome-bebe",
    iconLabel: "Editar nome do bebê",
    label: "Nome do bebê",
  },
  papais: {
    id: "papais",
    section: "historia",
    inputId: "tweaks-papais",
    iconLabel: "Editar assinatura da família",
    label: "Assinatura (papais)",
  },
  historia: {
    id: "historia",
    section: "historia",
    inputId: "tweaks-historia",
    iconLabel: "Editar a nossa história",
    label: "A nossa história",
  },
  fotoCapa: {
    id: "fotoCapa",
    section: "fotos",
    inputId: "tweaks-foto-capa",
    iconLabel: "Trocar foto de capa",
    label: "Foto de capa",
  },
  fotoPerfil: {
    id: "fotoPerfil",
    section: "fotos",
    inputId: "tweaks-foto-perfil",
    iconLabel: "Trocar foto do bebê",
    label: "Foto do bebê",
  },
  fotoHistoria: {
    id: "fotoHistoria",
    section: "fotos",
    inputId: "tweaks-foto-historia",
    iconLabel: "Trocar foto da história",
    label: "Foto da história",
  },
  corPrimaria: {
    id: "corPrimaria",
    section: "paleta",
    inputId: "tweaks-cor-primaria",
    iconLabel: "Editar cor primária",
    label: "Primária",
  },
  corAcento: {
    id: "corAcento",
    section: "paleta",
    inputId: "tweaks-cor-acento",
    iconLabel: "Editar cor de acento",
    label: "Acento",
  },
};

export const SECTION_TITLES: Record<EditSection, string> = {
  titulo: "Título",
  historia: "História",
  fotos: "Fotos",
  paleta: "Paleta",
};

export const SECTION_ORDER: readonly EditSection[] = [
  "titulo",
  "historia",
  "fotos",
  "paleta",
];

/** The text + colour half of the draft — what Salvar writes and Cancelar discards. */
export interface EditableDraft {
  babyName: string;
  parents: string;
  historia: string;
  primary: string;
  accent: string;
}

export const DRAFT_KEYS: readonly (keyof EditableDraft)[] = [
  "babyName",
  "parents",
  "historia",
  "primary",
  "accent",
];

export const HISTORIA_MAX = 600;

/** Which draft keys differ from the saved baseline (trimmed text, case-insensitive hex). */
export function changedKeys(
  draft: EditableDraft,
  baseline: EditableDraft,
): (keyof EditableDraft)[] {
  const out: (keyof EditableDraft)[] = [];
  for (const key of DRAFT_KEYS) {
    if (normalizeForCompare(key, draft[key]) !== normalizeForCompare(key, baseline[key])) {
      out.push(key);
    }
  }
  return out;
}

export function isDirty(draft: EditableDraft, baseline: EditableDraft): boolean {
  return changedKeys(draft, baseline).length > 0;
}

function normalizeForCompare(key: keyof EditableDraft, value: string): string {
  if (key === "primary" || key === "accent") return value.trim().toUpperCase();
  return value.trim();
}

/**
 * Build the campanha save payload's editable half: start from the STORED
 * profile (`atual`, echoed verbatim — whole-content-replacement contract)
 * and override ONLY the keys the owner actually changed. An untouched
 * `parents` that merely displays the creatorName fallback is therefore never
 * persisted as `papais`; an untouched palette keeps whatever is stored.
 */
export function mergeDraftIntoStored<
  T extends {
    nomeBebe: string | null;
    papais: string | null;
    historia: string | null;
    corPrimaria: string | null;
    corAcento: string | null;
  },
>(atual: T, draft: EditableDraft, baseline: EditableDraft): T {
  const changed = new Set(changedKeys(draft, baseline));
  return {
    ...atual,
    nomeBebe: changed.has("babyName") ? draft.babyName.trim() || null : atual.nomeBebe,
    papais: changed.has("parents") ? draft.parents.trim() || null : atual.papais,
    historia: changed.has("historia") ? draft.historia.trim() || null : atual.historia,
    corPrimaria: changed.has("primary") ? draft.primary || null : atual.corPrimaria,
    corAcento: changed.has("accent") ? draft.accent || null : atual.corAcento,
  };
}

/** Client-side gate mirroring the VO: nomeBebe max 120, historia max 600, papais max 120. */
export function draftValidationError(draft: EditableDraft): string | null {
  if (draft.babyName.trim().length > 120) return "o nome do bebê pode ter até 120 caracteres";
  if (draft.parents.trim().length > 120) return "a assinatura pode ter até 120 caracteres";
  if (draft.historia.trim().length > HISTORIA_MAX) {
    return `a história pode ter até ${HISTORIA_MAX} caracteres`;
  }
  return null;
}
