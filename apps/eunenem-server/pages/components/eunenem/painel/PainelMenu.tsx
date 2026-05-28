
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

export function PainelMenu({ groups, slug }: Props) {
  return (
    <div className="painel-menu-wrap">
      <div className="painel-menu-grid">
        {groups.map((group) => (
          <section key={group.id} className="painel-group">
            <div className="painel-group-title">{group.title}</div>
            <div className="painel-list">
              {group.items.map((item) => (
                <PainelMenuRow key={item.id} item={item} slug={slug} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
