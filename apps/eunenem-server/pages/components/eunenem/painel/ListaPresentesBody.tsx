import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

// aperture-tua9o — image upload+crop for the custom ("personalizado") item form.
import { ItemImageUpload } from "./ItemImageUpload";

// aperture-p73kv — deterministic random "sugerido N un" in [5, 10] keyed
// by item id (djb2 hash). The hardcoded `1` operators saw was unrealistic
// for baby-shower lists ("sugerido is still only 1 unidade and i cant add
// or remove more"). djb2 is fast + deterministic per session so the same
// card always shows the same number across re-renders. The inline stepper
// (PartB) lets the user adjust before adding the item to their list.
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
function defaultSuggestedQty(itemId: string): number {
  // [5, 10] inclusive — 6 buckets.
  return 5 + (djb2(itemId) % 6);
}

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  loadCatalog,
  loadListasProntas,
  type ListaCatalogItem,
  type ListaCategory,
  type ListaProntaDetail,
  type ListaProntaId,
  type PresetItem,
} from "../../../../lib/templates/index.js";
import {
  brlFromCents,
  centsFromBRL,
  contribuicaoErrorMessage,
  deriveBgColor,
  toContribuicaoError,
  useContribuicaoCreate,
  useContribuicaoCreateBulk,
  useContribuicaoDelete,
  useContribuicaoUpdate,
  useContribuicaoList,
  type ContribuicaoDTO,
} from "@/lib/contribuicao.js";

// aperture-0ph83 — "Minha lista de presentes" (creator gift-list management).
//
// CONTENT ONLY — topbar / shell / TweaksPanel come from PainelLayout. This is
// the creator side: add / edit / remove gift items, set price + quantity, see
// how many units each item has already received. Distinct from the public
// marketplace (/pagina/:slug) which is the read-only buy view.
//
// Data flow (the wire-up that aperture-4je0p stubbed with React state +
// LISTA_PRESENTES_SEED is now real):
//   - List query: `useContribuicaoList()` → ContribuicaoDTO[] from backend
//   - One contribuicao = one UNIT. The UI groups by `nome` so each card
//     represents an item shape and qty = group size, received = group's
//     indisponivel count. Edits/deletes operate on the whole group.
//   - Create: custom items via `useContribuicaoCreate`; catalog/preset
//     selections via `useContribuicaoCreateBulk` (single INSERT for N items).
//   - Edit: delete-and-recreate the group. Safe because edits are disabled
//     when any unit is claimed (status='indisponivel'), so no contribuinte
//     data is lost. Simpler than per-id update + qty delta math.
//   - Remove: batch delete all ids in the group.
//   - All mutations invalidate the list query → UI re-fetches automatically.
//   - Errors map through `toContribuicaoError` → user-facing pt-BR toast.
//
// During PR #68 (Rex's aperture-d6atj) being in-flight, the adapter at
// `@/lib/contribuicao` re-exports a mock impl with 200ms artificial delay.
// When PR #68 merges, ONLY the adapter's internals flip to `trpc.contribuicao.*`
// — this file stays unchanged. Single-file swap.
//
// CSS lives in tailwind.css under the `.lista-*` namespace (unchanged from
// the seed-driven era — visual recipe is byte-identical per OUT OF SCOPE).

const brl = (n: number) =>
  "R$ " +
  n.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// aperture-0ph83 / aperture-cdwdt — UI vocabulary for the category chips/badges.
// Kept in code (not in templates JSON) per operator decision on aperture-cwcn0.
// `outros` + `brinquedo` added in aperture-cdwdt when the real eunenem catalog
// taxonomy landed. `personalizado` stays in the local options list because the
// PersonalizadoForm uses it as the default category for user-authored items
// (the seed catalog itself never contains personalizado — validator enforces).
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

const CATEGORY_OPTIONS: ListaCategory[] = [
  "fraldas",
  "higiene",
  "roupa",
  "soninho",
  "alimentacao",
  "passeio",
  "brinquedo",
  "outros",
  "personalizado",
];

/* ─── Icons (stroke style) ─── */
const icon = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 2l4 4-13 13H5v-4z" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  heart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  ),
  sparkle: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  ),
  listLines: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  ),
  caretDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  ),
  alert: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  ),
};

// aperture-g70uv / aperture-0ph83 / aperture-cdwdt — visual identity overlay
// for the curated preset cards surfaced by the "Usar lista pronta" expand/
// collapse panel. Title + description + cover imageUrl now live in the JSON
// template (loaded via loadListasProntas), so the array below only carries
// the presentation deltas (emoji + backdrop tint). Item count + title +
// description + cover all come from the loaded detail at render time, so
// the data and the UI stay in lock-step.
interface ListaProntaPreset {
  id: ListaProntaId;
  emoji: string;
  tileVar: string;
}
const LISTA_PRONTAS: ListaProntaPreset[] = [
  {
    id: "ilustrativa-especial",
    emoji: "👕",
    tileVar: "var(--lilac-soft)",
  },
  {
    id: "cha-de-fralda",
    emoji: "🧷",
    tileVar: "var(--pink-soft)",
  },
  {
    id: "cha-de-rifa",
    emoji: "🎁",
    tileVar: "var(--yellow-soft)",
  },
  {
    id: "ilustrativa",
    emoji: "✨",
    tileVar: "var(--cream-2)",
  },
  {
    id: "carrinhos",
    emoji: "🚼",
    tileVar: "var(--blue-soft)",
  },
];

type CatFilter = "all" | ListaCategory;
type AddTab = "catalogo" | "personalizado";

interface DraftFields {
  title: string;
  price: string;
  qty: number;
  category: ListaCategory;
  // aperture-tua9o — optional uploaded image (publicUrl) for the custom item.
  imageUrl: string | null;
}

function emptyDraft(): DraftFields {
  return { title: "", price: "", qty: 1, category: "personalizado", imageUrl: null };
}

/* ─── Grouping ─── */
//
// aperture-0ph83 — one contribuicao = one UNIT. The UI groups by `nome` so
// each card represents an item shape with aggregated qty/received counts.
// Edits/deletes operate on the whole group (all ids).
interface GroupedGift {
  ids: string[];
  nome: string;
  price: number; // BRL (converted from valor cents at the adapter boundary)
  category: ListaCategory;
  // aperture-intake-grxsh-followup — split emoji vs real image. `imageUrl` is a
  // same-origin path or absolute http(s) URL; when set, the card renders an
  // <img>. Otherwise `emoji` (a per-grupo glyph fallback) is rendered as text.
  emoji: string;
  imageUrl: string | null;
  bgColor: string;
  // aperture-intake-grxsh-followup — when `grupo` isn't a known
  // LISTA_CATEGORY, we surface the raw value as the chip text instead of
  // collapsing it to "personalizado" (which is reserved for true user-created
  // items per FLASHBACK §4.5).
  chipLabel: string;
  qty: number;
  received: number;
  hasClaimed: boolean;
  custom: boolean;
}

const isListaCategory = (g: string | null | undefined): g is ListaCategory => {
  return (
    g === "fraldas" ||
    g === "higiene" ||
    g === "roupa" ||
    g === "soninho" ||
    g === "alimentacao" ||
    g === "passeio" ||
    g === "brinquedo" ||
    g === "outros" ||
    g === "personalizado"
  );
};

