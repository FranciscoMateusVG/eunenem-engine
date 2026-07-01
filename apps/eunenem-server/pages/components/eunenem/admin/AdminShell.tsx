import type { ReactNode } from "react";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { DddBadge, type Bc } from "./DddBadge";
import { UserPicker } from "./UserPicker";

/**
 * AdminShell — the engineering view's frame on eunenem-server.
 *
 * Layout: sidebar (left rail) + main content. The sidebar carries the
 * brand mark + DDD nav and stays visible at every drill depth so the
 * operator always knows where they are. On narrow widths it collapses
 * to a top strap (the brief explicitly asks for a sidebar; on phone
 * widths the sidebar becomes a top section so content gets the screen).
 *
 * Visual contract (engineering view, NOT customer scrapbook):
 * - Background: bg-paper (white). Customer pages are warm/photographed;
 *   admin is precise/tabular.
 * - No Patrick Hand / Caveat anywhere. Default sans is DM Sans (loaded
 *   by the root layout); technical labels (routes, IDs, BC tags) are
 *   `font-mono`. The `[data-admin]` scope reset in tailwind.css keeps
 *   the customer page rule (h1/h2/h3/h4 → Patrick Hand) from leaking in.
 * - Hairline borders in `border-line`.
 * - The DDD-badge strap at the top of `<main>` is the operator's
 *   wayfinding — they always know which BC they're in.
 *
 * v1 has NO AUTH (operator directive). The chip in the sidebar says so
 * explicitly so nobody wonders whether someone is logged in.
 */

export type Crumb = {
  label: string;
  href?: string;
};

type AdminShellProps = {
  children: ReactNode;
  /** Breadcrumb. Last entry is the current page. Pass [] to hide. */
  breadcrumb?: Crumb[];
  /**
   * Active bounded context shown in the wayfinding strap.
   * Pass `null` for an aggregate page (landing renders a legend).
   */
  activeBc?: Bc | null;
  /** Right-aligned context shown next to the active BC. */
  bcContext?: ReactNode;
  /** Active section in the sidebar nav. Defaults to "landing". */
  activeNav?: NavKey;
};

type NavKey = "landing" | "repasses";

const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; href: string }> = [
  { key: "landing", label: "Visão geral", href: "/admin" },
  // plan q2d4b Track 3 — operator-facing recebedor repasses approval queue.
  // Lives as a sidebar sibling to Visão geral because it's a dedicated
  // operator workflow surface (action queue + historical record), not a
  // drill-down off the landing table.
  { key: "repasses", label: "Repasses", href: "/admin/repasses" },
];

export function AdminShell({
  children,
  breadcrumb = [],
  activeBc,
  bcContext,
  activeNav = "landing",
}: AdminShellProps) {
  // aperture-r5fg0 — UX gate. The REAL security boundary is the backend: every
  // admin.* tRPC proc 403s a non-allowlisted user server-side (aperture-4n222 /
  // #313), so this is purely about not showing admin chrome to non-admins.
  // auth.me.isAdmin is true iff the logged-in email is in the server allowlist;
  // null (logged out) → not admin. Non-admins are redirected home, and we never
  // render the shell/children (nor mount their admin.* queries) until confirmed.
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 0 });
  // Defensive read — isAdmin lands with #313; treat absent/false/logged-out as
  // NON-admin (fail-closed UX). This PR must merge after #313 so admins aren't
  // locked out while isAdmin is still undefined on the wire.
  const isAdmin =
    (me.data as { isAdmin?: boolean } | null | undefined)?.isAdmin === true;
  const decided = !me.isLoading;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (decided && !isAdmin) window.location.assign("/");
  }, [decided, isAdmin]);

  if (!decided || !isAdmin) {
    return (
      <div
        data-admin
        className="flex min-h-screen w-full items-center justify-center bg-paper text-ink-soft"
        role="status"
        aria-live="polite"
        aria-label="verificando acesso"
      >
        <span className="perfil-spinner" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      data-admin
      className="min-h-screen w-full bg-paper text-ink"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-0 lg:flex-row">
        <Sidebar activeNav={activeNav} />
        <div className="flex min-w-0 flex-1 flex-col">
          {breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} />}
          <BcStrap activeBc={activeBc} bcContext={bcContext} />
          <main className="px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}

function Sidebar({ activeNav }: { activeNav: NavKey }) {
  return (
    <aside
      aria-label="Admin navigation"
      className="border-b border-line bg-cream-2/40 lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r"
    >
      <div className="px-4 py-4 sm:px-6 lg:sticky lg:top-0 lg:px-5 lg:py-6">
        <a
          href="/admin"
          className="group flex items-center gap-2 text-ink hover:text-plum"
        >
          <span
            aria-hidden
            className="inline-block size-2 shrink-0 rounded-sm bg-plum"
          />
          <span className="whitespace-nowrap font-mono text-[13px] font-semibold uppercase tracking-[0.18em]">
            EuNeném · Admin
          </span>
        </a>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          DDD trace
        </p>

        <nav
          aria-label="Admin sections"
          className="mt-5 flex gap-2 overflow-x-auto lg:mt-6 lg:flex-col lg:gap-1 lg:overflow-visible"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = item.key === activeNav;
            return (
              <a
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "whitespace-nowrap rounded-md px-3 py-2 font-mono text-[12px] uppercase tracking-[0.12em] transition-colors",
                  isActive
                    ? "bg-paper text-ink shadow-[0_1px_0_var(--line)]"
                    : "text-ink-soft hover:bg-paper/60 hover:text-plum",
                ].join(" ")}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <QuickJump />

        <ConsumerLink />
      </div>
    </aside>
  );
}

/**
 * Sidebar quick-jump. Embeds the W1 UserPicker combobox as a "jump to a
 * user by email" affordance available from every admin page. The browse
 * table on /admin landing is the default for discovery; this is the
 * shortcut for operators who already know the email they want.
 */
function QuickJump() {
  return (
    <div className="mt-6 hidden lg:block">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        Jump to user
      </p>
      <UserPicker />
    </div>
  );
}

function ConsumerLink() {
  return (
    <a
      href="/"
      className="mt-4 hidden font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft hover:text-plum lg:inline-block"
      aria-label="Back to consumer site"
    >
      ← consumer
    </a>
  );
}

function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="border-b border-line bg-cream-2/40"
    >
      <ol className="flex flex-wrap items-center gap-2 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft sm:px-6">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li
              key={`${item.label}-${i}`}
              className="flex items-center gap-2"
            >
              {item.href && !isLast ? (
                <a href={item.href} className="hover:text-plum">
                  {item.label}
                </a>
              ) : (
                <span
                  className={isLast ? "text-ink" : undefined}
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isLast && (
                <span aria-hidden className="text-ink-mute">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function BcStrap({
  activeBc,
  bcContext,
}: {
  activeBc: Bc | null | undefined;
  bcContext: ReactNode;
}) {
  return (
    <div className="border-b border-line bg-paper">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            BC
          </span>
          {activeBc ? (
            <DddBadge bc={activeBc} size="md" />
          ) : (
            <span className="font-mono text-[11px] tracking-[0.05em] text-ink-soft">
              — landing —
            </span>
          )}
        </div>
        {bcContext ? (
          <div className="font-mono text-[11px] tracking-[0.05em] text-ink-soft">
            {bcContext}
          </div>
        ) : null}
      </div>
    </div>
  );
}
