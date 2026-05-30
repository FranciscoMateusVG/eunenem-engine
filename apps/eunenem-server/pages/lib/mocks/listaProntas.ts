// aperture-wo5ql — preset → item mock for the preset-detail modal.
//
// aperture-cwcn0 — Preset detail data extracted to git-versioned JSON
// in `apps/eunenem-server/lib/seed-data/listas-prontas.json` and exposed
// via the typed loader in `apps/eunenem-server/lib/templates`. This file
// is now a thin compat seam — re-exports the data shapes and the loaded
// presets so legacy callers keep their existing import surface working.
//
// NOTE on ids: the preset ids here (essenciais / banho / soninho / papinha)
// intentionally match the ids already used by g70uv's LISTA_PRONTAS array
// in ListaPresentesBody.tsx so the panel cards can look up their detail
// payload by the same key.

import {
  loadListasProntas,
  type ListaProntaDetail,
  type ListaProntaId,
  type PresetItem,
} from "../../../lib/templates";

// Re-export the canonical types so existing imports
// (`import { ListaProntaDetail, ListaProntaId, PresetItem } from
// '@/lib/mocks/listaProntas'`) keep resolving without touching any
// caller.
export type { PresetItem, ListaProntaId, ListaProntaDetail };

/** Preset detail map surfaced through the JSON loader. Frozen reference;
 *  do NOT mutate (the loader hands back a module-level snapshot). */
export const LISTA_PRONTAS_DETAIL: Record<ListaProntaId, ListaProntaDetail> =
  loadListasProntas();