// aperture-intake-grxsh-followup — `imagemUrl` is an image when it starts with
// `/` (same-origin) or `http(s)://`. Anything else (a stray emoji from legacy
// rows, etc.) is treated as text content. Mirrors the catalog modal's
// it.imageUrl rendering at line ~1176.
const isImagePath = (v: string | null | undefined): v is string =>
  typeof v === "string" && /^(\/|https?:\/\/)/.test(v);

function groupContribuicoes(items: ContribuicaoDTO[]): GroupedGift[] {
  const map = new Map<string, GroupedGift>();
  for (const c of items) {
    // aperture-intake-grxsh-followup — Only collapse to "personalizado" when
    // the category is genuinely a known one we want to style as a chip. For
    // unknown grupos (e.g. lista-pronta IDs like "ilustrativa" that the seed
    // path stuffed into the column) we use "outros" as the typed bucket but
    // render the raw grupo as the chip text below — see chipLabel.
    const category: ListaCategory = isListaCategory(c.grupo) ? c.grupo : "outros";
    const knownLabel = isListaCategory(c.grupo) ? LISTA_CATEGORY_LABEL[c.grupo] : null;
    const chipLabel =
      knownLabel ?? (typeof c.grupo === "string" && c.grupo.trim() !== "" ? c.grupo.toLowerCase() : "outros");
    const imageUrl = isImagePath(c.imagemUrl) ? c.imagemUrl : null;
    const emoji = imageUrl ? "🎁" : c.imagemUrl ?? "🎁";
    const existing = map.get(c.nome);
    // Plan 0015 derived-availability (aperture-ocw8r). The legacy
    // `c.status === "indisponivel"` comparison breaks once Rex's Phase 1
    // entity surgery drops the column — we read the derived `indisponivel`
    // boolean instead. Parallel-prep stub: optional on the wire today, so
    // `undefined` is treated as not-received (same shape as today's bug;
    // resolves the moment Rex's @repo/domains schema commit ships).
    const isReserved = c.indisponivel === true;
    // Plan 0016 / aperture-1l37i: read entity.quantidade directly with a
    // 1-default for legacy rows that pre-date the wire bump. The
    // accumulation logic below handles BOTH shapes uniformly:
    //   - Legacy (pre-create-flow-rewrite): N rows of "Fralda" each
    //     quantidade=1 → group qty sums to N (matches today's behavior).
    //   - Post-rewrite: 1 row of "Fralda" with quantidade=N → group qty
    //     equals N directly. No double-counting; the loop only sees one
    //     row per gift.
    //
    // aperture-ypk01 (Plan 0016 leak — partial-sale leak fix): the
    // `received` axis is DUAL-MODE based on the row's quantidade:
    //
    //   - new-shape row (quantidade > 1): receive count =
    //     quantidade - max(0, quantidadeRestante). Reads the explicit
    //     remaining-slots projection landed by the router companion,
    //     clamps negative overshoots to 0 (locked decision #10 allows
    //     quantidadeRestante to go negative on concurrent oversell;
    //     painel display caps at quantidade). This is what makes the
    //     "5 de 10 recebidos" tally render when a partial purchase
    //     has happened — the binary indisponivel only flips when ALL
    //     N slots are sold, so legacy-mode below would have surfaced
    //     0 here.
    //
    //   - legacy multi-row (quantidade <= 1): preserve the original
    //     row-by-row count where each indisponivel row contributes
    //     its own quantidade to the received tally. This keeps the
    //     pre-Plan-0016 N-rows-of-quantidade-1 fixtures correct.
    //
    // The visitor-side equivalent of this dual-mode shipped in PR #182;
    // this is the painel-side analog the night batch missed.
    const rowQuantidade = c.quantidade ?? 1;
    const isNewShape = rowQuantidade > 1;
    const rowReceived = isNewShape
      ? rowQuantidade - Math.max(0, c.quantidadeRestante ?? rowQuantidade)
      : isReserved
        ? rowQuantidade
        : 0;
    if (existing) {
      existing.ids.push(c.id);
      existing.qty += rowQuantidade;
      existing.received += rowReceived;
    } else {
      map.set(c.nome, {
        ids: [c.id],
        nome: c.nome,
        price: brlFromCents(c.valor),
        category,
        emoji,
        imageUrl,
        bgColor: deriveBgColor(c.grupo),
        chipLabel,
        qty: rowQuantidade,
        received: rowReceived,
        hasClaimed: rowReceived > 0,
        // `custom` styling (pink chip + locked semantics) is reserved for true
        // user-created items, i.e. grupo === "personalizado". Don't flag rows
        // we merely couldn't categorize.
        custom: c.grupo === "personalizado",
      });
    }
  }
  for (const g of map.values()) {
    g.hasClaimed = g.received > 0;
  }
  return [...map.values()];
}

/* ─── Stats visor ─── */
function Visor({ items }: { items: GroupedGift[] }) {
  const totalValue = items.reduce((s, i) => s + i.price * i.qty, 0);
  const receivedValue = items.reduce((s, i) => s + i.price * i.received, 0);
  const pct = totalValue > 0 ? Math.min(100, (receivedValue / totalValue) * 100) : 0;
  const totalUnits = items.reduce((s, i) => s + i.qty, 0);
  const receivedUnits = items.reduce((s, i) => s + i.received, 0);

  return (
    <div className="lista-visor">
      <div className="lista-visor-side lista-visor-received">
        <span className="lista-visor-eyebrow">já recebido ♡</span>
        <div className="lista-visor-amount">{brl(receivedValue)}</div>
        <div className="lista-visor-meta">
          {receivedUnits} de {totalUnits} presentes
        </div>
      </div>
      <div className="lista-visor-progress">
        <div className="lista-visor-bar">
          <div className="lista-visor-fill" style={{ width: pct + "%" }}>
            <span className="lista-visor-knob" />
          </div>
        </div>
        <div className="lista-visor-progress-meta">
          <span>
            <b>{Math.round(pct)}%</b> da sua lista
          </span>
        </div>
      </div>
      <div className="lista-visor-side lista-visor-total">
        <span className="lista-visor-eyebrow">total da lista</span>
        <div className="lista-visor-amount">{brl(totalValue)}</div>
        <div className="lista-visor-meta">
          {items.length} {items.length === 1 ? "presente" : "presentes"}
        </div>
      </div>
    </div>
  );
}

