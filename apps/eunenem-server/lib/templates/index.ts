// aperture-cwcn0 / aperture-cdwdt — Typed loaders + shape validators for
// the static gift-list template seed data (catalog + listas prontas).
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
//   - Loader functions return the typed shape. The catalog JSON
//     ships as a FLAT array (mirrors the eunenem-DB dump 1:1 so
//     re-running the dump is a single file replace) and the loader
//     groups it into ListaCatalogSection[] at evaluation time.
//
// SCOPE NOTE: LISTA_PRESENTES_SEED (the per-user gift list mock)
// is intentionally NOT here. That data becomes real `contribuicoes`
// rows in aperture-0ph83. This loader only owns the GLOBAL template
// shapes that stay static across users.
//
// aperture-cdwdt: schema widened to carry real eunenem product data
// — `imageUrl` (string|null) on items, `imageUrl` (cover) +
// `description` on each lista pronta, new categories (`outros`,
// `brinquedo`) added, `personalizado` reserved for user-authored
// items only (the seed JSON is validated to reject it).

import catalogJson from "../seed-data/catalog.json";
import listasProntasJson from "../seed-data/listas-prontas.json";

// ── Public types ───────────────────────────────────────────────────────────
//
// Defined here (single source of truth) and re-exported by the
// existing mock files so legacy imports keep working.

/**
 * Category tag shown on each gift card. Lowercased in the UI.
 *
 * `personalizado` is RESERVED for user-authored items (ListaGift
 * with `custom: true` — see aperture-cdwdt operator clarification).
 * Seed catalog JSON MUST NOT use this category — `outros` is the
 * catch-all. Validator below enforces this on the seed file.
 */
export type ListaCategory =
  | "fraldas"
  | "higiene"
  | "roupa"
  | "soninho"
  | "alimentacao"
  | "passeio"
  | "brinquedo"
  | "outros"
  | "personalizado";

/** Categories ALLOWED in the seed catalog JSON. Strict subset that
 *  excludes `personalizado` (which would indicate seed pollution
 *  with user-input data — see ListaCategory docstring). */
const SEED_CATEGORIES: readonly ListaCategory[] = [
  "fraldas",
  "higiene",
  "roupa",
  "soninho",
  "alimentacao",
  "passeio",
  "brinquedo",
  "outros",
];

export interface ListaCatalogItem {
  id: string;
  /** Display name shown on the card. */
  name: string;
  /** Suggested unit price in BRL. The creator can override. */
  price: number;
  /** Default qty the form pre-fills when the item is added. */
  suggestedQty: number;
  /** Emoji glyph for the card thumb — also serves as fallback when
   *  `imageUrl` is null. */
  emoji: string;
  /** Token-referencing tint for the thumb background (`var(--...)`). */
  bgColor: string;
  /** Category — used for the section header + (when added) the
   *  resulting ListaGift's category field. */
  category: ListaCategory;
  /** Local path to a real product image (e.g. "/products/1468.jpg").
   *  `null` when the source CDN was dead — UI falls back to `emoji`. */
  imageUrl: string | null;
  /** Optional ranking signal carried through from the dump. UI
   *  may use it for sort-by-popularity in the future. */
  popularity?: number;
}

export interface ListaCatalogSection {
  /** Same enum as ListaCategory — section headers use the LABEL map. */
  category: ListaCategory;
  /** Pre-resolved display label (e.g. "fraldas", "roupinhas"). */
  label: string;
  /** Items in this section. */
  items: ListaCatalogItem[];
}

/**
 * Semantic slug identifiers for each lista pronta. Maps to legacy
 * eunenem DB ids (9/12/13/14/15) but the slugs are the canonical
 * type-safe identifiers in code.
 */
export type ListaProntaId =
  | "ilustrativa-especial"
  | "cha-de-fralda"
  | "cha-de-rifa"
  | "ilustrativa"
  | "carrinhos";

const KNOWN_PRONTA_IDS: readonly ListaProntaId[] = [
  "ilustrativa-especial",
  "cha-de-fralda",
  "cha-de-rifa",
  "ilustrativa",
  "carrinhos",
];

