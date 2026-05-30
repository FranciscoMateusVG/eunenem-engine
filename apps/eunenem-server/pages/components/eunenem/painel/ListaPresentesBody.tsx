import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

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

// aperture-0ph83 — UI vocabulary for the category chips/badges. Kept in code
// (not in templates JSON) per operator decision recorded on aperture-cwcn0.
const LISTA_CATEGORY_LABEL: Record<ListaCategory, string> = {
  fraldas: "fraldas",
  higiene: "higiene",
  roupa: "roupinhas",
  soninho: "soninho",
  alimentacao: "alimentação",
  passeio: "passeio",
  personalizado: "personalizado",
};

const CATEGORY_OPTIONS: ListaCategory[] = [
  "fraldas",
  "higiene",
  "roupa",
  "soninho",
  "alimentacao",
  "passeio",
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

// aperture-g70uv / aperture-0ph83 — curated preset cards surfaced by the
// "Usar lista pronta" expand/collapse panel. Title/emoji/tile/desc are
// presentation vocabulary (live in code); item count is derived from the
// bundle's actual items at render time so they stay in lock-step with the
// JSON template.
interface ListaProntaPreset {
  id: ListaProntaId;
  title: string;
  emoji: string;
  tileVar: string;
  desc: string;
}
const LISTA_PRONTAS: ListaProntaPreset[] = [
  {
    id: "essenciais",
    title: "Essenciais do Dia",
    emoji: "☀️",
    tileVar: "var(--lilac-soft)",
    desc: "Tudo que você mais vai precisar no primeiro mês — fraldas, lencinhos e pomada na medida certa.",
  },
  {
    id: "banho",
    title: "Hora do Banho",
    emoji: "🛁",
    tileVar: "var(--pink-soft)",
    desc: "Banheira, toalha felpuda e cosméticos suaves para esses primeiros mergulhos.",
  },
  {
    id: "soninho",
    title: "Hora do Soninho",
    emoji: "🌙",
    tileVar: "color-mix(in srgb, var(--green) 40%, var(--paper))",
    desc: "Mantinhas macias, chupetas e tudo pra noite render mais (pra você também).",
  },
  {
    id: "papinha",
    title: "Hora da Papinha",
    emoji: "🍼",
    tileVar: "var(--cream-2)",
    desc: "Mamadeira, babadores e itens para as primeiras refeições com calma.",
  },
];

type CatFilter = "all" | ListaCategory;
type AddTab = "catalogo" | "personalizado";

interface DraftFields {
  title: string;
  price: string;
  qty: number;
  category: ListaCategory;
  note: string;
}

function emptyDraft(): DraftFields {
  return { title: "", price: "", qty: 1, category: "personalizado", note: "" };
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
  emoji: string;
  bgColor: string;
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
    g === "personalizado"
  );
};