/* ─── Gift card ─── */
function GiftCard({
  item,
  onEdit,
  onRemove,
}: {
  item: GroupedGift;
  onEdit: (i: GroupedGift) => void;
  onRemove: (i: GroupedGift) => void;
}) {
  const pct = item.qty > 0 ? Math.min(100, (item.received / item.qty) * 100) : 0;
  const isComplete = item.received >= item.qty;
  // aperture-0ph83 — Edit/Remove disabled when any unit is claimed
  // (status='indisponivel'). The tooltip explains why the buttons are inert.
  const lockedTip = item.hasClaimed
    ? "não dá pra mexer — algum presente desse grupo já foi reservado ♡"
    : undefined;
  return (
    <div className={"lista-card" + (isComplete ? " is-complete" : "")} data-testid="lista-card">
      <div className="lista-card-thumb" style={{ background: item.bgColor }}>
        {/* aperture-intake-grxsh-followup — real product image when imagemUrl
            is a same-origin path or absolute URL; emoji fallback otherwise.
            Mirrors the catalog modal's it.imageUrl pattern. */}
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              borderRadius: "inherit",
              display: "block",
            }}
          />
        ) : (
          <span className="lista-card-emoji" aria-hidden="true">
            {item.emoji}
          </span>
        )}
        <span className={"lista-card-badge" + (item.custom ? " is-custom" : "")}>
          {item.chipLabel}
        </span>
        <div className="lista-card-actions">
          <button
            type="button"
            onClick={() => onEdit(item)}
            aria-label={`Editar ${item.nome}`}
            disabled={item.hasClaimed}
            title={lockedTip}
            data-testid="gift-edit-btn"
          >
            {icon.edit}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => onRemove(item)}
            aria-label={`Remover ${item.nome}`}
            title={lockedTip}
          >
            {icon.trash}
          </button>
        </div>
        {isComplete && <span className="lista-card-stamp">recebido ♡</span>}
      </div>
      <div className="lista-card-body">
        <h5 className="lista-card-title">{item.nome}</h5>
        <div className="lista-card-row">
          <span className="lista-card-price">
            {brl(item.price)} <small>· cada</small>
          </span>
          <span className="lista-card-qty">{item.qty} un</span>
        </div>
        <div className="lista-card-progress">
          <i style={{ width: pct + "%" }} />
        </div>
        <div className="lista-card-progress-meta">
          <span>
            {item.received} de {item.qty} recebidos
          </span>
          <span>
            <b>{brl(item.price * item.qty)}</b>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── Modal shell ─── */
