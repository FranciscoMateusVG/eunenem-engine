// aperture-3d9t — Footer.
//
// Logo + tagline + contact email. Plum background tone so it
// terminates the page with weight after the cream-2 mural.

export function Footer() {
  return (
    <footer
      style={{
        background: "var(--plum)",
        color: "#fff",
        padding: "48px 0 32px",
      }}
    >
      <div className="eu-container flex flex-col md:flex-row md:items-center md:justify-between gap-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "rgba(255, 255, 255, 0.18)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-patrick-hand), cursive",
              fontSize: 22,
              paddingBottom: 2,
            }}
          >
            ♡
          </span>
          <div>
            <div
              style={{
                fontFamily: "var(--font-patrick-hand), cursive",
                fontSize: 24,
                lineHeight: 1,
              }}
            >
              EuNeném
            </div>
            <div
              style={{
                fontFamily: "var(--font-caveat), cursive",
                fontSize: 18,
                color: "rgba(255, 255, 255, 0.7)",
                transform: "rotate(-1deg)",
                display: "inline-block",
                marginTop: 4,
              }}
            >
              chá de bebê online — feito com carinho ♡
            </div>
          </div>
        </div>

        <div style={{ fontSize: 13, color: "rgba(255, 255, 255, 0.7)" }}>
          <a
            href="mailto:oi@eunenem.com.br"
            style={{ color: "rgba(255,255,255,0.85)", textDecoration: "none" }}
          >
            oi@eunenem.com.br
          </a>
        </div>
      </div>

      <div
        className="eu-container"
        style={{
          marginTop: 28,
          paddingTop: 18,
          borderTop: "1px solid rgba(255, 255, 255, 0.12)",
          fontSize: 11,
          color: "rgba(255, 255, 255, 0.55)",
          letterSpacing: "0.04em",
        }}
      >
        Pré-visualização — todos os pagamentos e listas são mockados.
      </div>
    </footer>
  );
}