function groupContribuicoes(items: ContribuicaoDTO[]): GroupedGift[] {
  const map = new Map<string, GroupedGift>();
  for (const c of items) {
    const category: ListaCategory = isListaCategory(c.grupo) ? c.grupo : "personalizado";
    const existing = map.get(c.nome);
    if (existing) {
      existing.ids.push(c.id);
      existing.qty += 1;
      if (c.status === "indisponivel") existing.received += 1;
    } else {
      map.set(c.nome, {
        ids: [c.id],
        nome: c.nome,
        price: brlFromCents(c.valor),
        category,
        emoji: c.imagemUrl ?? "🎁",
        bgColor: deriveBgColor(c.grupo),
        qty: 1,
        received: c.status === "indisponivel" ? 1 : 0,
        hasClaimed: c.status === "indisponivel",
        custom: category === "personalizado",
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
          {receivedUnits} de {totalUnits} mimos
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
    ? "não dá pra mexer — algum mimo desse grupo já foi reservado ♡"
    : undefined;
  return (
    <div className={"lista-card" + (isComplete ? " is-complete" : "")}>
      <div className="lista-card-thumb" style={{ background: item.bgColor }}>
        <span className="lista-card-emoji" aria-hidden="true">
          {item.emoji}
        </span>
        <span className={"lista-card-badge" + (item.custom ? " is-custom" : "")}>
          {item.custom ? "personalizado" : LISTA_CATEGORY_LABEL[item.category]}
        </span>
        <div className="lista-card-actions">
          <button
            type="button"
            onClick={() => onEdit(item)}
            aria-label={`Editar ${item.nome}`}
            disabled={item.hasClaimed}
            title={lockedTip}
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
}: {
  children: React.ReactNode;
  onClose: () => void;
  sm?: boolean;
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
        className={"lista-modal" + (sm ? " lista-modal-sm" : "")}
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
              Adicione mimos que não estão no catálogo — uma cadeirinha específica,
              decoração do quartinho ou aquele item dos sonhos.
            </p>
          </div>
        </div>
      )}
      <div className="lista-form">
        <div className="lista-field lista-field-full">
          <label htmlFor="lista-title">nome do mimo</label>
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
            />
            <button
              type="button"
              onClick={() => setF({ ...f, qty: (Number(f.qty) || 1) + 1 })}
              aria-label="Aumentar quantidade"
            >
              +
            </button>
          </div>
          <span className="lista-hint">convidados podem dividir o valor</span>
        </div>
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
        <div className="lista-field lista-field-full">
          <label htmlFor="lista-note">recadinho opcional</label>
          <input
            id="lista-note"
            placeholder="um detalhe pra contar pros convidados..."
            value={f.note}
            onChange={(e) => setF({ ...f, note: e.target.value })}
          />
        </div>
      </div>
    </>
  );
}

/* ─── Catálogo (catalog tab body) ─── */
function CatalogoView({
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (item: ListaCatalogItem) => void;
}) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  // aperture-0ph83 — sourced from JSON loader (aperture-cwcn0) instead of the
  // legacy mock. Same shape, same emojis, no UI change.
  const catalog = useMemo(() => loadCatalog(), []);
  const sections = catalog
    .map((sec) => {
      const items = q ? sec.items.filter((i) => i.name.toLowerCase().includes(q)) : sec.items;
      return { ...sec, items };
    })
    .filter((sec) => sec.items.length > 0);

  return (
    <div className="lista-catalogo">
      <div className="lista-cat-search">
        <span className="lista-cat-search-ic" aria-hidden="true">{icon.search}</span>
        <input
          type="text"
          placeholder="buscar no catálogo (fralda, mamadeira...)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar no catálogo"
        />
      </div>
      {sections.length === 0 ? (
        <div className="lista-cat-empty">
          <span className="eyebrow coral">nada por aqui</span>
          <p>
            Tente outra palavra — ou monte o mimo pela aba <b>personalizado</b>.
          </p>
        </div>
      ) : (
        sections.map((sec) => (
          <section key={sec.category} className="lista-cat-section">
            <h4 className="lista-cat-section-hd">{sec.label}</h4>
            <ul className="lista-cat-list">
              {sec.items.map((it) => {
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
                        <span className="lista-cat-emoji" aria-hidden="true">{it.emoji}</span>
                      </span>
                      <span className="lista-cat-meta">
                        <span className="lista-cat-name">{it.name}</span>
                        <span className="lista-cat-sub">
                          {brl(it.price)} · sugerido {it.suggestedQty} un
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
          </section>
        ))
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
  const catTotal = selectedItems.reduce((s, i) => s + i.price * i.suggestedQty, 0);

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
    onSubmitPersonalizado({ ...f, title: f.title.trim(), note: f.note.trim() });
  };

  const submitCatalogo = () => {
    if (selectedItems.length === 0 || submitting) return;
    onSubmitCatalogo(selectedItems);
  };

  return (
    <Modal onClose={onClose}>
      <div className="lista-modal-head">
        <div>
          <span className="eyebrow coral">um novo mimo ♡</span>
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
              <>0 mimos selecionados</>
            ) : (
              <>
                {selectedItems.length}{" "}
                {selectedItems.length === 1 ? "mimo selecionado" : "mimos selecionados"} ·{" "}
                <b>{brl(catTotal)}</b>
              </>
            )}
          </div>
        ) : (
          <div className="lista-sel-count">
            novo mimo: <b>{f.title.trim() || "—"}</b>
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
    onSubmit({ ...f, title: f.title.trim(), note: f.note.trim() });
  };

  return (
    <Modal onClose={onClose}>
      <div className="lista-modal-head">
        <div>
          <span className="eyebrow coral">ajuste fininho ♡</span>
          <h3>Editar mimo</h3>
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
          <h3>Remover este mimo</h3>
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
  const total = selectedItems.reduce((s, it) => s + it.price * it.suggestedQty, 0);
  const count = selectedItems.length;

  const submit = () => {
    if (count === 0 || submitting) return;
    onSubmit(selectedItems);
  };

  return (
    <Modal onClose={onClose}>
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
                  <span className="lista-preset-emoji">{it.emoji}</span>
                </div>
                <div className="lista-preset-meta">
                  <span className="lista-preset-name">{it.name}</span>
                  <span className="lista-preset-sub">
                    {brl(it.price)} · sugerido {it.suggestedQty} un
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
          {count} {count === 1 ? "mimo selecionado" : "mimos selecionados"} ·{" "}
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
          <span className="eyebrow">sua coleção de mimos ♡</span>
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
        imagemUrl: null,
        grupo: draft.category,
        qty: Number(draft.qty) || 1,
      });
      setAddModalTab(null);
      const n = Number(draft.qty) || 1;
      toast.success(
        n === 1
          ? "1 mimo adicionado à sua lista ♡"
          : `${n} mimos adicionados à sua lista ♡`,
      );
      // aperture-0ph83: the optional `note` (recadinho) is collected but not
      // yet persisted server-side — the contribuicao contract doesn't carry
      // a note field. Follow-up bead can wire it once the schema accepts it.
      void draft.note;
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  const addCatalogItems = async (picked: ListaCatalogItem[]) => {
    try {
      await createBulkMut.mutateAsync({
        items: picked.map((it) => ({
          nome: it.name,
          valor: centsFromBRL(it.price),
          imagemUrl: it.emoji,
          grupo: it.category,
          qty: it.suggestedQty,
        })),
      });
      setAddModalTab(null);
      const totalUnits = picked.reduce((s, it) => s + it.suggestedQty, 0);
      toast.success(
        totalUnits === 1
          ? "1 mimo adicionado à sua lista ♡"
          : `${totalUnits} mimos adicionados à sua lista ♡`,
      );
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  const addPresetItems = async (picked: PresetItem[], presetId: ListaProntaId) => {
    try {
      await createBulkMut.mutateAsync({
        items: picked.map((it) => ({
          nome: it.name,
          valor: centsFromBRL(it.price),
          imagemUrl: it.emoji,
          grupo: presetId,
          qty: it.suggestedQty,
        })),
      });
      setPresetDetail(null);
      setPresetsOpen(false);
      const n = picked.reduce((s, it) => s + it.suggestedQty, 0);
      toast.success(
        `${n} ${n === 1 ? "mimo adicionado" : "mimos adicionados"} à sua lista ♡`,
      );
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  // Edit strategy: delete the group, then createBulk with the new shape.
  // Safe because edits are disabled when received > 0 (no contribuinte data
  // to preserve). One delete + one createBulk = two round-trips total, much
  // simpler than per-id update + qty delta math.
  const saveEdit = async (draft: DraftFields) => {
    if (!editItem) return;
    const price = parseFloat(draft.price.replace(",", ".")) || 0;
    const newQty = Number(draft.qty) || 1;
    try {
      await deleteMut.mutateAsync({ ids: editItem.ids });
      await createBulkMut.mutateAsync({
        items: [
          {
            nome: draft.title,
            valor: centsFromBRL(price),
            imagemUrl: editItem.emoji,
            grupo: draft.category,
            qty: newQty,
          },
        ],
      });
      setEditItem(null);
      toast.success("Alterações salvas ♡");
    } catch (err) {
      toast.error(contribuicaoErrorMessage(toContribuicaoError(err)));
    }
  };

  const confirmRemove = async () => {
    if (!removeItem) return;
    try {
      await deleteMut.mutateAsync({ ids: removeItem.ids });
      toast("Mimo removido");
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
  const editSubmitting = deleteMut.isPending || createBulkMut.isPending;
  const removeSubmitting = deleteMut.isPending;
  const presetSubmitting = createBulkMut.isPending;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="lista-body">
      {/* Header card */}
      <section className="lista-header-card">
        <div className="lista-header-top">
          <span className="eyebrow">sua coleção de mimos ♡</span>
          <h1>
            Minha <span className="hl">lista de presentes</span>
          </h1>
          <p className="lista-header-sub">
            {items.length} {items.length === 1 ? "presente" : "presentes"} ·{" "}
            <b>
              {claimedUnits} de {totalUnits}
            </b>{" "}
            mimos já recebidos
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
              <p className="lista-prontas-sub">Toque pra ver os mimos antes de adicionar.</p>
              <div className="lista-prontas-grid">
                {LISTA_PRONTAS.map((preset) => {
                  const detail = listasProntas[preset.id];
                  const itemCount = detail?.items.length ?? 0;
                  return (
                    <article key={preset.id} className="lista-pronta-card">
                      <div
                        className="lista-pronta-icon"
                        style={{ background: preset.tileVar }}
                        aria-hidden="true"
                      >
                        <span>{preset.emoji}</span>
                      </div>
                      <h3 className="lista-pronta-title">{preset.title}</h3>
                      <p className="lista-pronta-desc">{preset.desc}</p>
                      <div className="lista-pronta-foot">
                        <span className="lista-pronta-count">
                          {itemCount} {itemCount === 1 ? "item" : "itens"}
                        </span>
                        <button
                          type="button"
                          className="lista-pronta-cta"
                          onClick={() => setPresetDetail(preset.id)}
                          aria-label={`Ver lista pronta: ${preset.title}`}
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
          os mimos da sua lista · {items.length} {items.length === 1 ? "presente" : "presentes"}
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
          </div>
        )}

        {items.length === 0 ? (
          <div className="lista-empty">
            <div className="lista-empty-doodle">{icon.heart}</div>
            <span className="eyebrow coral">primeira página em branco ♡</span>
            <h3>Sua lista está pronta pra começar</h3>
            <p>Adicione os mimos que vão contar a história do seu bebê.</p>
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
            <h3>Nenhum mimo encontrado</h3>
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
              <span className="lista-card-add-label">adicionar outro mimo</span>
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
            note: "",
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