function Modal({
  children,
  onClose,
  sm,
  lg,
}: {
  children: React.ReactNode;
  onClose: () => void;
  sm?: boolean;
  lg?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <div className="lista-scrim" onClick={onClose}>
      <div
        className={
          "lista-modal" +
          (sm ? " lista-modal-sm" : "") +
          (lg ? " lista-modal-lg" : "")
        }
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}

/* ─── Personalizado form (shared by Adicionar→Personalizado + Editar) ─── */
function PersonalizadoForm({
  f,
  setF,
  showBanner,
}: {
  f: DraftFields;
  setF: (next: DraftFields) => void;
  showBanner?: boolean;
}) {
  return (
    <>
      {showBanner && (
        <div className="lista-info-banner">
          <span className="lista-info-banner-ic" aria-hidden="true">{icon.sparkle}</span>
          <div className="lista-info-banner-text">
            <strong>Algo único da sua história?</strong>
            <p>
              Adicione presentes que não estão no catálogo — uma cadeirinha específica,
              decoração do quartinho ou aquele item dos sonhos.
            </p>
          </div>
        </div>
      )}
      <div className="lista-form">
        <div className="lista-field lista-field-full">
          <label htmlFor="lista-title">nome do presente</label>
          <input
            id="lista-title"
            placeholder="ex.: Cadeirinha de carro Maxi-Cosi"
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
        </div>
        <div className="lista-field">
          <label htmlFor="lista-price">valor por unidade</label>
          <input
            id="lista-price"
            inputMode="decimal"
            placeholder="R$ 0,00"
            value={f.price}
            onChange={(e) => setF({ ...f, price: e.target.value })}
          />
          <span className="lista-hint">quanto cada convidado vai contribuir</span>
        </div>
        <div className="lista-field">
          <label>quantidade</label>
          <div className="lista-stepper">
            <button
              type="button"
              onClick={() => setF({ ...f, qty: Math.max(1, (Number(f.qty) || 1) - 1) })}
              aria-label="Diminuir quantidade"
            >
              −
            </button>
            <input
              value={f.qty}
              inputMode="numeric"
              onChange={(e) =>
                setF({ ...f, qty: Number(e.target.value.replace(/\D/g, "")) || 1 })
              }
              aria-label="Quantidade"
              data-testid="qty-input"
            />
            <button
              type="button"
              onClick={() => setF({ ...f, qty: (Number(f.qty) || 1) + 1 })}
              aria-label="Aumentar quantidade"
            >
              +
            </button>
          </div>
        </div>
        {/* aperture-oa0th — CATEGORIA field hidden (visual-only). The category
            data model is intact: `f.category` still defaults to "personalizado"
            (see emptyDraft) and is sent as `grupo` on submit. We keep the JSX
            behind `{false && …}` so the underlying state/options stay wired and
            the control can be restored by flipping the flag. */}
        {false && (
          <div className="lista-field lista-field-full">
            <label htmlFor="lista-cat">categoria</label>
            <select
              id="lista-cat"
              value={f.category}
              onChange={(e) => setF({ ...f, category: e.target.value as ListaCategory })}
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {LISTA_CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* aperture-tua9o — optional image (upload + crop → MinIO). */}
        <ItemImageUpload
          value={f.imageUrl}
          onChange={(url) => setF({ ...f, imageUrl: url })}
        />
      </div>
    </>
  );
}

/* ─── Catálogo (catalog tab body) — aperture-0xhs4 refactor ─── */
//
// Pre-refactor (aperture-0ph83/cdwdt): rendered ALL 355 catalog items into one
// long DOM under per-category section headers. Browsing was rough and the
// initial render mounted ~355 buttons + 288 <img> tags upfront.
//
// Post-refactor:
//   1. Category chip strip at top — emoji + pt-BR label + count per chip.
//      "todos" chip shows the whole catalog. Sticky inside the modal scroll
//      area so the user can re-pivot without scrolling back to the top.
//   2. Render pagination (24 items per page) — scroll near the bottom and an
//      IntersectionObserver bumps the visible count. No external lib needed.
//   3. Search scoped to the selected category by default. When local search
//      returns empty inside a category, a "buscar em todas" affordance
//      expands the scope to the whole catalog.
//   4. Native lazy-loading + async decoding on every product img — together
//      with the 24-at-a-time render pagination, only the visible imgs are
//      ever fetched + decoded. Modal-open stays \<100ms even at 355 items.
//
// Modal-reopen state reset is automatic: AddGiftModal only mounts CatalogoView
// when the modal opens, so each open gets fresh useState defaults (cat="todos",
// search="", visible=24).

const CATEGORY_CHIP_EMOJI: Record<ListaCategory, string> = {
  fraldas: "🧷",
  higiene: "🧴",
  roupa: "👕",
  soninho: "🛏️",
  alimentacao: "🍼",
  passeio: "🚼",
  brinquedo: "🧸",
  outros: "🎁",
  personalizado: "✨",
};

type CatScope = "todos" | ListaCategory;
const PAGE_SIZE = 24;

function CatalogoView({
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (item: ListaCatalogItem) => void;
}) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<CatScope>("todos");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // aperture-0ph83 — sourced from JSON loader (aperture-cwcn0) instead of the
  // legacy mock.
  const catalog = useMemo(() => loadCatalog(), []);

  // Build the flat all-items list + per-category buckets once. Section labels
  // double as chip labels (one source of truth for pt-BR vocabulary).
  const allItems = useMemo(
    () => catalog.flatMap((sec) => sec.items),
    [catalog],
  );
  const chips = useMemo(() => {
    const list: Array<{ scope: CatScope; label: string; emoji: string; count: number }> = [
      { scope: "todos", label: "todos", emoji: "✨", count: allItems.length },
    ];
    for (const sec of catalog) {
      list.push({
        scope: sec.category,
        label: sec.label,
        emoji: CATEGORY_CHIP_EMOJI[sec.category] ?? "🎁",
        count: sec.items.length,
      });
    }
    return list;
  }, [catalog, allItems.length]);

  // Pool of items in the selected scope, then the search filter on top of that.
  const q = search.trim().toLowerCase();
  const pool = useMemo(() => {
    if (scope === "todos") return allItems;
    const sec = catalog.find((s) => s.category === scope);
    return sec?.items ?? [];
  }, [scope, allItems, catalog]);
  const filtered = useMemo(
    () => (q ? pool.filter((i) => i.name.toLowerCase().includes(q)) : pool),
    [pool, q],
  );

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // Reset render pagination whenever the filter inputs change so the user
  // doesn't see a stale "100 of 24 shown" mismatch after switching scope.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [scope, q]);

  // IntersectionObserver — reveals the next batch when the sentinel scrolls
  // into view (with a 200px pre-trigger so the next batch is mounted by the
  // time the user reaches it). The scroll container is the modal body
  // (`.lista-modal-body`, overflow-y: auto), NOT the viewport — so we walk up
  // from the sentinel to find the nearest scrollable ancestor and pass it as
  // the observer root. Without this, the sentinel never "intersects the
  // viewport" because the modal body clips the scroll.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    let scrollRoot: Element | null = el.parentElement;
    while (scrollRoot) {
      const cs = getComputedStyle(scrollRoot);
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") break;
      scrollRoot = scrollRoot.parentElement;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => Math.min(filtered.length, c + PAGE_SIZE));
        }
      },
      { root: scrollRoot, rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, filtered.length]);

  const activeLabel = chips.find((c) => c.scope === scope)?.label ?? "todos";

  return (
    <div className="lista-catalogo">
      <div className="lista-cat-search">
        <span className="lista-cat-search-ic" aria-hidden="true">{icon.search}</span>
        <input
          type="text"
          placeholder={
            scope === "todos"
              ? "buscar no catálogo (fralda, mamadeira...)"
              : `buscar em ${activeLabel}...`
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar no catálogo"
        />
      </div>

      {/* Category chip strip — sticky inside the modal scroll area. */}
      <div
        className="lista-cat-chips"
        role="tablist"
        aria-label="Filtrar por categoria"
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          padding: "8px 2px 12px",
          position: "sticky",
          top: 0,
          zIndex: 2,
          background: "var(--paper)",
          margin: "0 -2px",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}
      >
        {chips.map((chip) => {
          const active = chip.scope === scope;
          return (
            <button
              type="button"
              key={chip.scope}
              role="tab"
              aria-selected={active}
              onClick={() => setScope(chip.scope)}
              style={{
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 999,
                border: active
                  ? "1.5px solid var(--lilac-deep)"
                  : "1.5px solid var(--lilac-soft)",
                background: active ? "var(--lilac-soft)" : "var(--paper)",
                color: active ? "var(--plum)" : "var(--ink-soft)",
                fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "all 120ms cubic-bezier(0.4, 0, 0.2, 1)",
              }}
            >
              <span aria-hidden="true">{chip.emoji}</span>
              <span>{chip.label}</span>
              <span
                aria-hidden="true"
                style={{
                  fontSize: 11,
                  color: active ? "var(--lilac-deep)" : "var(--ink-mute)",
                  fontWeight: 500,
                }}
              >
                · {chip.count}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="lista-cat-empty">
          <span className="eyebrow coral">nada por aqui</span>
          {scope === "todos" ? (
            <p>
              Tente outra palavra — ou monte o presente pela aba <b>personalizado</b>.
            </p>
          ) : (
            <p>
              Nenhum presente em <b>{activeLabel}</b> pra essa busca.{" "}
              <button
                type="button"
                onClick={() => setScope("todos")}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--lilac-deep)",
                  textDecoration: "underline",
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                buscar em todas as categorias →
              </button>
            </p>
          )}
        </div>
      ) : (
        <>
          <ul className="lista-cat-list">
            {visible.map((it) => {
              const on = selected.has(it.id);
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    className={"lista-cat-item" + (on ? " is-selected" : "")}
                    onClick={() => onToggle(it)}
                    aria-pressed={on}
                  >
                    <span className="lista-cat-thumb" style={{ background: it.bgColor }}>
                      {/* aperture-cdwdt: real product image when available; emoji fallback
                          for the 67 null-image items. aperture-0xhs4: native lazy +
                          async decoding so only visible thumbs hit the network/decoder. */}
                      {it.imageUrl ? (
                        <img
                          src={it.imageUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="lista-cat-img"
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            borderRadius: "inherit",
                            display: "block",
                          }}
                        />
                      ) : (
                        <span className="lista-cat-emoji" aria-hidden="true">{it.emoji}</span>
                      )}
                    </span>
                    <span className="lista-cat-meta">
                      <span className="lista-cat-name">{it.name}</span>
                      <span className="lista-cat-sub">
                        {brl(it.price)} · sugerido {defaultSuggestedQty(it.id)} un
                      </span>
                    </span>
                    <span
                      className={"lista-cat-check" + (on ? " is-on" : "")}
                      aria-hidden="true"
                    >
                      {on ? icon.check : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Sentinel + end-cap. The sentinel is invisible but the observer
              kicks in 200px before it scrolls into view, so the next batch
              is ready by the time the user reaches it. */}
          {hasMore ? (
            <div
              ref={sentinelRef}
              aria-hidden="true"
              style={{ height: 1, margin: "8px 0 24px" }}
            />
          ) : (
            <div
              style={{
                textAlign: "center",
                padding: "16px 12px 24px",
                color: "var(--ink-mute)",
                fontSize: 13,
                fontFamily: "var(--font-caveat), cursive",
                fontWeight: 500,
              }}
            >
              fim do catálogo 💜 — {filtered.length}{" "}
              {filtered.length === 1 ? "presente" : "presentes"}
              {scope !== "todos" ? ` em ${activeLabel}` : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── Add gift modal — tabbed CATÁLOGO + PERSONALIZADO ─── */
function AddGiftModal({
  defaultTab,
  onClose,
  onSubmitPersonalizado,
  onSubmitCatalogo,
  submitting,
}: {
  defaultTab: AddTab;
  onClose: () => void;
  onSubmitPersonalizado: (draft: DraftFields) => void;
  onSubmitCatalogo: (items: ListaCatalogItem[]) => void;
  submitting: boolean;
}) {
  const [tab, setTab] = useState<AddTab>(defaultTab);
  const [f, setF] = useState<DraftFields>(emptyDraft);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const catalog = useMemo(() => loadCatalog(), []);

  const personPriceNum = parseFloat(f.price.replace(",", ".")) || 0;
  const personValid = f.title.trim().length > 0 && personPriceNum > 0;

  const selectedItems = useMemo(() => {
    const out: ListaCatalogItem[] = [];
    catalog.forEach((sec) =>
      sec.items.forEach((it) => {
        if (selected.has(it.id)) out.push(it);
      }),
    );
    return out;
  }, [catalog, selected]);
  // aperture-p73kv — mirror the picker's djb2-derived "sugerido N un"
  // (display + submit) on the running total so the footer R$ amount
  // doesn't drift from what the user sees per card.
  const catTotal = selectedItems.reduce(
    (s, i) => s + i.price * defaultSuggestedQty(i.id),
    0,
  );

  const toggleCatItem = (it: ListaCatalogItem) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(it.id)) next.delete(it.id);
      else next.add(it.id);
      return next;
    });
  };

  const submitPersonalizado = () => {
    if (!personValid || submitting) return;
    onSubmitPersonalizado({ ...f, title: f.title.trim() });
  };

  const submitCatalogo = () => {
    if (selectedItems.length === 0 || submitting) return;
    onSubmitCatalogo(selectedItems);
  };

  return (
    <Modal onClose={onClose}>
      <div className="lista-modal-head">
        <div>
          <span className="eyebrow coral">um novo presente ♡</span>
          <h3>
            Adicionar à minha <span className="hl">lista</span>
          </h3>
        </div>
        <button type="button" className="lista-modal-x" onClick={onClose} aria-label="Fechar">
          {icon.x}
        </button>
      </div>

      <div className="lista-tabs" role="tablist" aria-label="Modo de adicionar">
        <button
          type="button"
          role="tab"
          id="lista-tab-catalogo"
          aria-selected={tab === "catalogo"}
          aria-controls="lista-tabpanel-catalogo"
          className={"lista-tab" + (tab === "catalogo" ? " is-active" : "")}
          onClick={() => setTab("catalogo")}
        >
          Catálogo
        </button>
        <button
          type="button"
          role="tab"
          id="lista-tab-personalizado"
          aria-selected={tab === "personalizado"}
          aria-controls="lista-tabpanel-personalizado"
          className={"lista-tab" + (tab === "personalizado" ? " is-active" : "")}
          onClick={() => setTab("personalizado")}
        >
          Personalizado
        </button>
      </div>

      <div className="lista-modal-body">
        {tab === "catalogo" ? (
          <div
            role="tabpanel"
            id="lista-tabpanel-catalogo"
            aria-labelledby="lista-tab-catalogo"
          >
            <CatalogoView selected={selected} onToggle={toggleCatItem} />
          </div>
        ) : (
          <div
            role="tabpanel"
            id="lista-tabpanel-personalizado"
            aria-labelledby="lista-tab-personalizado"
          >
            <PersonalizadoForm f={f} setF={setF} showBanner />
          </div>
        )}
      </div>

      <div className="lista-modal-foot">
        {tab === "catalogo" ? (
          <div className="lista-sel-count">
            {selectedItems.length === 0 ? (
              <>0 presentes selecionados</>
            ) : (
              <>
                {selectedItems.length}{" "}
                {selectedItems.length === 1 ? "presente selecionado" : "presentes selecionados"} ·{" "}
                <b>{brl(catTotal)}</b>
              </>
            )}
          </div>
        ) : (
          <div className="lista-sel-count">
            novo presente: <b>{f.title.trim() || "—"}</b>
          </div>
        )}
        <div className="lista-foot-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          {tab === "catalogo" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={selectedItems.length === 0 || submitting}
              onClick={submitCatalogo}
            >
              <span className="lista-btn-ic">{icon.plus}</span>{" "}
              {submitting ? "Adicionando..." : "Adicionar"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!personValid || submitting}
              onClick={submitPersonalizado}
            >
              <span className="lista-btn-ic">{icon.plus}</span>{" "}
              {submitting ? "Adicionando..." : "Adicionar à lista"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ─── Edit item modal (single form, no tabs) ─── */
function EditItemModal({
  initial,
  onClose,
  onSubmit,
  submitting,
}: {
  initial: DraftFields;
  onClose: () => void;
  onSubmit: (draft: DraftFields) => void;
  submitting: boolean;
}) {
  const [f, setF] = useState<DraftFields>(initial);
  const priceNum = parseFloat(f.price.replace(",", ".")) || 0;
  const valid = f.title.trim().length > 0 && priceNum > 0;
  const previewTotal = priceNum * (Number(f.qty) || 0);

  const submit = () => {
    if (!valid || submitting) return;
    onSubmit({ ...f, title: f.title.trim() });
  };

  return (
    <Modal onClose={onClose}>
      <div className="lista-modal-head">
        <div>
          <span className="eyebrow coral">ajuste fininho ♡</span>
          <h3>Editar presente</h3>
        </div>
        <button type="button" className="lista-modal-x" onClick={onClose} aria-label="Fechar">
          {icon.x}
        </button>
      </div>
      <div className="lista-modal-body">
        <PersonalizadoForm f={f} setF={setF} />
      </div>
      <div className="lista-modal-foot">
        <div className="lista-sel-count">
          total estimado · <b>{brl(previewTotal)}</b>
        </div>
        <div className="lista-foot-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid || submitting}
            onClick={submit}
            data-testid="edit-save-btn"
          >
            {submitting ? "Salvando..." : "Salvar alterações"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Remove confirm ─── */
function ConfirmRemove({
  item,
  onClose,
  onConfirm,
  submitting,
}: {
  item: GroupedGift;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  return (
    <Modal onClose={onClose} sm>
      <div className="lista-modal-head">
        <div>
          <span className="eyebrow coral">tem certeza?</span>
          <h3>Remover este presente</h3>
        </div>
        <button type="button" className="lista-modal-x" onClick={onClose} aria-label="Fechar">
          {icon.x}
        </button>
      </div>
      <div className="lista-modal-body">
        <p className="lista-remove-text">
          <b>&ldquo;{item.nome}&rdquo;</b> será removido da sua lista
          {item.qty > 1 ? <> ({item.qty} unidades)</> : null}. Você pode adicionar de novo a
          qualquer momento.
        </p>
      </div>
      <div className="lista-modal-foot">
        <div className="lista-foot-actions lista-foot-actions-end">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Manter na lista
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={submitting}>
            {submitting ? "Removendo..." : "Sim, remover"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Preset detail modal (aperture-wo5ql) ─── */
function PresetDetailModal({
  preset,
  onClose,
  onSubmit,
  submitting,
}: {
  preset: ListaProntaDetail;
  onClose: () => void;
  onSubmit: (selected: PresetItem[]) => void;
  submitting: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preset.items.map((it) => it.id)),
  );

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedItems = preset.items.filter((it) => selected.has(it.id));
  // aperture-p73kv — same djb2-derived mirror as the catalogo path.
  const total = selectedItems.reduce(
    (s, it) => s + it.price * defaultSuggestedQty(it.id),
    0,
  );
  const count = selectedItems.length;

  const submit = () => {
    if (count === 0 || submitting) return;
    onSubmit(selectedItems);
  };

  return (
    // aperture-553no — wide modal so the 3-col curadoria grid isn't clipped.
    <Modal onClose={onClose} lg>
      <div className="lista-modal-head">
        <div>
          <span className="eyebrow">curadoria EuNeném</span>
          <h3>{preset.title}</h3>
          <p className="lista-preset-desc">{preset.description}</p>
        </div>
        <button type="button" className="lista-modal-x" onClick={onClose} aria-label="Fechar">
          {icon.x}
        </button>
      </div>

      <div className="lista-modal-body">
        <div className="lista-preset-section-label">
          O QUE TEM NESSA LISTA · {count} DE {preset.items.length} SELECIONADOS
        </div>
        <div className="lista-preset-grid">
          {preset.items.map((it) => {
            const on = selected.has(it.id);
            return (
              <button
                type="button"
                key={it.id}
                className={"lista-preset-item" + (on ? " is-selected" : "")}
                onClick={() => toggle(it.id)}
                aria-pressed={on}
                aria-label={`${on ? "Remover" : "Adicionar"} ${it.name}`}
              >
                <div
                  className="lista-preset-thumb"
                  style={{ background: it.bgColor }}
                  aria-hidden="true"
                >
                  {/* aperture-cdwdt: real product image when available, emoji fallback
                      otherwise. aperture-0xhs4: native lazy + async decoding so only
                      visible bundle thumbs hit the network/decoder when the modal
                      opens (bundles can have 30+ items). */}
                  {it.imageUrl ? (
                    <img
                      src={it.imageUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        borderRadius: "inherit",
                        display: "block",
                      }}
                    />
                  ) : (
                    <span className="lista-preset-emoji">{it.emoji}</span>
                  )}
                </div>
                <div className="lista-preset-meta">
                  <span className="lista-preset-name">{it.name}</span>
                  <span className="lista-preset-sub">
                    {brl(it.price)} · sugerido {defaultSuggestedQty(it.id)} un
                  </span>
                </div>
                <span
                  className={"lista-preset-check" + (on ? " is-on" : "")}
                  aria-hidden="true"
                >
                  {on && icon.check}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="lista-modal-foot">
        <div className="lista-sel-count">
          {count} {count === 1 ? "presente selecionado" : "presentes selecionados"} ·{" "}
          <b>{brl(total)}</b>
        </div>
        <div className="lista-foot-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={count === 0 || submitting}
            onClick={submit}
          >
            <span className="lista-btn-ic">{icon.heart}</span>
            {submitting ? "Adicionando..." : "Adicionar à minha lista →"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Skeleton (initial list load) ─── */
//
// aperture-0ph83 — same animate-pulse approach Vance used in tgkh3 navbar:
// blocked-out divs that match the eventual layout so there's no layout shift
// when the query resolves. Three card placeholders feel like "stuff is on
// the way" without committing to a count.
function ListaSkeleton() {
  return (
    <div className="lista-body" aria-busy="true" aria-live="polite">
      <section className="lista-header-card">
        <div className="lista-header-top">
          <h1>
            Minha <span className="hl">lista de presentes</span>
          </h1>
          <div
            aria-hidden="true"
            className="lista-skeleton-line"
            style={{
              height: 14,
              width: "60%",
              background: "var(--lilac-soft)",
              borderRadius: 6,
              opacity: 0.5,
              margin: "12px 0 16px",
            }}
          />
          <div className="lista-header-actions" aria-hidden="true">
            {[140, 200, 180].map((w, i) => (
              <div
                key={i}
                className="lista-skeleton-btn"
                style={{
                  height: 40,
                  width: w,
                  background: "var(--lilac-soft)",
                  borderRadius: 999,
                  opacity: 0.5,
                }}
              />
            ))}
          </div>
        </div>
      </section>
      <div className="lista-grid" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="lista-card"
            style={{
              minHeight: 240,
              background: "var(--paper)",
              opacity: 0.5,
              animation: "pulse 1.6s ease-in-out infinite",
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── Error banner (list query failure) ─── */
function ListaErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="lista-body">
      <section className="lista-header-card">
        <div className="lista-header-top">
          <span className="eyebrow coral">opa</span>
          <h1>
            Não rolou de carregar <span className="hl">sua lista</span>
          </h1>
          <p className="lista-header-sub">
            Algo travou aqui do nosso lado — bora tentar de novo?
          </p>
          <div className="lista-header-actions">
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              <span className="lista-btn-ic">{icon.alert}</span> Tentar de novo
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ─── Body ─── */
export function ListaPresentesBody({ slug }: PainelSectionBodyProps) {
  void slug; // session-driven on the server; slug here is just for routing.

  const listQuery = useContribuicaoList();
  const createMut = useContribuicaoCreate();
  const createBulkMut = useContribuicaoCreateBulk();
  const deleteMut = useContribuicaoDelete();
  const updateMut = useContribuicaoUpdate();

  const [search, setSearch] = useState("");
  const [cat, setCat] = useState<CatFilter>("all");
  const [addModalTab, setAddModalTab] = useState<AddTab | null>(null);
  const [editItem, setEditItem] = useState<GroupedGift | null>(null);
  const [removeItem, setRemoveItem] = useState<GroupedGift | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetDetail, setPresetDetail] = useState<ListaProntaId | null>(null);

  const listasProntas = useMemo(() => loadListasProntas(), []);

  const items = useMemo<GroupedGift[]>(
    () => groupContribuicoes(listQuery.data ?? []),
    [listQuery.data],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    items.forEach((i) => {
      c[i.category] = (c[i.category] || 0) + 1;
    });
    return c;
  }, [items]);

  const order = useMemo<CatFilter[]>(
    () => ["all", ...CATEGORY_OPTIONS.filter((k) => counts[k])],
    [counts],
  );

  const filtered = items.filter((i) => {
    if (cat !== "all" && i.category !== cat) return false;
    if (search && !i.nome.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const claimedUnits = items.reduce((s, i) => s + i.received, 0);
  const totalUnits = items.reduce((s, i) => s + i.qty, 0);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const addItem = async (draft: DraftFields) => {
    const price = parseFloat(draft.price.replace(",", ".")) || 0;
    try {
      await createMut.mutateAsync({
        nome: draft.title,
        valor: centsFromBRL(price),
        // aperture-tua9o — the uploaded item image (publicUrl) when present,
        // else undefined (optional; item falls back to the emoji thumb).
        imagemUrl: draft.imageUrl ?? undefined,
        grupo: draft.category,
        // aperture-33ien — mutation field is `quantidade`, not `qty` (the wrong
        // key was masked behind the imagemUrl error in the same object literal).
        quantidade: Number(draft.qty) || 1,
      });
      setAddModalTab(null);
      const n = Number(draft.qty) || 1;
      toast.success(
        n === 1
          ? "1 presente adicionado à sua lista ♡"
          : `${n} presentes adicionados à sua lista ♡`,
      );
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  const addCatalogItems = async (picked: ListaCatalogItem[]) => {
    try {
      await createBulkMut.mutateAsync({
        // Plan 0016 (aperture-putz5): one ROW per catalog item with
        // `quantidade=suggestedQty`. Pre-0016 this fanned out into
        // suggestedQty rows per item — locked decision #1 retires that.
        //
        // aperture-p73kv: `it.suggestedQty` from the catalog data is
        // a static `1`, which surfaces as "sugerido 1 un" on the picker
        // — unrealistic for typical baby-shower lists. The display uses
        // `defaultSuggestedQty(it.id)` (djb2-derived 5–10) and the
        // submit MUST mirror that same value or the actual list
        // count diverges from what the user saw. Inline stepper +
        // per-card override is the next layer (filed as follow-up).
        items: picked.map((it) => ({
          nome: it.name,
          valor: centsFromBRL(it.price),
          // aperture-cdwdt: catalog items now carry real local product image
          // paths (e.g. "/products/1468.jpg"). 67 of 355 items still have a
          // null imageUrl from the dead cdnna.eunenem.com domain — those fall
          // back to the emoji glyph the UI derives from `grupo`. `null` would
          // fail the server's z.string().url() validator, so we pass undefined
          // to keep the field unset for image-less items.
          imagemUrl: it.imageUrl ?? undefined,
          grupo: it.category,
          quantidade: defaultSuggestedQty(it.id),
        })),
      });
      setAddModalTab(null);
      const totalUnits = picked.reduce(
        (s, it) => s + defaultSuggestedQty(it.id),
        0,
      );
      toast.success(
        totalUnits === 1
          ? "1 presente adicionado à sua lista ♡"
          : `${totalUnits} presentes adicionados à sua lista ♡`,
      );
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  const addPresetItems = async (picked: PresetItem[], presetId: ListaProntaId) => {
    try {
      await createBulkMut.mutateAsync({
        // Plan 0016 (aperture-putz5): one ROW per preset item with
        // `quantidade=suggestedQty`. Aperture-1l37i frontend follow-up
        // covers the grouping/saveEdit UX rewrite around this shape.
        //
        // aperture-p73kv: mirror the picker's djb2-derived display
        // value (same helper, same itemId → same N ∈ [5,10]).
        items: picked.map((it) => ({
          nome: it.name,
          valor: centsFromBRL(it.price),
          // aperture-cdwdt: preset items carry real /products/<id>.<ext>
          // paths; null falls back to the emoji glyph UI-side. See note in
          // addCatalogItems for the undefined-vs-null reasoning.
          imagemUrl: it.imageUrl ?? undefined,
          grupo: presetId,
          quantidade: defaultSuggestedQty(it.id),
        })),
      });
      setPresetDetail(null);
      setPresetsOpen(false);
      // aperture-p73kv — toast count mirrors the per-item djb2 helper.
      const n = picked.reduce((s, it) => s + defaultSuggestedQty(it.id), 0);
      toast.success(
        `${n} ${n === 1 ? "presente adicionado" : "presentes adicionados"} à sua lista ♡`,
      );
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  // Plan 0016 / aperture-1l37i + aperture-1saoe — fully atomic edit.
  //
  // Rex's aperture-putz5 engine PR (#176) extended
  // AtualizarContribuicaoInputSchema to accept quantidade end-to-end, so
  // EVERY edit — including qty changes — now flows through a single
  // `contribuicao.update` Network round-trip. Preserves the
  // contribuicao.id across the edit (critical for the
  // intencao_items.idContribuicao FK introduced by Plan 0016), emits
  // ONE request instead of the pre-1l37i 5-request cascade, and avoids
  // the broken legacy delete+createBulk path which was 400'ing under
  // Rex's post-rename schema (aperture-1saoe P0 regression).
  //
  // The (now-retired) legacy path was: delete(ids) → createBulk(...).
  // It survived briefly during the parallel-work window between
  // aperture-1l37i and aperture-putz5 to cover qty changes. Once
  // aperture-putz5 merged, the fallback became unnecessary; once the
  // create-flow schema rename shipped, it became actively broken. This
  // change retires it in saveEdit only — delete + createBulk hooks
  // remain wired for confirmRemove + the addCatalogItems / addPresetItems
  // create flows, which still need them.
  //
  // Multi-id legacy groups (operator's pre-0016 7-Fralda data) still
  // patch through the first underlying id — the entity itself carries
  // quantidade, so we update the representative row's fields and the
  // group's other rows stay untouched. Operator's mental model is the
  // group; the underlying data drift is invisible to them.
  //
  // Recovery on NOT_FOUND: when the stable id no longer exists server-
  // side (sibling tab deleted, DB reset, etc.) the toast surfaces a
  // calmer "essa lista mudou — atualizamos para você" message + the list
  // refetches so the user can retry against fresh data. The pre-1l37i
  // flow landed on a dead-end "esse presente não existe mais" toast with no
  // refetch.
  const saveEdit = async (draft: DraftFields) => {
    if (!editItem) return;
    const price = parseFloat(draft.price.replace(",", ".")) || 0;
    const newQty = Number(draft.qty) || 1;
    // aperture-qxntg follow-up — `editItem.emoji` is a UI-only display
    // fallback derived from the grupo when the row has no real image
    // URL. It MUST NOT be sent as the wire value: ImagemUrlSchema
    // requires `/^(\/|https?:\/\/)/` and a glyph like "🪒" fails zod,
    // returning a 400 on update. Operator's "Kit Tesoura e Cortador de
    // Unha" repro (no imageUrl, emoji fallback) hit exactly this. The
    // update mutation accepts `imagemUrl: ImagemUrlSchema.nullable()`
    // — `null` is the right "no image" wire value.
    // aperture-tua9o — honor the edited image (draft.imageUrl): the edit form
    // pre-fills it from the item, so unchanged = same value, and a new upload /
    // removal flows through. Still NEVER the emoji glyph (draft.imageUrl is a
    // real publicUrl or null, never an emoji).
    const imagemUrl = draft.imageUrl ?? null;
    const idToUpdate = editItem.ids[0];
    if (!idToUpdate) {
      toast.error("Não consegui identificar esse presente — recarrega a página ♡");
      return;
    }
    try {
      await updateMut.mutateAsync({
        id: idToUpdate,
        nome: draft.title,
        valor: centsFromBRL(price),
        imagemUrl,
        grupo: draft.category,
        quantidade: newQty,
      });
      setEditItem(null);
      toast.success("Alterações salvas ♡");
    } catch (err) {
      const error = toContribuicaoError(err);
      // Stale-row recovery: the slot was deleted between the visitor's
      // fetch + this edit. Invalidate so the next render reflects
      // reality + nudge the visitor with a calmer message than the
      // dead-end "esse presente não existe mais" the legacy flow used.
      if (error.kind === "not-found") {
        void listQuery.refetch();
        setEditItem(null);
        toast("essa lista mudou — atualizamos para você ♡");
        return;
      }
      toast.error(contribuicaoErrorMessage(error));
    }
  };

  const confirmRemove = async () => {
    if (!removeItem) return;
    try {
      await deleteMut.mutateAsync({ ids: removeItem.ids });
      toast("Presente removido");
      setRemoveItem(null);
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  // ── Initial loading + error gates ────────────────────────────────────────

  if (listQuery.isPending) {
    return <ListaSkeleton />;
  }
  if (listQuery.error) {
    return <ListaErrorBanner onRetry={() => void listQuery.refetch()} />;
  }

  const addSubmitting = createMut.isPending || createBulkMut.isPending;
  // Plan 0016 / aperture-1saoe: edit submission is now a single atomic
  // contribuicao.update call. The legacy delete+createBulk path retired
  // once Rex's engine accepted quantidade in update; tracking those
  // mutations for editSubmitting would surface false-positive spinners
  // when ConfirmRemove or the addCatalogItems / addPresetItems flows
  // are in-flight.
  const editSubmitting = updateMut.isPending;
  const removeSubmitting = deleteMut.isPending;
  const presetSubmitting = createBulkMut.isPending;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="lista-body">
      {/* Header card */}
      <section className="lista-header-card">
        <div className="lista-header-top">
          <h1>
            Minha <span className="hl">lista de presentes</span>
          </h1>
          <p className="lista-header-sub">
            <b>
              {claimedUnits} de {totalUnits}
            </b>{" "}
            presentes já recebidos
          </p>
          <div className="lista-header-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAddModalTab("catalogo")}
            >
              <span className="lista-btn-ic">{icon.plus}</span> Adicionar presente
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAddModalTab("personalizado")}
              aria-label="Criar item personalizado"
            >
              <span className="lista-btn-ic">{icon.sparkle}</span> Criar item personalizado
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setPresetsOpen((v) => !v)}
              aria-label="Usar lista pronta"
              aria-expanded={presetsOpen}
              aria-controls="lista-prontas-panel"
            >
              <span className="lista-btn-ic">{icon.listLines}</span>
              Usar lista pronta
              <span
                className="lista-btn-ic"
                style={{
                  transform: presetsOpen ? "rotate(180deg)" : "none",
                  transition: "transform 0.2s ease",
                }}
              >
                {icon.caretDown}
              </span>
            </button>
          </div>
          {presetsOpen && (
            <div
              id="lista-prontas-panel"
              className="lista-prontas-panel"
              role="region"
              aria-label="Listas prontas curadas"
            >
              <span className="eyebrow">listas prontas pra começar</span>
              <h2 className="lista-prontas-title">
                Curadoria com o <span className="hl">essencial para cada fase</span>
              </h2>
              <p className="lista-prontas-sub">Toque pra ver os presentes antes de adicionar.</p>
              <div className="lista-prontas-grid">
                {LISTA_PRONTAS.map((preset) => {
                  const detail = listasProntas[preset.id];
                  const itemCount = detail?.items.length ?? 0;
                  // aperture-cdwdt: title/desc/cover now live in the JSON
                  // template — UI only carries the emoji + tile-tint deltas.
                  // Fall back to safe defaults if the loader is somehow stale.
                  const title = detail?.title ?? preset.id;
                  const desc = detail?.description ?? "";
                  const cover = detail?.imageUrl ?? null;
                  return (
                    <article key={preset.id} className="lista-pronta-card">
                      <div
                        className="lista-pronta-icon"
                        style={{ background: preset.tileVar }}
                        aria-hidden="true"
                      >
                        {cover ? (
                          <img
                            src={cover}
                            alt=""
                            loading="lazy"
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                              borderRadius: "inherit",
                              display: "block",
                            }}
                          />
                        ) : (
                          <span>{preset.emoji}</span>
                        )}
                      </div>
                      <h3 className="lista-pronta-title">{title}</h3>
                      <p className="lista-pronta-desc">{desc}</p>
                      <div className="lista-pronta-foot">
                        <span className="lista-pronta-count">
                          {itemCount} {itemCount === 1 ? "item" : "itens"}
                        </span>
                        <button
                          type="button"
                          className="lista-pronta-cta"
                          onClick={() => setPresetDetail(preset.id)}
                          aria-label={`Ver lista pronta: ${title}`}
                        >
                          VER LISTA →
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      {items.length > 0 && <Visor items={items} />}

      <div className="lista-group-title">
        <span>
          os presentes da sua lista
        </span>
      </div>

      <div className="lista-frame">
        {items.length > 0 && (
          <div className="lista-toolbar">
            <div className="lista-search">
              {icon.search}
              <input
                type="text"
                placeholder="buscar na minha lista…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Buscar presente"
              />
            </div>
            {/* aperture-oa0th — category filter chips (todos / fraldas / outros …)
                hidden (visual-only). The filter logic is intact: `cat` still
                defaults to "all" so the list shows every gift, and `filtered`
                continues to apply `cat`/`search`. Kept behind `{false && …}` so
                `cat`/`setCat`/`order`/`counts` stay wired and the chips can be
                restored by flipping the flag. */}
            {false && (
              <div className="lista-chips">
                {order.map((k) => (
                  <button
                    type="button"
                    key={k}
                    className={"lista-chip" + (cat === k ? " active" : "")}
                    onClick={() => setCat(k)}
                  >
                    {k === "all" ? "todos" : LISTA_CATEGORY_LABEL[k]}
                    <span className="lista-chip-count">{counts[k] || 0}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {items.length === 0 ? (
          <div className="lista-empty">
            <div className="lista-empty-doodle">{icon.heart}</div>
            <span className="eyebrow coral">primeira página em branco ♡</span>
            <h3>Sua lista está pronta pra começar</h3>
            <p>Adicione os presentes que vão contar a história do seu bebê.</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAddModalTab("catalogo")}
            >
              <span className="lista-btn-ic">{icon.plus}</span> Adicionar primeiro item
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="lista-empty lista-empty-sm">
            <span className="eyebrow coral">nada por aqui</span>
            <h3>Nenhum presente encontrado</h3>
            <p>Tente outra busca ou categoria.</p>
          </div>
        ) : (
          <div className="lista-grid">
            {filtered.map((it) => (
              <GiftCard
                key={it.nome}
                item={it}
                onEdit={setEditItem}
                onRemove={setRemoveItem}
              />
            ))}
            <button
              type="button"
              className="lista-card lista-card-add"
              onClick={() => setAddModalTab("catalogo")}
            >
              <span className="lista-card-add-plus">{icon.plus}</span>
              <span className="lista-card-add-label">adicionar outro presente</span>
              <span className="lista-card-add-sub">um novo presente pra lista</span>
            </button>
          </div>
        )}
      </div>

      {addModalTab && (
        <AddGiftModal
          defaultTab={addModalTab}
          onClose={() => setAddModalTab(null)}
          onSubmitPersonalizado={addItem}
          onSubmitCatalogo={addCatalogItems}
          submitting={addSubmitting}
        />
      )}
      {editItem && (
        <EditItemModal
          initial={{
            title: editItem.nome,
            price: editItem.price.toFixed(2).replace(".", ","),
            qty: editItem.qty,
            category: editItem.category,
            // aperture-tua9o — pre-fill the existing image so editing keeps it
            // (and lets the user change/remove it via the same control).
            imageUrl: editItem.imageUrl ?? null,
          }}
          onClose={() => setEditItem(null)}
          onSubmit={saveEdit}
          submitting={editSubmitting}
        />
      )}
      {removeItem && (
        <ConfirmRemove
          item={removeItem}
          onClose={() => setRemoveItem(null)}
          onConfirm={confirmRemove}
          submitting={removeSubmitting}
        />
      )}
      {presetDetail && listasProntas[presetDetail] && (
        <PresetDetailModal
          preset={listasProntas[presetDetail]}
          onClose={() => setPresetDetail(null)}
          onSubmit={(selected) => void addPresetItems(selected, presetDetail)}
          submitting={presetSubmitting}
        />
      )}
    </div>
  );
}
