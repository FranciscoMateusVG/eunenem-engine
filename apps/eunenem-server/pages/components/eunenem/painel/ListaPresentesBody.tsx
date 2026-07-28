import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

// aperture-tua9o — image upload+crop for the custom ("personalizado") item form.
import { ItemImageUpload } from './ItemImageUpload';

import { sendEvent } from '@/lib/analytics';
import {
  brlFromCents,
  type ContribuicaoDTO,
  centsFromBRL,
  contribuicaoErrorMessage,
  deriveBgColor,
  parseValorBRL,
  toContribuicaoError,
  useContribuicaoCreate,
  useContribuicaoCreateBulk,
  useContribuicaoDelete,
  useContribuicaoList,
  useContribuicaoUpdate,
} from '@/lib/contribuicao.js';
import type { PainelSectionBodyProps } from '@/PainelSectionPage';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '@/lib/trpc.js';
import type { AppRouter } from '../../../../server/trpc/router.js';

// aperture-tb0rh F2 — the customer /painel catalog read-path now reads the LIVE
// tRPC procs (trpc.catalogo.listSections / listListasProntas) instead of the
// client-bundled JSON loaders, so admin catalog CRUD propagates to /painel. The
// inferred Pub types below replace the retired loader types (ListaCatalogItem /
// ListaProntaDetail / ListaProntaId / PresetItem / ListaCategory).
type RouterOutputs = inferRouterOutputs<AppRouter>;
type CatalogSection = RouterOutputs['catalogo']['listSections'][number];
type CatalogItem = CatalogSection['items'][number];
type ListaProntaPub = RouterOutputs['catalogo']['listListasProntas'][string];
type PresetItemPub = ListaProntaPub['items'][number];

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
  'R$ ' +
  n.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// aperture-0ph83 / aperture-cdwdt — UI vocabulary for the category chips/badges.
// Kept in code (not in templates JSON) per operator decision on aperture-cwcn0.
// `outros` + `brinquedo` added in aperture-cdwdt when the real eunenem catalog
// taxonomy landed. `personalizado` stays in the local options list because the
// PersonalizadoForm uses it as the default category for user-authored items
// (the seed catalog itself never contains personalizado — validator enforces).
// aperture-tb0rh F2 — categories are open strings now (DB-driven catalog). This
// map is a FALLBACK label lookup for the 9 legacy slugs; unknown slugs fall
// through to the raw value at the call sites.
const LISTA_CATEGORY_LABEL: Record<string, string> = {
  fraldas: 'fraldas',
  higiene: 'higiene',
  roupa: 'roupinhas',
  soninho: 'soninho',
  alimentacao: 'alimentação',
  passeio: 'passeio',
  brinquedo: 'brinquedos',
  outros: 'outros',
  personalizado: 'personalizado',
};

const CATEGORY_OPTIONS: string[] = [
  'fraldas',
  'higiene',
  'roupa',
  'soninho',
  'alimentacao',
  'passeio',
  'brinquedo',
  'outros',
  'personalizado',
];

/* ─── Icons (stroke style) ─── */
const icon = {
  plus: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  search: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  edit: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 2l4 4-13 13H5v-4z" />
    </svg>
  ),
  trash: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    </svg>
  ),
  x: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  heart: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  ),
  sparkle: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  ),
  listLines: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  ),
  caretDown: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  check: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 5 5L20 7" />
    </svg>
  ),
  alert: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  ),
};

// aperture-g70uv / aperture-0ph83 / aperture-cdwdt / aperture-tb0rh F2 — visual
// identity overlay for the curated preset cards surfaced by the "Usar lista
// pronta" panel. Title + description + cover imageUrl + item count all come from
// the LIVE tRPC detail at render time. The presets themselves are now dynamic
// (keyed by the wire record), so this is a per-slug style lookup (emoji +
// backdrop tint) with a safe fallback for slugs the UI doesn't have art for.
const PRESET_TILE_STYLE: Record<string, { emoji: string; tileVar: string }> = {
  'ilustrativa-especial': { emoji: '👕', tileVar: 'var(--lilac-soft)' },
  'cha-de-fralda': { emoji: '🧷', tileVar: 'var(--pink-soft)' },
  'cha-de-rifa': { emoji: '🎁', tileVar: 'var(--yellow-soft)' },
  ilustrativa: { emoji: '✨', tileVar: 'var(--cream-2)' },
  carrinhos: { emoji: '🚼', tileVar: 'var(--blue-soft)' },
};
const PRESET_TILE_FALLBACK = { emoji: '🎁', tileVar: 'var(--cream-2)' };

