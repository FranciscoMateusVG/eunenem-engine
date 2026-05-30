import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  LISTA_CATEGORY_LABEL,
  LISTA_PRESENTES_SEED,
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
};

type CatFilter = "all" | ListaCategory;

interface DraftFields {
  title: string;
  price: string;
  qty: number;
  category: ListaCategory;
}

function emptyDraft(): DraftFields {
  return { title: "", price: "", qty: 1, category: "personalizado" };
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

/* ─── Add / edit form modal ─── */
function ItemFormModal({
  mode,
  initial,
  onClose,
  onSubmit,
}: {
  mode: "add" | "edit";
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
    onSubmit({ ...f, title: f.title.trim() });
  };

  return (
    <Modal onClose={onClose}>
      <div className="lista-modal-head">
        <div>
          <span className="eyebrow coral">{mode === "add" ? "um novo mimo ♡" : "ajuste fininho ♡"}</span>
          <h3>
            {mode === "add" ? (
              <>
                Adicionar à minha <span className="hl">lista</span>
              </>
            ) : (
              "Editar mimo"
            )}
          </h3>
        </div>
        <button type="button" className="lista-modal-x" onClick={onClose} aria-label="Fechar">
          {icon.x}
        </button>
      </div>

      <div className="lista-modal-body">
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
            <span className="lista-hint">quanto cada convidado contribui</span>
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
            <span className="lista-hint">convidados podem dividir</span>
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
        </div>
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
            {mode === "add" ? "Adicionar à lista" : "Salvar alterações"}
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
  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<ListaGift | null>(null);
  const [removeItem, setRemoveItem] = useState<ListaGift | null>(null);
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
    setAddOpen(false);
    toast.success("1 mimo adicionado à sua lista ♡");
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
            <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
              <span className="lista-btn-ic">{icon.plus}</span> Adicionar presente
            </button>
            {/* aperture-2eq0f — two outlined CTAs flanking the primary:
                "criar item personalizado" (sparkle) + "usar lista pronta"
                (list-lines + caret). Wiring is intentionally light until
                the follow-up beads land:
                  - aperture-17cls will replace the existing AddModal with
                    a tabbed CATÁLOGO/PERSONALIZADO modal; the personalized
                    button will open that modal on the PERSONALIZADO tab.
                  - aperture-g70uv will turn "usar lista pronta" into an
                    expand/collapse toggle revealing a curated preset panel
                    below this action strip.
                For now: personalized opens the existing AddModal (already a
                personalized form); usar-lista-pronta is a toast placeholder
                so the surface communicates intent without dead UI. */}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAddOpen(true)}
              aria-label="Criar item personalizado"
            >
              <span className="lista-btn-ic">{icon.sparkle}</span> Criar item personalizado
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => toast("Em breve — listas prontas curadas ♡")}
              aria-label="Usar lista pronta"
              aria-expanded={false}
            >
              <span className="lista-btn-ic">{icon.listLines}</span>
              Usar lista pronta
              <span className="lista-btn-ic">{icon.caretDown}</span>
            </button>
          </div>
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
            <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
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
              onClick={() => setAddOpen(true)}
            >
              <span className="lista-card-add-plus">{icon.plus}</span>
              <span className="lista-card-add-label">adicionar outro mimo</span>
              <span className="lista-card-add-sub">um novo presente pra lista</span>
            </button>
          </div>
        )}
      </div>

      {addOpen && (
        <ItemFormModal mode="add" initial={emptyDraft()} onClose={() => setAddOpen(false)} onSubmit={addItem} />
      )}
      {editItem && (
        <ItemFormModal
          mode="edit"
          initial={{
            title: editItem.title,
            price: editItem.price.toFixed(2).replace(".", ","),
            qty: editItem.qty,
            category: editItem.category,
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
