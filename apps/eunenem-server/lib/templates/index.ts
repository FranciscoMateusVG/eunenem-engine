// aperture-cwcn0 — Typed loaders + shape validators for the static
// gift-list template seed data (catalog + listas prontas).
//
// WHY: operator decided template catalog + listas prontas live as
// git-versioned JSON in `apps/eunenem-server/lib/seed-data/` rather
// than DB rows. Edit-commit-deploy cadence, no infrastructure.
//
// This module is the single point of contact between the raw JSON
// (where the data lives) and every caller in the codebase (mocks,
// SSR, eventual tRPC procedures from aperture-0ph83). Behaviour:
//
//   - JSON is imported at module evaluation (esbuild inlines it into
//     the client bundle; tsx evaluates it server-side at boot).
//   - Hand-rolled validators run ONCE at module evaluation and throw
//     loud if the JSON shape drifts (e.g. a typo in a hand-edit
//     adds an unknown category or removes a required field). The
//     server crashes at boot rather than rendering a malformed
//     card; the client bundle throws during hydration rather than
//     silently displaying NaN prices.
//   - Loader functions return the typed shape. Currently they're
//     thin wrappers around the validated import — the indirection
//     exists so future caching/decoration logic has a stable seam.
//
// SCOPE NOTE: LISTA_PRESENTES_SEED (the per-user gift list mock)
// is intentionally NOT here. That data becomes real `contribuicoes`
// rows in aperture-0ph83. This loader only owns the GLOBAL template
// shapes that stay static across users.

import catalogJson from "../seed-data/catalog.json";
import listasProntasJson from "../seed-data/listas-prontas.json";

// ── Public types ───────────────────────────────────────────────────────────
//
// Defined here (single source of truth) and re-exported by the
// existing mock files so legacy imports keep working. Shapes are
// frozen as of the LISTA_CATALOGO_SEED + LISTA_PRONTAS_DETAIL
// inlined in the mocks before this refactor — any change here is
// a breaking-data-shape change, not a refactor.

/** Category tag shown on each gift card. Lowercased in the UI. */
export type ListaCategory =
  | "fraldas"
  | "higiene"
  | "roupa"
  | "soninho"
  | "alimentacao"
  | "passeio"
  | "personalizado";

/** All known categories, used to validate the JSON at load time. */
const KNOWN_CATEGORIES: readonly ListaCategory[] = [
  "fraldas",
  "higiene",
  "roupa",
  "soninho",
  "alimentacao",
  "passeio",
  "personalizado",
];

export interface ListaCatalogItem {
  id: string;
  /** Display name shown on the card. */
  name: string;
  /** Suggested unit price in BRL. The creator can override. */
  price: number;
  /** Default qty the form pre-fills when the item is added. */
  suggestedQty: number;
  /** Emoji glyph for the card thumb. */
  emoji: string;
  /** Token-referencing tint for the thumb background (`var(--...)`). */
  bgColor: string;
  /** Category — used for the section header + (when added) the
   *  resulting ListaGift's category field. */
  category: ListaCategory;
}

export interface ListaCatalogSection {
  /** Same enum as ListaCategory — section headers use the LABEL map. */
  category: ListaCategory;
  /** Pre-resolved display label (e.g. "fraldas", "roupinhas"). */
  label: string;
  /** Items in this section. */
  items: ListaCatalogItem[];
}

export type ListaProntaId = "essenciais" | "banho" | "soninho" | "papinha";

const KNOWN_PRONTA_IDS: readonly ListaProntaId[] = [
  "essenciais",
  "banho",
  "soninho",
  "papinha",
];

export interface PresetItem {
  id: string;
  name: string;
  price: number;
  suggestedQty: number;
  emoji: string;
  bgColor: string;
}

export interface ListaProntaDetail {
  id: ListaProntaId;
  title: string;
  description: string;
  items: PresetItem[];
}

// ── Validators ─────────────────────────────────────────────────────────────
//
// Hand-rolled because zod would add bundle weight for a check that
// only runs once at module evaluation. The shape is small enough
// that explicit walkers stay readable. Each validator throws a
// descriptive error that names the path of the offending node so
// hand-edits to the JSON fail loud and findable.

function fail(path: string, reason: string): never {
  throw new Error(
    `[lib/templates] seed-data shape error at ${path}: ${reason}`,
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertString(v: unknown, path: string): asserts v is string {
  if (typeof v !== "string") fail(path, `expected string, got ${typeof v}`);
}

function assertFiniteNumber(v: unknown, path: string): asserts v is number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(path, `expected finite number, got ${typeof v} (${String(v)})`);
  }
}

function assertCategory(v: unknown, path: string): asserts v is ListaCategory {
  assertString(v, path);
  if (!KNOWN_CATEGORIES.includes(v as ListaCategory)) {
    fail(path, `unknown category "${v}" (allowed: ${KNOWN_CATEGORIES.join(", ")})`);
  }
}