export interface PresetItem {
  id: string;
  name: string;
  price: number;
  suggestedQty: number;
  emoji: string;
  bgColor: string;
  /** Local path to the real product image; `null` falls back to `emoji`. */
  imageUrl: string | null;
}

export interface ListaProntaDetail {
  id: ListaProntaId;
  title: string;
  description: string;
  /** Cover image for the lista pronta tile. `null` falls back to a
   *  solid-tinted card with an emoji glyph. */
  imageUrl: string | null;
  items: PresetItem[];
}

// ── Display labels ─────────────────────────────────────────────────────────
//
// Single source of truth for category pt-BR labels. Surfaced via
// `loadCategoryLabel(cat)` so callers don't drift if the wording
// changes. Kept here (not in JSON) per operator decision on
// aperture-cwcn0 — labels are UI vocabulary, not data.

const LISTA_CATEGORY_LABEL: Record<ListaCategory, string> = {
  fraldas: "fraldas",
  higiene: "higiene",
  roupa: "roupinhas",
  soninho: "soninho",
  alimentacao: "alimentação",
  passeio: "passeio",
  brinquedo: "brinquedos",
  outros: "outros",
  personalizado: "personalizado",
};

// ── Validators ─────────────────────────────────────────────────────────────
//
// Hand-rolled because zod would add bundle weight for a check that
// only runs once at module evaluation. Each validator throws a
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

function assertOptionalFiniteNumber(
  v: unknown,
  path: string,
): asserts v is number | undefined {
  if (v === undefined) return;
  assertFiniteNumber(v, path);
}

function assertNullableString(
  v: unknown,
  path: string,
): asserts v is string | null {
  if (v === null) return;
  assertString(v, path);
}

function assertSeedCategory(
  v: unknown,
  path: string,
): asserts v is ListaCategory {
  assertString(v, path);
  if (!SEED_CATEGORIES.includes(v as ListaCategory)) {
    // Special-case `personalizado` so the error message is unambiguous —
    // this is the high-signal failure operator wants to catch.
    if (v === "personalizado") {
      fail(
        path,
        `"personalizado" is reserved for user-authored items (ListaGift custom: true) and must NOT appear in seed JSON. Use "outros" as the catch-all.`,
      );
    }
    fail(
      path,
      `unknown seed category "${v}" (allowed: ${SEED_CATEGORIES.join(", ")})`,
    );
  }
}

function assertProntaId(v: unknown, path: string): asserts v is ListaProntaId {
  assertString(v, path);
  if (!KNOWN_PRONTA_IDS.includes(v as ListaProntaId)) {
    fail(
      path,
      `unknown lista pronta id "${v}" (allowed: ${KNOWN_PRONTA_IDS.join(", ")})`,
    );
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
  assertSeedCategory(raw.category, `${path}.category`);
  assertNullableString(raw.imageUrl, `${path}.imageUrl`);
  assertOptionalFiniteNumber(raw.popularity, `${path}.popularity`);
  return {
    id: raw.id,
    name: raw.name,
    price: raw.price,
    suggestedQty: raw.suggestedQty,
    emoji: raw.emoji,
    bgColor: raw.bgColor,
    category: raw.category,
    imageUrl: raw.imageUrl,
    ...(raw.popularity !== undefined ? { popularity: raw.popularity } : {}),
  };
}

function validatePresetItem(raw: unknown, path: string): PresetItem {
  if (!isRecord(raw)) fail(path, "expected object");
  assertString(raw.id, `${path}.id`);
  assertString(raw.name, `${path}.name`);
  assertFiniteNumber(raw.price, `${path}.price`);
  assertFiniteNumber(raw.suggestedQty, `${path}.suggestedQty`);
  assertString(raw.emoji, `${path}.emoji`);
  assertString(raw.bgColor, `${path}.bgColor`);
  assertNullableString(raw.imageUrl, `${path}.imageUrl`);
  return {
    id: raw.id,
    name: raw.name,
    price: raw.price,
    suggestedQty: raw.suggestedQty,
    emoji: raw.emoji,
    bgColor: raw.bgColor,
    imageUrl: raw.imageUrl,
  };
}

function validateListaProntaDetail(
  raw: unknown,
  path: string,
): ListaProntaDetail {
  if (!isRecord(raw)) fail(path, "expected object");
  assertProntaId(raw.id, `${path}.id`);
  assertString(raw.title, `${path}.title`);
  assertString(raw.description, `${path}.description`);
  assertNullableString(raw.imageUrl, `${path}.imageUrl`);
  if (!Array.isArray(raw.items)) fail(`${path}.items`, "expected array");
  const items = raw.items.map((item, i) =>
    validatePresetItem(item, `${path}.items[${i}]`),
  );
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    imageUrl: raw.imageUrl,
    items,
  };
}

