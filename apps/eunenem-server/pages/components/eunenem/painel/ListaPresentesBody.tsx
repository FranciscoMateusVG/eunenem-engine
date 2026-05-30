import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  LISTA_CATALOGO_SEED,
  LISTA_CATEGORY_LABEL,
  LISTA_PRESENTES_SEED,
  type ListaCatalogItem,
  type ListaCategory,
  type ListaGift,
} from "@/lib/mocks/listaPresentes";

// aperture-4je0p — "Minha lista de presentes" (creator gift-list management).
//
// CONTENT ONLY — topbar / shell / TweaksPanel come from PainelLayout. This is
// the creator side: add / edit / remove gift items, set price + quantity, see
// how many units each item has already received. Distinct from the public
// marketplace (/pagina/:slug) which is the read-only buy view.
//
// All mutations are local React state (mock-first, no backend). The visual
// recipe is adapted from the standalone "Lista de Presentes" export (Patrick
// Hand titles, lilás thumbs, yellow marca-texto, plum-tinted shadows) into the
// 520px-mobile / fluid-desktop painel shell. CSS lives in tailwind.css under
// the `.lista-*` namespace.

const brl = (n: number) =>
  "R$ " +
  n.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const uid = () => "g" + Math.random().toString(36).slice(2, 9);

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
  // aperture-2eq0f — sparkle for "criar item personalizado" CTA.
  // Four-point sparkle with a soft accent dot top-right reads as a
  // creative-action affordance without competing with the plus icon.
  sparkle: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  ),
  // aperture-2eq0f — hamburger/list lines for "usar lista pronta".
  // Three short lines read instantly as "a curated list" — paired
  // with the caret below it telegraphs the expand/collapse panel
  // (operator confirmed in the follow-up bead that this opens a
  // preset-list panel below the action strip, not a dropdown menu).
  listLines: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  ),
  // aperture-2eq0f — downward caret. Sits on the right side of the
  // "usar lista pronta" CTA to signal the expand-below behaviour.
  caretDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  // aperture-17cls — checkmark for the catalog item's selected state.
  // Pairs with `.lista-cat-check.is-on` (filled lilac circle).
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  ),
};

// aperture-g70uv — hardcoded curated presets surfaced by the
// "Usar lista pronta" expand/collapse panel. Operator will refine
// the copy + item counts later; the icon-tile background tokens
// match the soft-surface palette already used elsewhere on /painel.
// NOTE: the brief listed --peach-soft / --mint-soft as available
// tokens, but the design system only ships --pink-soft + --green
// (no -soft variant) — so we map peach→pink-soft and mint to a
// softened green via color-mix to land in the same pastel range.
interface ListaProntaPreset {
  id: string;
  title: string;
  emoji: string;
  tileVar: string; // CSS custom-property name for icon-tile background
  desc: string;
  count: number;
}
const LISTA_PRONTAS: ListaProntaPreset[] = [
  {
    id: "essenciais",
    title: "Essenciais do Dia",
    emoji: "☀️",
    tileVar: "var(--lilac-soft)",
    desc: "Tudo que você mais vai precisar no primeiro mês — fraldas, lencinhos e pomada na medida certa.",
    count: 6,
  },
  {
    id: "banho",
    title: "Hora do Banho",
    emoji: "🛁",
    tileVar: "var(--pink-soft)",
    desc: "Banheira, toalha felpuda e cosméticos suaves para esses primeiros mergulhos.",
    count: 4,
  },
  {
    id: "soninho",
    title: "Hora do Soninho",
    emoji: "🌙",
    tileVar: "color-mix(in srgb, var(--green) 40%, var(--paper))",
    desc: "Mantinhas macias, chupetas e tudo pra noite render mais (pra você também).",
    count: 4,
  },
  {
    id: "papinha",
    title: "Hora da Papinha",
    emoji: "🍼",
    tileVar: "var(--cream-2)",
    desc: "Mamadeira, babadores e itens para as primeiras refeições com calma.",
    count: 3,
  },
];

type CatFilter = "all" | ListaCategory;
type AddTab = "catalogo" | "personalizado";

interface DraftFields {
  title: string;
  price: string;
  qty: number;
  category: ListaCategory;
  // aperture-17cls — recadinho field on the PERSONALIZADO tab. Optional
  // free-text the creator can leave for guests ("a do quarto verde-musgo!").
  // Empty string when absent. Edit modal reuses the form but starts blank.
  note: string;
}

function emptyDraft(): DraftFields {
  return { title: "", price: "", qty: 1, category: "personalizado", note: "" };
}