function assertProntaId(v: unknown, path: string): asserts v is ListaProntaId {
  assertString(v, path);
  if (!KNOWN_PRONTA_IDS.includes(v as ListaProntaId)) {
    fail(path, `unknown lista pronta id "${v}" (allowed: ${KNOWN_PRONTA_IDS.join(", ")})`);
  }
}

function validateCatalogItem(raw: unknown, path: string): ListaCatalogItem {
  if (!isRecord(raw)) fail(path, "expected object");
  assertString(raw.id, `${path}.id`);
  assertString(raw.name, `${path}.name`);
  assertFiniteNumber(raw.price, `${path}.price`);
  assertFiniteNumber(raw.suggestedQty, `${path}.suggestedQty`);
  assertString(raw.emoji, `${path}.emoji`);
  assertString(raw.bgColor, `${path}.bgColor`);
  assertCategory(raw.category, `${path}.category`);
  return {
    id: raw.id,
    name: raw.name,
    price: raw.price,
    suggestedQty: raw.suggestedQty,
    emoji: raw.emoji,
    bgColor: raw.bgColor,
    category: raw.category,
  };
}

function validateCatalogSection(raw: unknown, path: string): ListaCatalogSection {
  if (!isRecord(raw)) fail(path, "expected object");
  assertCategory(raw.category, `${path}.category`);
  assertString(raw.label, `${path}.label`);
  if (!Array.isArray(raw.items)) fail(`${path}.items`, "expected array");
  const items = raw.items.map((item, i) =>
    validateCatalogItem(item, `${path}.items[${i}]`),
  );
  return { category: raw.category, label: raw.label, items };
}

function validatePresetItem(raw: unknown, path: string): PresetItem {
  if (!isRecord(raw)) fail(path, "expected object");
  assertString(raw.id, `${path}.id`);
  assertString(raw.name, `${path}.name`);
  assertFiniteNumber(raw.price, `${path}.price`);
  assertFiniteNumber(raw.suggestedQty, `${path}.suggestedQty`);
  assertString(raw.emoji, `${path}.emoji`);
  assertString(raw.bgColor, `${path}.bgColor`);
  return {
    id: raw.id,
    name: raw.name,
    price: raw.price,
    suggestedQty: raw.suggestedQty,
    emoji: raw.emoji,
    bgColor: raw.bgColor,
  };
}

function validateListaProntaDetail(raw: unknown, path: string): ListaProntaDetail {
  if (!isRecord(raw)) fail(path, "expected object");
  assertProntaId(raw.id, `${path}.id`);
  assertString(raw.title, `${path}.title`);
  assertString(raw.description, `${path}.description`);
  if (!Array.isArray(raw.items)) fail(`${path}.items`, "expected array");
  const items = raw.items.map((item, i) =>
    validatePresetItem(item, `${path}.items[${i}]`),
  );
  return { id: raw.id, title: raw.title, description: raw.description, items };
}

// ── Validated module-level snapshots ───────────────────────────────────────
//
// JSON imports are typed as the literal types tsc infers from the
// content; we run them through the validators to assert the runtime
// shape matches our public types AND to produce a single frozen
// snapshot the loader functions hand back. Validation runs ONCE per
// module evaluation, not per loader call.

const CATALOG: ListaCatalogSection[] = (() => {
  if (!Array.isArray(catalogJson)) {
    fail("catalog.json", "expected top-level array of sections");
  }
  return catalogJson.map((section, i) =>
    validateCatalogSection(section, `catalog.json[${i}]`),
  );
})();

const LISTAS_PRONTAS: Record<ListaProntaId, ListaProntaDetail> = (() => {
  if (!isRecord(listasProntasJson)) {
    fail("listas-prontas.json", "expected top-level object");
  }
  // Every known id must be present (Record<ListaProntaId, …> is total).
  const result = {} as Record<ListaProntaId, ListaProntaDetail>;
  for (const id of KNOWN_PRONTA_IDS) {
    const raw = listasProntasJson[id];
    if (raw === undefined) {
      fail(`listas-prontas.json.${id}`, "missing required preset");
    }
    result[id] = validateListaProntaDetail(raw, `listas-prontas.json.${id}`);
  }
  return result;
})();

// ── Public loaders ─────────────────────────────────────────────────────────
//
// Thin wrappers around the validated snapshots. The indirection
// gives downstream code (aperture-0ph83 + future cache/decoration
// work) a stable seam that doesn't leak the import shape.

/** All catalog sections, in display order. */
export function loadCatalog(): ListaCatalogSection[] {
  return CATALOG;
}

/** All known "listas prontas" presets, keyed by id. */
export function loadListasProntas(): Record<ListaProntaId, ListaProntaDetail> {
  return LISTAS_PRONTAS;
}