type CatFilter = string;
type AddTab = 'catalogo' | 'personalizado';

interface DraftFields {
  title: string;
  price: string;
  qty: number;
  category: string;
  // aperture-tua9o — optional uploaded image (publicUrl) for the custom item.
  imageUrl: string | null;
}

function emptyDraft(): DraftFields {
  return { title: '', price: '', qty: 1, category: 'personalizado', imageUrl: null };
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
  category: string;
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

// aperture-intake-grxsh-followup — `imagemUrl` is an image when it starts with
// `/` (same-origin) or `http(s)://`. Anything else (a stray emoji from legacy
// rows, etc.) is treated as text content. Mirrors the catalog modal's
// it.imageUrl rendering at line ~1176.
const isImagePath = (v: string | null | undefined): v is string =>
  typeof v === 'string' && /^(\/|https?:\/\/)/.test(v);

function groupContribuicoes(items: ContribuicaoDTO[]): GroupedGift[] {
  const map = new Map<string, GroupedGift>();
  for (const c of items) {
    // aperture-intake-grxsh-followup — Only collapse to "personalizado" when
    // the category is genuinely a known one we want to style as a chip. For
    // unknown grupos (e.g. lista-pronta IDs like "ilustrativa" that the seed
    // path stuffed into the column) we use "outros" as the typed bucket but
    // render the raw grupo as the chip text below — see chipLabel.
    const category: string =
      typeof c.grupo === 'string' && c.grupo.trim() !== '' ? c.grupo : 'outros';
    // aperture-tb0rh F2 — categories are open strings; prefer a known pt-BR
    // label, else surface the raw slug, else "outros" for null/empty grupos.
    // The index access is guarded by the string-narrow so `c.grupo` (string |
    // null) can't index the label map as null.
    const chipLabel =
      typeof c.grupo === 'string' && c.grupo.trim() !== ''
        ? (LISTA_CATEGORY_LABEL[c.grupo] ?? c.grupo.toLowerCase())
        : 'outros';
    const imageUrl = isImagePath(c.imagemUrl) ? c.imagemUrl : null;
    const emoji = imageUrl ? '🎁' : (c.imagemUrl ?? '🎁');
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
        custom: c.grupo === 'personalizado',
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
          <div className="lista-visor-fill" style={{ width: pct + '%' }}>
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
          {items.length} {items.length === 1 ? 'presente' : 'presentes'}
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
    ? 'não dá pra mexer — algum presente desse grupo já foi reservado ♡'
    : undefined;
  return (
    <div className={'lista-card' + (isComplete ? ' is-complete' : '')} data-testid="lista-card">
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
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              borderRadius: 'inherit',
              display: 'block',
            }}
          />
        ) : (
          <span className="lista-card-emoji" aria-hidden="true">
            {item.emoji}
          </span>
        )}
        {/* aperture — category badge hidden (visual-only), mirroring the
            aperture-oa0th pattern applied elsewhere in this file (CATEGORIA
            field + filter chips). The underlying category data model stays
            intact (chipLabel/category still computed in groupContribuicoes)
            in case this is reactivated later. */}
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
          <i style={{ width: pct + '%' }} />
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
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);
  return (
    <div className="lista-scrim" onClick={onClose}>
      <div
        className={'lista-modal' + (sm ? ' lista-modal-sm' : '') + (lg ? ' lista-modal-lg' : '')}
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
          <span className="lista-info-banner-ic" aria-hidden="true">
            {icon.sparkle}
          </span>
          <div className="lista-info-banner-text">
            <strong>Algo único da sua história?</strong>
            <p>
              Adicione presentes que não estão no catálogo — uma cadeirinha específica, decoração do
              quartinho ou aquele item dos sonhos.
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
              onChange={(e) => setF({ ...f, qty: Number(e.target.value.replace(/\D/g, '')) || 1 })}
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
              onChange={(e) => setF({ ...f, category: e.target.value })}
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
        <ItemImageUpload value={f.imageUrl} onChange={(url) => setF({ ...f, imageUrl: url })} />
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

// aperture-tb0rh F2 — fallback chip emoji for the 9 legacy slugs; the picker
// guards unknown slugs with `?? '🎁'`.
const CATEGORY_CHIP_EMOJI: Record<string, string> = {
  fraldas: '🧷',
  higiene: '🧴',
  roupa: '👕',
  soninho: '🛏️',
  alimentacao: '🍼',
  passeio: '🚼',
  brinquedo: '🧸',
  outros: '🎁',
  personalizado: '✨',
};

type CatScope = string;
const PAGE_SIZE = 24;

function CatalogoView({
  catalog,
  selected,
  onToggle,
  disabled = false,
}: {
  // aperture-tb0rh F2 — catalog sections come from the LIVE tRPC proc
  // (trpc.catalogo.listSections), threaded down from the body via AddGiftModal.
  catalog: CatalogSection[];
  selected: Set<string>;
  onToggle: (item: CatalogItem) => void;
  // aperture-wpsfp — when the catalog is syncing/errored, the item buttons are
  // disabled so a stale (about-to-change) product can't be picked mid-sync.
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<CatScope>('todos');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Build the flat all-items list + per-category buckets once. Section labels
  // double as chip labels (one source of truth for pt-BR vocabulary).
  const allItems = useMemo(() => catalog.flatMap((sec) => sec.items), [catalog]);
  const chips = useMemo(() => {
    const list: Array<{ scope: CatScope; label: string; emoji: string; count: number }> = [
      { scope: 'todos', label: 'todos', emoji: '✨', count: allItems.length },
    ];
    for (const sec of catalog) {
      list.push({
        scope: sec.category,
        label: sec.label,
        emoji: CATEGORY_CHIP_EMOJI[sec.category] ?? '🎁',
        count: sec.items.length,
      });
    }
    return list;
  }, [catalog, allItems.length]);

  // Pool of items in the selected scope, then the search filter on top of that.
  const q = search.trim().toLowerCase();
  const pool = useMemo(() => {
    if (scope === 'todos') return allItems;
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
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') break;
      scrollRoot = scrollRoot.parentElement;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => Math.min(filtered.length, c + PAGE_SIZE));
        }
      },
      { root: scrollRoot, rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, filtered.length]);

  const activeLabel = chips.find((c) => c.scope === scope)?.label ?? 'todos';

  return (
    <div className="lista-catalogo">
      <div className="lista-cat-search">
        <span className="lista-cat-search-ic" aria-hidden="true">
          {icon.search}
        </span>
        <input
          type="text"
          placeholder={
            scope === 'todos'
              ? 'buscar no catálogo (fralda, mamadeira...)'
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
          display: 'flex',
          gap: 8,
          overflowX: 'auto',
          padding: '8px 2px 12px',
          position: 'sticky',
          top: 0,
          zIndex: 2,
          background: 'var(--paper)',
          margin: '0 -2px',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
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
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: 999,
                border: active ? '1.5px solid var(--lilac-deep)' : '1.5px solid var(--lilac-soft)',
                background: active ? 'var(--lilac-soft)' : 'var(--paper)',
                color: active ? 'var(--plum)' : 'var(--ink-soft)',
                fontFamily: 'var(--font-dm-sans), system-ui, sans-serif',
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 120ms cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <span aria-hidden="true">{chip.emoji}</span>
              <span>{chip.label}</span>
              <span
                aria-hidden="true"
                style={{
                  fontSize: 11,
                  color: active ? 'var(--lilac-deep)' : 'var(--ink-mute)',
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
          {scope === 'todos' ? (
            <p>
              Tente outra palavra — ou monte o presente pela aba <b>personalizado</b>.
            </p>
          ) : (
            <p>
              Nenhum presente em <b>{activeLabel}</b> pra essa busca.{' '}
              <button
                type="button"
                onClick={() => setScope('todos')}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--lilac-deep)',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  font: 'inherit',
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
                    className={'lista-cat-item' + (on ? ' is-selected' : '')}
                    onClick={() => onToggle(it)}
                    aria-pressed={on}
                    disabled={disabled}
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
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            borderRadius: 'inherit',
                            display: 'block',
                          }}
                        />
                      ) : (
                        <span className="lista-cat-emoji" aria-hidden="true">
                          {it.emoji}
                        </span>
                      )}
                    </span>
                    <span className="lista-cat-meta">
                      <span className="lista-cat-name">{it.name}</span>
                      <span className="lista-cat-sub">
                        {brl(it.price)} · sugerido {it.suggestedQty} un
                      </span>
                    </span>
                    <span className={'lista-cat-check' + (on ? ' is-on' : '')} aria-hidden="true">
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
            <div ref={sentinelRef} aria-hidden="true" style={{ height: 1, margin: '8px 0 24px' }} />
          ) : (
            <div
              style={{
                textAlign: 'center',
                padding: '16px 12px 24px',
                color: 'var(--ink-mute)',
                fontSize: 13,
                fontFamily: 'var(--font-caveat), cursive',
                fontWeight: 500,
              }}
            >
              fim do catálogo 💜 — {filtered.length}{' '}
              {filtered.length === 1 ? 'presente' : 'presentes'}
              {scope !== 'todos' ? ` em ${activeLabel}` : ''}
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
  catalog,
  catalogLoading,
  catalogSyncing,
  catalogError,
  onRetryCatalog,
}: {
  defaultTab: AddTab;
  onClose: () => void;
  onSubmitPersonalizado: (draft: DraftFields) => void;
  onSubmitCatalogo: (items: CatalogItem[]) => void;
  submitting: boolean;
  // aperture-tb0rh F2 — catalog is fetched once in the body (trpc.catalogo
  // .listSections) and threaded down. The picker renders its own inline
  // loading/error state so it NEVER shows an empty grid while the catalog is
  // still loading or errored (surface-fetch-errors: error ≠ empty).
  catalog: CatalogSection[];
  catalogLoading: boolean;
  // aperture-wpsfp — true while a BACKGROUND poll of listSections is in flight
  // (catalogQuery.isFetching). While the catalog is syncing OR errored, item
  // controls + submit are disabled so a stale (about-to-change) product can't be
  // selected or submitted mid-sync.
  catalogSyncing: boolean;
  catalogError: boolean;
  onRetryCatalog: () => void;
}) {
  const [tab, setTab] = useState<AddTab>(defaultTab);
  const [f, setF] = useState<DraftFields>(emptyDraft);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const personPriceNum = parseValorBRL(f.price);
  const personValid = f.title.trim().length > 0 && personPriceNum > 0;

  const selectedItems = useMemo(() => {
    const out: CatalogItem[] = [];
    catalog.forEach((sec) =>
      sec.items.forEach((it) => {
        if (selected.has(it.id)) out.push(it);
      }),
    );
    return out;
  }, [catalog, selected]);

  // aperture-wpsfp — reconcile the selection against the live catalog. When a
  // product disappears (admin deactivate lands via the poll), drop its id from
  // `selected` so it can't RESURRECT into the selection if the product is
  // reactivated later. selectedItems already excludes absent ids from the
  // submit payload; this prunes the id itself so reactivation doesn't re-add it.
  useEffect(() => {
    const validIds = new Set<string>();
    catalog.forEach((sec) => sec.items.forEach((it) => validIds.add(it.id)));
    setSelected((cur) => {
      let changed = false;
      const next = new Set<string>();
      cur.forEach((id) => {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : cur;
    });
  }, [catalog]);

  // aperture-wpsfp — catalog is "busy" while a background poll is syncing or the
  // query is errored. Item controls + submit are disabled while busy so the user
  // can't act on catalog data that is mid-change or known-stale.
  const catalogBusy = catalogSyncing || catalogError;
  // aperture-p73kv / aperture-tb0rh F2 — mirror the picker's "sugerido N un"
  // (display + submit) on the running total so the footer R$ amount doesn't
  // drift from what the user sees per card. suggestedQty is now the operator-set
  // DB value (produto.quantidadeSugerida), not the retired djb2 hash.
  const catTotal = selectedItems.reduce((s, i) => s + i.price * i.suggestedQty, 0);

  const toggleCatItem = (it: CatalogItem) => {
    // aperture-wpsfp — no selection changes while the catalog is syncing/errored.
    if (catalogBusy) return;
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
    // aperture-wpsfp — never submit while the catalog is syncing/errored;
    // selectedItems is already derived from the live catalog so any product that
    // has since disappeared is excluded from the payload.
    if (selectedItems.length === 0 || submitting || catalogBusy) return;
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
          aria-selected={tab === 'catalogo'}
          aria-controls="lista-tabpanel-catalogo"
          className={'lista-tab' + (tab === 'catalogo' ? ' is-active' : '')}
          onClick={() => setTab('catalogo')}
        >
          Catálogo
        </button>
        <button
          type="button"
          role="tab"
          id="lista-tab-personalizado"
          aria-selected={tab === 'personalizado'}
          aria-controls="lista-tabpanel-personalizado"
          className={'lista-tab' + (tab === 'personalizado' ? ' is-active' : '')}
          onClick={() => setTab('personalizado')}
        >
          Personalizado
        </button>
      </div>

      <div className="lista-modal-body">
        {tab === 'catalogo' ? (
          <div role="tabpanel" id="lista-tabpanel-catalogo" aria-labelledby="lista-tab-catalogo">
            {/* aperture-tb0rh F2 — inline picker loading/error. NEVER render an
                empty catalog grid while loading or errored (error ≠ empty). */}
            {catalogLoading ? (
              <div className="lista-cat-empty">
                <span className="eyebrow">carregando catálogo…</span>
              </div>
            ) : catalogError ? (
              <div className="lista-cat-empty">
                <span className="eyebrow coral">opa</span>
                <p>
                  Não rolou carregar o catálogo.{' '}
                  <button
                    type="button"
                    onClick={onRetryCatalog}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: 'var(--lilac-deep)',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      font: 'inherit',
                    }}
                  >
                    tentar de novo →
                  </button>
                </p>
              </div>
            ) : (
              <CatalogoView
                catalog={catalog}
                selected={selected}
                onToggle={toggleCatItem}
                disabled={catalogBusy}
              />
            )}
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
        {tab === 'catalogo' ? (
          <div className="lista-sel-count">
            {selectedItems.length === 0 ? (
              <>0 presentes selecionados</>
            ) : (
              <>
                {selectedItems.length}{' '}
                {selectedItems.length === 1 ? 'presente selecionado' : 'presentes selecionados'} ·{' '}
                <b>{brl(catTotal)}</b>
              </>
            )}
          </div>
        ) : (
          <div className="lista-sel-count">
            novo presente: <b>{f.title.trim() || '—'}</b>
          </div>
        )}
        <div className="lista-foot-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          {tab === 'catalogo' ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={selectedItems.length === 0 || submitting || catalogBusy}
              onClick={submitCatalogo}
            >
              <span className="lista-btn-ic">{icon.plus}</span>{' '}
              {submitting ? 'Adicionando...' : 'Adicionar'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!personValid || submitting}
              onClick={submitPersonalizado}
            >
              <span className="lista-btn-ic">{icon.plus}</span>{' '}
              {submitting ? 'Adicionando...' : 'Adicionar à lista'}
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
  const priceNum = parseValorBRL(f.price);
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
            {submitting ? 'Salvando...' : 'Salvar alterações'}
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
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? 'Removendo...' : 'Sim, remover'}
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
  syncing,
  errored,
}: {
  preset: ListaProntaPub;
  onClose: () => void;
  onSubmit: (selected: PresetItemPub[]) => void;
  submitting: boolean;
  // aperture-7tyqh — the preset is "busy" while a background poll of
  // listListasProntas is in flight (syncing) OR the query is errored (errored).
  // While busy, item controls + submit are disabled so a stale (about-to-change
  // or known-stale-on-error) preset item can't be picked/submitted. Mirrors the
  // picker's catalogBusy = catalogSyncing || catalogError.
  syncing: boolean;
  errored: boolean;
}) {
  const busy = syncing || errored;
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preset.items.map((it) => it.id)),
  );

  // aperture-7tyqh — reconcile the selection against the live preset items. When
  // an item disappears (admin edit lands via the poll), drop its id so it can't
  // resurrect if the item returns. selectedItems already excludes absent ids
  // from the submit payload; this prunes the id itself.
  useEffect(() => {
    const validIds = new Set(preset.items.map((it) => it.id));
    setSelected((cur) => {
      let changed = false;
      const next = new Set<string>();
      cur.forEach((id) => {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : cur;
    });
  }, [preset]);

  const toggle = (id: string) => {
    // aperture-7tyqh — no selection changes while the preset is syncing/errored.
    if (busy) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedItems = preset.items.filter((it) => selected.has(it.id));
  // aperture-p73kv / aperture-tb0rh F2 — same suggestedQty mirror as the
  // catalogo path (DB value item.quantidade, not the retired djb2 hash).
  const total = selectedItems.reduce((s, it) => s + it.price * it.suggestedQty, 0);
  const count = selectedItems.length;

  const submit = () => {
    // aperture-7tyqh — never submit while the preset is syncing/errored;
    // selectedItems is derived from the live preset so any item that disappeared
    // is excluded.
    if (count === 0 || submitting || busy) return;
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
                className={'lista-preset-item' + (on ? ' is-selected' : '')}
                onClick={() => toggle(it.id)}
                aria-pressed={on}
                aria-label={`${on ? 'Remover' : 'Adicionar'} ${it.name}`}
                disabled={busy}
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
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        borderRadius: 'inherit',
                        display: 'block',
                      }}
                    />
                  ) : (
                    <span className="lista-preset-emoji">{it.emoji}</span>
                  )}
                </div>
                <div className="lista-preset-meta">
                  <span className="lista-preset-name">{it.name}</span>
                  <span className="lista-preset-sub">
                    {brl(it.price)} · sugerido {it.suggestedQty} un
                  </span>
                </div>
                <span className={'lista-preset-check' + (on ? ' is-on' : '')} aria-hidden="true">
                  {on && icon.check}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="lista-modal-foot">
        <div className="lista-sel-count">
          {count} {count === 1 ? 'presente selecionado' : 'presentes selecionados'} ·{' '}
          <b>{brl(total)}</b>
        </div>
        <div className="lista-foot-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={count === 0 || submitting || busy}
            onClick={submit}
          >
            <span className="lista-btn-ic">{icon.heart}</span>
            {submitting ? 'Adicionando...' : 'Adicionar à minha lista →'}
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
              width: '60%',
              background: 'var(--lilac-soft)',
              borderRadius: 6,
              opacity: 0.5,
              margin: '12px 0 16px',
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
                  background: 'var(--lilac-soft)',
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
              background: 'var(--paper)',
              opacity: 0.5,
              animation: 'pulse 1.6s ease-in-out infinite',
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
          <p className="lista-header-sub">Algo travou aqui do nosso lado — bora tentar de novo?</p>
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

  // aperture-wpsfp / aperture-7tyqh — modal/panel open-states gate the catalog +
  // listas-prontas polls below, so ALL local state is declared before the
  // queries whose refetchInterval reacts to it.
  const [addModalTab, setAddModalTab] = useState<AddTab | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetDetail, setPresetDetail] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState<CatFilter>('all');
  const [editItem, setEditItem] = useState<GroupedGift | null>(null);
  const [removeItem, setRemoveItem] = useState<GroupedGift | null>(null);
  // aperture-wpsfp — true only while an explicit picker-open refetch is in flight.
  // Gates the picker loading state so a just-deactivated item can't be selected
  // during THAT refetch — without flashing loading on the 3s background poll.
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);

  // aperture-tb0rh F2 / aperture-wpsfp / aperture-7tyqh — live catalog + listas-
  // prontas from the tRPC procs so admin CRUD propagates to /painel. Cross-Page
  // cache coherence: admin mutations live in a DIFFERENT Page's QueryClient
  // (TrpcProvider is per-Page), so these customer queries are never invalidated
  // by them. Each surface keeps an ALREADY-OPEN modal/panel current within the
  // 5s acceptance window by polling its query WHILE THAT SURFACE IS OPEN
  // (refetchInterval gated to the open-state; refetchIntervalInBackground so a
  // two-context test's backgrounded customer tab still polls) PLUS an explicit
  // refetch on open (openAddModal / openPresets). Both polls are OFF whenever
  // their surface is closed — zero polling on the normal customer view.
  const catalogQuery = trpc.catalogo.listSections.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: addModalTab !== null ? 3000 : false,
    refetchIntervalInBackground: true,
  });
  const listasProntasQuery = trpc.catalogo.listListasProntas.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: presetsOpen ? 3000 : false,
    refetchIntervalInBackground: true,
  });

  // aperture-wpsfp — shared picker-open handler for every add-gift CTA. Force-
  // refetches listSections so the picker opens against current server truth;
  // catalogRefreshing gates the picker loading state during the refresh.
  const openAddModal = (tab: AddTab) => {
    setAddModalTab(tab);
    setCatalogRefreshing(true);
    void catalogQuery.refetch().finally(() => setCatalogRefreshing(false));
  };

  // aperture-7tyqh — toggle the "usar lista pronta" panel; on OPEN, force-refetch
  // listListasProntas so the tiles open against current server truth (same
  // cross-Page coherence as the picker).
  const openPresets = () => {
    const next = !presetsOpen;
    setPresetsOpen(next);
    if (next) void listasProntasQuery.refetch();
  };

  // aperture-tb0rh F2 — live listas prontas keyed by slug. Empty object until
  // the query resolves; the gate below blocks render until it's ready.
  const listasProntas: Record<string, ListaProntaPub> = listasProntasQuery.data ?? {};

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
    () => ['all', ...CATEGORY_OPTIONS.filter((k) => counts[k])],
    [counts],
  );

  const filtered = items.filter((i) => {
    if (cat !== 'all' && i.category !== cat) return false;
    if (search && !i.nome.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const claimedUnits = items.reduce((s, i) => s + i.received, 0);
  const totalUnits = items.reduce((s, i) => s + i.qty, 0);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const addItem = async (draft: DraftFields) => {
    const price = parseValorBRL(draft.price);
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
      sendEvent('lista_item_personalizado_adicionado', { nome_item: draft.title });
      toast.success(
        n === 1
          ? '1 presente adicionado à sua lista ♡'
          : `${n} presentes adicionados à sua lista ♡`,
      );
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  const addCatalogItems = async (picked: CatalogItem[]) => {
    try {
      await createBulkMut.mutateAsync({
        // Plan 0016 (aperture-putz5): one ROW per catalog item with
        // `quantidade=suggestedQty`. Pre-0016 this fanned out into
        // suggestedQty rows per item — locked decision #1 retires that.
        //
        // aperture-tb0rh F2: `it.suggestedQty` is the operator-set DB value
        // (produto.quantidadeSugerida), surfaced verbatim as "sugerido N un"
        // on the picker. The display and this submit MUST use the same value
        // or the actual list count diverges from what the user saw. Inline
        // stepper + per-card override is the next layer (filed as follow-up).
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
          quantidade: it.suggestedQty,
        })),
      });
      setAddModalTab(null);
      const totalUnits = picked.reduce((s, it) => s + it.suggestedQty, 0);
      sendEvent('lista_item_catalogo_adicionado', { quantidade_itens: totalUnits });
      toast.success(
        totalUnits === 1
          ? '1 presente adicionado à sua lista ♡'
          : `${totalUnits} presentes adicionados à sua lista ♡`,
      );
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  const addPresetItems = async (picked: PresetItemPub[], presetId: string) => {
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
          quantidade: it.suggestedQty,
        })),
      });
      setPresetDetail(null);
      setPresetsOpen(false);
      // aperture-tb0rh F2 — toast count mirrors the per-item suggestedQty
      // (DB value item.quantidade), matching display + submit.
      const n = picked.reduce((s, it) => s + it.suggestedQty, 0);
      sendEvent('lista_pronta_itens_adicionados', { preset_id: presetId, quantidade_itens: n });
      toast.success(
        `${n} ${n === 1 ? 'presente adicionado' : 'presentes adicionados'} à sua lista ♡`,
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
    const price = parseValorBRL(draft.price);
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
      toast.error('Não consegui identificar esse presente — recarrega a página ♡');
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
      toast.success('Alterações salvas ♡');
    } catch (err) {
      const error = toContribuicaoError(err);
      // Stale-row recovery: the slot was deleted between the visitor's
      // fetch + this edit. Invalidate so the next render reflects
      // reality + nudge the visitor with a calmer message than the
      // dead-end "esse presente não existe mais" the legacy flow used.
      if (error.kind === 'not-found') {
        void listQuery.refetch();
        setEditItem(null);
        toast('essa lista mudou — atualizamos para você ♡');
        return;
      }
      toast.error(contribuicaoErrorMessage(error));
    }
  };

  const confirmRemove = async () => {
    if (!removeItem) return;
    try {
      await deleteMut.mutateAsync({ ids: removeItem.ids });
      toast('Presente removido');
      setRemoveItem(null);
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  // ── Initial loading + error gates ────────────────────────────────────────

  if (listQuery.isPending || listasProntasQuery.isPending) {
    return <ListaSkeleton />;
  }
  // aperture-7tyqh — only the INITIAL load failure nukes the page. Once listas-
  // prontas has data, a background-poll error (listasProntasQuery.error with
  // last-good data retained) must NOT replace the whole page — the panel keeps
  // showing last-good tiles and the preset flow handles its own busy/error.
  if (listQuery.error || (listasProntasQuery.error && listasProntasQuery.data === undefined)) {
    return (
      <ListaErrorBanner
        onRetry={() => {
          void listQuery.refetch();
          void listasProntasQuery.refetch();
        }}
      />
    );
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
            </b>{' '}
            presentes já recebidos
          </p>
          <div className="lista-header-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openAddModal('catalogo')}
            >
              <span className="lista-btn-ic">{icon.plus}</span> Adicionar presente
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => openAddModal('personalizado')}
              aria-label="Criar item personalizado"
            >
              <span className="lista-btn-ic">{icon.sparkle}</span> Criar item personalizado
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={openPresets}
              aria-label="Usar lista pronta"
              aria-expanded={presetsOpen}
              aria-controls="lista-prontas-panel"
            >
              <span className="lista-btn-ic">{icon.listLines}</span>
              Usar lista pronta
              <span
                className="lista-btn-ic"
                style={{
                  transform: presetsOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.2s ease',
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
              {/* aperture-7tyqh — a background-poll error keeps the last-good tiles
                  (error ≠ empty) but surfaces a distinct, retryable error state and
                  makes the tiles non-actionable (VER LISTA disabled below) so stale
                  lists can't be opened/selected/submitted while errored. */}
              {listasProntasQuery.error && (
                <div
                  className="lista-prontas-erro"
                  role="alert"
                  style={{ margin: '0.25rem 0 0.75rem' }}
                >
                  <span className="eyebrow coral">opa</span>
                  <p>
                    Não rolou atualizar as listas prontas.{' '}
                    <button
                      type="button"
                      onClick={() => void listasProntasQuery.refetch()}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        color: 'var(--lilac-deep)',
                        textDecoration: 'underline',
                        cursor: 'pointer',
                        font: 'inherit',
                      }}
                    >
                      tentar de novo →
                    </button>
                  </p>
                </div>
              )}
              <div className="lista-prontas-grid">
                {/* aperture-tb0rh F2 — presets are now dynamic (live tRPC
                    record). Iterate the record's own entries so `detail` is
                    guaranteed present; the per-slug style lookup supplies the
                    emoji + tile tint (fallback for slugs the UI lacks art for). */}
                {Object.entries(listasProntas).map(([id, detail]) => {
                  const style = PRESET_TILE_STYLE[id] ?? PRESET_TILE_FALLBACK;
                  const itemCount = detail.items.length;
                  const title = detail.title;
                  const desc = detail.description;
                  const cover = detail.imageUrl;
                  return (
                    <article key={id} className="lista-pronta-card">
                      <div
                        className="lista-pronta-icon"
                        style={{ background: style.tileVar }}
                        aria-hidden="true"
                      >
                        {cover ? (
                          <img
                            src={cover}
                            alt=""
                            loading="lazy"
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                              borderRadius: 'inherit',
                              display: 'block',
                            }}
                          />
                        ) : (
                          <span>{style.emoji}</span>
                        )}
                      </div>
                      <h3 className="lista-pronta-title">{title}</h3>
                      <p className="lista-pronta-desc">{desc}</p>
                      <div className="lista-pronta-foot">
                        <span className="lista-pronta-count">
                          {itemCount} {itemCount === 1 ? 'item' : 'itens'}
                        </span>
                        <button
                          type="button"
                          className="lista-pronta-cta"
                          onClick={() => {
                            // aperture-7tyqh — don't open a stale preset detail
                            // while the listas-prontas query is errored.
                            if (listasProntasQuery.error) return;
                            sendEvent('lista_pronta_visualizada', { preset_id: id });
                            setPresetDetail(id);
                          }}
                          disabled={!!listasProntasQuery.error}
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
        <span>os presentes da sua lista</span>
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
                    className={'lista-chip' + (cat === k ? ' active' : '')}
                    onClick={() => setCat(k)}
                  >
                    {k === 'all' ? 'todos' : LISTA_CATEGORY_LABEL[k]}
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
              onClick={() => openAddModal('catalogo')}
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
              <GiftCard key={it.nome} item={it} onEdit={setEditItem} onRemove={setRemoveItem} />
            ))}
            <button
              type="button"
              className="lista-card lista-card-add"
              onClick={() => openAddModal('catalogo')}
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
          catalog={catalogQuery.data ?? []}
          catalogLoading={catalogQuery.isPending || catalogRefreshing}
          catalogSyncing={catalogQuery.isFetching}
          catalogError={!!catalogQuery.error}
          onRetryCatalog={() => void catalogQuery.refetch()}
        />
      )}
      {editItem && (
        <EditItemModal
          initial={{
            title: editItem.nome,
            price: editItem.price.toFixed(2).replace('.', ','),
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
      {presetDetail &&
        (() => {
          // aperture-tb0rh F2 — listasProntas is a string-indexed record now, so
          // the lookup is `ListaProntaPub | undefined`. Bind it once to narrow
          // for the `preset` prop (presetDetail is const, so it stays narrowed
          // to string inside this closure for addPresetItems).
          const detail = listasProntas[presetDetail];
          if (!detail) return null;
          return (
            <PresetDetailModal
              preset={detail}
              onClose={() => setPresetDetail(null)}
              onSubmit={(selected) => void addPresetItems(selected, presetDetail)}
              submitting={presetSubmitting}
              syncing={listasProntasQuery.isFetching}
              errored={!!listasProntasQuery.error}
            />
          );
        })()}
    </div>
  );
}