// ── Validated module-level snapshots ───────────────────────────────────────
//
// Validation runs ONCE per module evaluation, not per loader call.
//
// Catalog: JSON is a FLAT array of items (mirrors the eunenem-DB
// dump 1:1 — re-running the dump = single file replace, no hand
// massage). We group into ListaCatalogSection[] at eval time so the
// public loader signature stays unchanged. Section order follows the
// canonical SEED_CATEGORIES list above (deterministic, not data-
// driven, so the display order is stable even if the JSON is sorted
// differently between dumps).

const CATALOG: ListaCatalogSection[] = (() => {
  if (!Array.isArray(catalogJson)) {
    fail("catalog.json", "expected top-level array of items");
  }
  const validated = catalogJson.map((item, i) =>
    validateCatalogItem(item, `catalog.json[${i}]`),
  );
  // Group by category, preserving canonical section order.
  const byCategory = new Map<ListaCategory, ListaCatalogItem[]>();
  for (const item of validated) {
    const bucket = byCategory.get(item.category) ?? [];
    bucket.push(item);
    byCategory.set(item.category, bucket);
  }
  const sections: ListaCatalogSection[] = [];
  for (const category of SEED_CATEGORIES) {
    const items = byCategory.get(category);
    if (!items || items.length === 0) continue;
    sections.push({
      category,
      label: LISTA_CATEGORY_LABEL[category],
      items,
    });
  }
  return sections;
})();

const LISTAS_PRONTAS: Record<ListaProntaId, ListaProntaDetail> = (() => {
  if (!Array.isArray(listasProntasJson)) {
    fail("listas-prontas.json", "expected top-level array");
  }
  const result = {} as Record<ListaProntaId, ListaProntaDetail>;
  const seen = new Set<ListaProntaId>();
  listasProntasJson.forEach((raw, i) => {
    const detail = validateListaProntaDetail(raw, `listas-prontas.json[${i}]`);
    if (seen.has(detail.id)) {
      fail(`listas-prontas.json[${i}].id`, `duplicate id "${detail.id}"`);
    }
    seen.add(detail.id);
    result[detail.id] = detail;
  });
  // Every known id must be present (Record<ListaProntaId, …> is total).
  for (const id of KNOWN_PRONTA_IDS) {
    if (!seen.has(id)) {
      fail(`listas-prontas.json`, `missing required preset "${id}"`);
    }
  }
  return result;
})();

// ── Public loaders ─────────────────────────────────────────────────────────

/** All catalog sections, in canonical display order. */
export function loadCatalog(): ListaCatalogSection[] {
  return CATALOG;
}

/** All known "listas prontas" presets, keyed by id. */
export function loadListasProntas(): Record<ListaProntaId, ListaProntaDetail> {
  return LISTAS_PRONTAS;
}

/** Pt-BR display label for a category (UI vocabulary, single source). */
export function loadCategoryLabel(category: ListaCategory): string {
  return LISTA_CATEGORY_LABEL[category];
}

/** All categories valid in seed JSON (excludes `personalizado`). */
export function loadSeedCategories(): readonly ListaCategory[] {
  return SEED_CATEGORIES;
}
