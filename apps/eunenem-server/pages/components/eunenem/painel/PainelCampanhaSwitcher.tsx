// aperture-vtxk7 (fblrt W3-b) — topbar "ir para" campanha switcher.
//
// Reinstates the design artifact's dropdown (multicampanhas-20260707,
// operator green-lit): a topbar button "ir para / minhas listas ▾" opening
// "acessar uma lista ♡" with one entry per 2.0 campanha, navigating straight
// to /painel/:slug/c/:id — no more hub-and-spoke-only switching through
// /campanhas (aperture-hdftp's removal, now superseded).
//
// Scope decisions:
//   • Entries are the NOVAS (2.0) campanhas only — legado (1.0) lists leave
//     the app through the CampanhasPage bridge, so they stay on the hub. The
//     footer link "ver todas as listas" keeps the hub one tap away (and with
//     it the legado cards + criar-nova affordance).
//   • The current campanha (rota ?? session default — the campanha this
//     painel is effectively showing) is marked "você tá aqui ♡" and
//     aria-current, still navigable (a harmless self-link).
//   • quantidadeMimos === null HIDES the mimo line (contract gotcha, PR
//     #320): the sub-line falls back to nomeBebe, then to nothing.
import { useEffect, useRef, useState } from "react";

import { useCampanhaEscrita } from "@/lib/campanha-escrita";
import { useCampanhasList } from "@/lib/campanhas";
import { painelHref } from "@/lib/painelRoutes";

/** Initial-tile pastel rotation — mock's per-item tint, token-mapped. */
const TINTS = [
  "var(--lilac-soft)",
  "var(--pink-soft)",
  "var(--yellow-soft)",
  "var(--blue-soft)",
] as const;

export function PainelCampanhaSwitcher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listQ = useCampanhasList();
  // The campanha this painel is showing: rota ?? session default (same
  // resolution as the write path — here it only drives the "você tá aqui"
  // marker, never a payload).
  const idCampanhaAtual = useCampanhaEscrita();

  // Close on click-outside + Escape (returns focus to the trigger on Esc).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        rootRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const novas = listQ.data?.novas ?? [];

  return (
    <div className="painel-switcher" ref={rootRef}>
      <button
        type="button"
        className="painel-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="topbar-switcher"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="painel-switcher-eyebrow">ir para</span>
        <span className="painel-switcher-label">minhas listas</span>
        <span className="painel-switcher-caret" data-open={open} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="painel-switcher-menu" role="menu" aria-label="Acessar uma lista">
          <div className="painel-switcher-head" aria-hidden="true">
            acessar uma lista ♡
          </div>
          {novas.map((c, i) => {
            const atual = c.id === idCampanhaAtual;
            const sub =
              c.quantidadeMimos !== null
                ? `${c.quantidadeMimos} ${c.quantidadeMimos === 1 ? "mimo" : "mimos"}`
                : c.nomeBebe
                  ? `chá de ${c.nomeBebe}`
                  : null;
            return (
              <a
                key={c.id}
                role="menuitem"
                href={painelHref(slug, undefined, c.id)}
                className="painel-switcher-item"
                aria-current={atual ? "true" : undefined}
                data-testid="switcher-item"
              >
                <span
                  className="painel-switcher-initial"
                  style={{ background: TINTS[i % TINTS.length] }}
                  aria-hidden="true"
                >
                  {(c.titulo || "♡").trim().charAt(0).toLocaleUpperCase()}
                </span>
                <span className="painel-switcher-item-text">
                  <span className="painel-switcher-item-name">{c.titulo}</span>
                  {atual ? (
                    <span className="painel-switcher-item-here">você tá aqui ♡</span>
                  ) : (
                    sub && <span className="painel-switcher-item-sub">{sub}</span>
                  )}
                </span>
              </a>
            );
          })}
          {listQ.isLoading && (
            <div className="painel-switcher-empty">carregando as suas listas…</div>
          )}
          {!listQ.isLoading && novas.length === 0 && (
            <div className="painel-switcher-empty">nenhuma lista por aqui ainda ♡</div>
          )}
          <a
            role="menuitem"
            href="/campanhas"
            className="painel-switcher-all"
            data-testid="switcher-ver-todas"
          >
            ver todas as listas
            <span aria-hidden="true"> →</span>
          </a>
        </div>
      )}
    </div>
  );
}
