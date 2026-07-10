
import type { PainelMenuItem } from "@/lib/mocks/painelDemo";
import { menuItemHref } from "@/lib/painelRoutes";
import { useCampanhaRota } from "@/lib/campanha-rota";
import { useCampanhaSlugRota } from "@/lib/campanhas";
import { sendEvent } from "@/lib/analytics";

// aperture-i01o — single row in the painel menu list.
//
// Six props in, one anchor out. Variant + icon + badge + featured +
// soon are pinned by the data shape in PAINEL_DEMO so the component
// stays presentation-only. Default tap target is 60px high (44px+ per
// WCAG/Apple HIG); featured rows bump to 72px+ via the .row.featured
// modifier in globals.css.
//
// The chevron stays mounted across all rows for visual rhythm — only
// the badge slot is conditional. `soon` swaps the chevron for an
// aria-disabled link semantic so screen readers don't promise a
// destination that doesn't exist yet.

interface Props {
  item: PainelMenuItem;
  /** Creator slug of the current painel (mock: "helena"). Used to build the
   *  row's destination href via the painelRoutes convention. */
  slug: string;
  /** Optional explicit href override (rarely needed — defaults to the route
   *  resolved from `item.id` + `slug`). */
  href?: string;
}

export function PainelMenuRow({ item, slug, href }: Props) {
  // aperture-h0hom — preserve the campanha route context in destinations.
  const idCampanha = useCampanhaRota();
  // aperture-ej436 — the campanha's pretty slug for the 'ver como convidado'
  // row (same seam as the #367 share links).
  const campanhaSlug = useCampanhaSlugRota();
  // aperture-vv3i — hrefs are resolved from the route convention
  // (lib/painelRoutes.ts), not hardcoded "#". `soon` rows stay non-navigable;
  // ids with no destination (e.g. nothing yet) fall back to "#".
  const resolvedHref = item.soon
    ? "#"
    : (href ?? menuItemHref(slug, item.id, idCampanha, campanhaSlug) ?? "#");
  const isExternal = resolvedHref.startsWith("http");

  const variantClass = item.variant ? `var-${item.variant}` : "";
  const rowClass = [
    "painel-row",
    variantClass,
    item.featured ? "featured" : "",
    item.soon ? "soon" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <a
      href={resolvedHref}
      className={rowClass}
      // aperture-7nius — stable selector for the painel tutorial overlay
      // (plan 0018). The overlay reads positions via
      // document.querySelector(`[data-tutorial-target="<id>"]`), so every
      // row exposes its painelDemo id here. No-op for non-tutorial paths.
      data-tutorial-target={item.id}
      aria-disabled={item.soon || undefined}
      onClick={
        item.soon
          ? (e) => e.preventDefault()
          : item.id === "suporte"
            ? () => sendEvent("painel_suporte_whatsapp_click")
            : undefined
      }
      {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      <span className="painel-row-icon">
        <PainelRowIcon kind={item.icon} />
      </span>
      <div className="painel-row-body">
        <div className="painel-row-label">{item.label}</div>
        <div className="painel-row-sub">{item.sub}</div>
      </div>
      <div className="painel-row-trail">
        {item.badge && <PainelRowBadge badge={item.badge} />}
        {!item.soon && (
          <span className="painel-row-chev" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ width: 18, height: 18, strokeWidth: 2 }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        )}
      </div>
    </a>
  );
}

function PainelRowBadge({ badge }: { badge: NonNullable<PainelMenuItem["badge"]> }) {
  const cls = `painel-badge painel-badge-${badge.kind}`;
  return <span className={cls}>{badge.text}</span>;
}

// Icon set — Lucide-equivalent paths, traced into inline SVGs so the
// project doesn't take a new dep on lucide-react just for the painel.
// Stroke width 1.7 to match the existing v1 visual language.
function PainelRowIcon({ kind }: { kind: PainelMenuItem["icon"] }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor" as const,
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { width: 20, height: 20 },
  };

  switch (kind) {
    case "gift":
      return (
        <svg {...common} aria-hidden="true">
          <polyline points="20 12 20 22 4 22 4 12" />
          <rect x="2" y="7" width="20" height="5" />
          <line x1="12" y1="22" x2="12" y2="7" />
          <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
        </svg>
      );
    case "list":
      return (
        <svg {...common} aria-hidden="true">
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
        </svg>
      );
    case "envelope":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "users":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "messages":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path
            d="M12 14s-1.5-1.2-1.5-2.4a1.5 1.5 0 0 1 3 0c0 1.2-1.5 2.4-1.5 2.4z"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
    case "raffle":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7z" />
          <line x1="13" y1="5" x2="13" y2="7" />
          <line x1="13" y1="11" x2="13" y2="13" />
          <line x1="13" y1="17" x2="13" y2="19" />
        </svg>
      );
    case "edit-profile":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M18.5 14.5l3 3M21 11l-7 7-3 1 1-3 7-7a2.1 2.1 0 0 1 3 3z" />
        </svg>
      );
    case "bank":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 10l9-6 9 6" />
          <path d="M5 10v10h14V10" />
          <line x1="9" y1="14" x2="9" y2="18" />
          <line x1="12" y1="14" x2="12" y2="18" />
          <line x1="15" y1="14" x2="15" y2="18" />
          <line x1="3" y1="20" x2="21" y2="20" />
        </svg>
      );
    case "phone":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
          <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
        </svg>
      );
  }
}
