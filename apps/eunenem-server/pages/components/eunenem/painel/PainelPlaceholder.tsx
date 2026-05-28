import { PAINEL_SECTION_META, painelHref, type PainelSection } from "@/lib/painelRoutes";

// aperture-vv3i — "em construção" body for painel sections whose real page
// hasn't been built yet. Rendered inside PainelLayout so the route is LIVE and
// on-brand (not a dead href="#" or a raw 404). Each page bead replaces this by
// registering its component in painelSections.tsx — no change needed here.
//
// On-brand per Sistema de Design: cream shell, white card with plum-tinted
// shadow, Caveat eyebrow (rotated), Patrick Hand title, yellow marca-texto on
// the "em breve" word, lilás CTA back to the dashboard.

interface Props {
  slug: string;
  section: PainelSection;
}

export function PainelPlaceholder({ slug, section }: Props) {
  const meta = PAINEL_SECTION_META[section];

  return (
    <section
      className="painel-header-card"
      style={{ padding: "28px 22px", textAlign: "left" }}
    >
      <span
        style={{
          fontFamily: "var(--font-caveat), cursive",
          color: "var(--coral-pink)",
          fontSize: 22,
          display: "inline-block",
          transform: "rotate(-2deg)",
          transformOrigin: "left",
        }}
      >
        {meta.eyebrow}
      </span>

      <h1
        style={{
          fontFamily: "var(--font-patrick-hand), cursive",
          color: "var(--plum)",
          fontSize: 34,
          margin: "6px 0 0",
          textWrap: "balance",
        }}
      >
        {meta.title}
      </h1>

      <p
        style={{
          fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
          color: "var(--ink-soft)",
          fontSize: 15,
          lineHeight: 1.5,
          margin: "12px 0 0",
          maxWidth: 420,
        }}
      >
        {meta.note}{" "}
        <span
          className="hl"
          style={{ fontFamily: "var(--font-patrick-hand), cursive" }}
        >
          em breve
        </span>
        .
      </p>

      <a
        href={painelHref(slug)}
        className="painel-cta"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          marginTop: 22,
          background: "var(--lilac)",
          color: "#fff",
          padding: "12px 20px",
          borderRadius: 999,
          fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: ".04em",
          textTransform: "uppercase",
          textDecoration: "none",
          boxShadow: "var(--shadow-cta)",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ width: 16, height: 16 }}
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        voltar ao painel
      </a>
    </section>
  );
}