/* ─── Stats visor ─── */
function Visor({ items }: { items: ListaGift[] }) {
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
  item: ListaGift;
  onEdit: (i: ListaGift) => void;
  onRemove: (i: ListaGift) => void;
}) {
  const pct = item.qty > 0 ? Math.min(100, (item.received / item.qty) * 100) : 0;
  const isComplete = item.received >= item.qty;
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
          <button type="button" onClick={() => onEdit(item)} aria-label={`Editar ${item.title}`}>
            {icon.edit}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => onRemove(item)}
            aria-label={`Remover ${item.title}`}
          >
            {icon.trash}
          </button>
        </div>
        {isComplete && <span className="lista-card-stamp">recebido ♡</span>}
      </div>
      <div className="lista-card-body">
        <h5 className="lista-card-title">{item.title}</h5>
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
//
// aperture-17cls — lifted the form body out of the old ItemFormModal so both
// the EDIT modal and the new ADD modal's PERSONALIZADO tab share one source
// of truth for the field layout. The optional ✦ info banner only renders on
// the ADD path (operator's PERSONALIZADO tab spec calls for it explicitly).
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
//
// aperture-17cls — search + grouped sections of catalog cards with
// multi-select via aria-pressed buttons. Selection state lives in the
// parent AddGiftModal so the footer can show count/total and the submit
// path can hand them off to the body's addCatalogItems().
function CatalogoView({
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (item: ListaCatalogItem) => void;
}) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const sections = LISTA_CATALOGO_SEED.map((sec) => {
    const items = q ? sec.items.filter((i) => i.name.toLowerCase().includes(q)) : sec.items;
    return { ...sec, items };
  }).filter((sec) => sec.items.length > 0);

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
//
// aperture-17cls — opened from the four ADD callsites in the body (primary
// CTA, sparkle ghost from aperture-2eq0f, empty-state primary, add-card).
// `defaultTab` is set by each callsite so the sparkle button lands on
// PERSONALIZADO and the others land on CATÁLOGO. The PERSONALIZADO and
// CATÁLOGO drafts are kept in separate state so switching tabs preserves
// each tab's in-flight input.
function AddGiftModal({
  defaultTab,
  onClose,
  onSubmitPersonalizado,
  onSubmitCatalogo,
}: {
  defaultTab: AddTab;
  onClose: () => void;
  onSubmitPersonalizado: (draft: DraftFields) => void;
  onSubmitCatalogo: (items: ListaCatalogItem[]) => void;
}) {
  const [tab, setTab] = useState<AddTab>(defaultTab);
  const [f, setF] = useState<DraftFields>(emptyDraft);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const personPriceNum = parseFloat(f.price.replace(",", ".")) || 0;
  const personValid = f.title.trim().length > 0 && personPriceNum > 0;

  // Collect selected items in catalog order so the body's addCatalogItems
  // adds them in the same visual order the user saw them.
  const selectedItems = useMemo(() => {
    const out: ListaCatalogItem[] = [];
    LISTA_CATALOGO_SEED.forEach((sec) =>
      sec.items.forEach((it) => {
        if (selected.has(it.id)) out.push(it);
      }),
    );
    return out;
  }, [selected]);
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
    if (!personValid) return;
    onSubmitPersonalizado({ ...f, title: f.title.trim(), note: f.note.trim() });
  };

  const submitCatalogo = () => {
    if (selectedItems.length === 0) return;
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
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          {tab === "catalogo" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={selectedItems.length === 0}
              onClick={submitCatalogo}
            >
              <span className="lista-btn-ic">{icon.plus}</span> Adicionar
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!personValid}
              onClick={submitPersonalizado}
            >
              <span className="lista-btn-ic">{icon.plus}</span> Adicionar à lista
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
}: {
  initial: DraftFields;
  onClose: () => void;
  onSubmit: (draft: DraftFields) => void;
}) {
  const [f, setF] = useState<DraftFields>(initial);
  const priceNum = parseFloat(f.price.replace(",", ".")) || 0;
  const valid = f.title.trim().length > 0 && priceNum > 0;
  const previewTotal = priceNum * (Number(f.qty) || 0);

  const submit = () => {
    if (!valid) return;
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
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={submit}>
            Salvar alterações
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
}: {
  item: ListaGift;
  onClose: () => void;
  onConfirm: () => void;
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
          <b>&ldquo;{item.title}&rdquo;</b> será removido da sua lista. Você pode adicionar de novo a
          qualquer momento.
        </p>
      </div>
      <div className="lista-modal-foot">
        <div className="lista-foot-actions lista-foot-actions-end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Manter na lista
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            Sim, remover
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Body ─── */
export function ListaPresentesBody({ slug }: PainelSectionBodyProps) {
  void slug; // mock-first: the only creator is "helena"; slug not yet used.

  const [items, setItems] = useState<ListaGift[]>(LISTA_PRESENTES_SEED);
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState<CatFilter>("all");
  // aperture-17cls — addModalTab encodes BOTH open state and the default tab.
  // null = closed; "catalogo" or "personalizado" = open on that tab. Replaces
  // the old addOpen boolean so the sparkle CTA (aperture-2eq0f) can land on
  // PERSONALIZADO while the primary CTA lands on CATÁLOGO from one setter.
  const [addModalTab, setAddModalTab] = useState<AddTab | null>(null);
  const [editItem, setEditItem] = useState<ListaGift | null>(null);
  const [removeItem, setRemoveItem] = useState<ListaGift | null>(null);
  // aperture-g70uv — controls the curated preset panel that expands
  // beneath the .lista-header-actions strip when the operator taps
  // "Usar lista pronta". Replaces the previous toast placeholder.
  const [presetsOpen, setPresetsOpen] = useState(false);
  const idRef = useRef(0);

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
    if (search && !i.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const claimedUnits = items.reduce((s, i) => s + i.received, 0);
  const totalUnits = items.reduce((s, i) => s + i.qty, 0);

  const addItem = (draft: DraftFields) => {
    const price = parseFloat(draft.price.replace(",", ".")) || 0;
    idRef.current += 1;
    const next: ListaGift = {
      id: uid(),
      title: draft.title,
      price,
      qty: Number(draft.qty) || 1,
      received: 0,
      category: draft.category,
      emoji: "🎁",
      bgColor: "var(--lilac-soft)",
      custom: draft.category === "personalizado",
    };
    setItems((cur) => [next, ...cur]);
    setAddModalTab(null);
    // aperture-17cls: the optional `note` (recadinho) is collected but not
    // yet rendered on the gift cards — keeps this PR's scope to the modal
    // shape. A follow-up can wire the note onto the card body when the
    // operator confirms how prominent the note should be on the public
    // marketplace surface.
    void draft.note;
    toast.success("1 mimo adicionado à sua lista ♡");
  };

  // aperture-17cls — CATÁLOGO multi-select submit. Each selected item turns
  // into a ListaGift with the catalog's suggestedQty + the catalog's emoji
  // and tint (so the cards look authored, not stock). Inserted at the top of
  // the list in catalog order, preserving the visual order the user saw.
  const addCatalogItems = (picked: ListaCatalogItem[]) => {
    const newGifts: ListaGift[] = picked.map((it) => ({
      id: uid(),
      title: it.name,
      price: it.price,
      qty: it.suggestedQty,
      received: 0,
      category: it.category,
      emoji: it.emoji,
      bgColor: it.bgColor,
    }));
    setItems((cur) => [...newGifts, ...cur]);
    setAddModalTab(null);
    toast.success(
      picked.length === 1
        ? "1 mimo adicionado à sua lista ♡"
        : `${picked.length} mimos adicionados à sua lista ♡`,
    );
  };

  const saveEdit = (draft: DraftFields) => {
    if (!editItem) return;
    const price = parseFloat(draft.price.replace(",", ".")) || 0;
    setItems((cur) =>
      cur.map((x) =>
        x.id === editItem.id
          ? {
              ...x,
              title: draft.title,
              price,
              qty: Number(draft.qty) || 1,
              category: draft.category,
              custom: draft.category === "personalizado",
            }
          : x,
      ),
    );
    setEditItem(null);
    toast.success("Alterações salvas ♡");
  };

  const confirmRemove = () => {
    if (!removeItem) return;
    setItems((cur) => cur.filter((x) => x.id !== removeItem.id));
    toast("Mimo removido");
    setRemoveItem(null);
  };

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
            {/* aperture-2eq0f — two outlined CTAs flanking the primary.
                aperture-17cls wired the sparkle CTA to the new tabbed modal's
                PERSONALIZADO tab; the primary above opens the same modal on
                CATÁLOGO. The lista-pronta CTA still toasts until aperture-g70uv
                lands the curated preset panel below this action strip. */}
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
          {/* aperture-g70uv — curated preset panel revealed by the
              "Usar lista pronta" toggle above. Sits inside
              .lista-header-card so the panel inherits the card's soft
              lilac chrome but reads as its own surface. */}
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
                {LISTA_PRONTAS.map((preset) => (
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
                        {preset.count} {preset.count === 1 ? "item" : "itens"}
                      </span>
                      {/* aperture-g70uv — placeholder wiring. aperture-wo5ql
                          will replace this toast with the real preset-detail
                          modal (a dedicated surface, NOT the aperture-17cls
                          tabbed AddGiftModal). Until that lands, keep the
                          affordance live so the panel feels real. */}
                      <button
                        type="button"
                        className="lista-pronta-cta"
                        onClick={() => toast("Em breve — preview da lista pronta ♡")}
                        aria-label={`Ver lista pronta: ${preset.title}`}
                      >
                        VER LISTA →
                      </button>
                    </div>
                  </article>
                ))}
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
              <GiftCard key={it.id} item={it} onEdit={setEditItem} onRemove={setRemoveItem} />
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
        />
      )}
      {editItem && (
        <EditItemModal
          initial={{
            title: editItem.title,
            price: editItem.price.toFixed(2).replace(".", ","),
            qty: editItem.qty,
            category: editItem.category,
            note: "",
          }}
          onClose={() => setEditItem(null)}
          onSubmit={saveEdit}
        />
      )}
      {removeItem && (
        <ConfirmRemove item={removeItem} onClose={() => setRemoveItem(null)} onConfirm={confirmRemove} />
      )}
    </div>
  );
}
