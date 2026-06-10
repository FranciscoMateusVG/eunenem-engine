
import type { PainelMenuGroup } from "@/lib/mocks/painelDemo";
import { PainelMenuRow } from "./PainelMenuRow";

// aperture-i01o — Painel menu grid (1 col mobile, 2 col desktop).
//
// Pure layout component — takes pre-built groups (so the parent can
// thread snapshot counts through buildPainelMenu()) and renders each
// as a titled list of rows. The grid CSS lives in globals.css under
// .painel-menu-grid / .painel-group.
//
// Visual fidelity carries over from Thacy v3: list cards have a 22px
// radius + paper background, group titles are eyebrow-style with a
// fading-line accent, first row in each group has a top-margin
// adjustment so the title-to-card gap stays consistent.

interface Props {
  groups: PainelMenuGroup[];
  /** Creator slug — threaded to each row so it can resolve its destination
   *  href via the painelRoutes convention (aperture-vv3i). */
  slug: string;
}

// aperture-lwkwx — per-column flex containers (replaces aperture-cihww's
// grid-row placement). The grid-row approach left a dead-space gap under
// CONVIDADOS because CSS Grid sized row 1 by the tallest left-col group
// (SEU EVENTO with 4 rows), leaving CONVIDADOS short of row 1's edge
// and CONTA "hanging" on row 2. Per-column flex acknowledges the two
// columns as conceptually independent (visitor-lane vs admin-lane)
// and lets each column stack flush regardless of the other's height.
//
// Left column: SEU EVENTO + NOVO/rifa
// Right column: CONVIDADOS + CONTA & AJUDA
// Mobile (<900px): both columns collapse, source order honored
// (evento → convidados → novo → conta).
const LEFT_COLUMN_IDS = new Set(['evento', 'novo']);

export function PainelMenu({ groups, slug }: Props) {
  const leftGroups = groups.filter((g) => LEFT_COLUMN_IDS.has(g.id));
  const rightGroups = groups.filter((g) => !LEFT_COLUMN_IDS.has(g.id));

  return (
    <div className="painel-menu-wrap">
      <div className="painel-menu-grid">
        <div className="painel-menu-col">
          {leftGroups.map((group) => (
            <PainelGroupCard key={group.id} group={group} slug={slug} />
          ))}
        </div>
        <div className="painel-menu-col">
          {rightGroups.map((group) => (
            <PainelGroupCard key={group.id} group={group} slug={slug} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PainelGroupCard({
  group,
  slug,
}: {
  group: PainelMenuGroup;
  slug: string;
}) {
  return (
    <section className={`painel-group painel-group-${group.id}`}>
      <div className="painel-group-title">{group.title}</div>
      <div className="painel-list">
        {group.items.map((item) => (
          <PainelMenuRow key={item.id} item={item} slug={slug} />
        ))}
      </div>
    </section>
  );
}
