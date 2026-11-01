// aperture-i06qu — guest → creator growth CTA. Guests on a gift page are
// often expecting a baby themselves; this invites them to create their own
// list without competing with the gift flow: it sits below the mural on the
// guest page and as a quiet text link on the success screens. It opens in a
// new tab so an unpaid cart (not persisted) or a confirming payment is never
// navigated away from. The UTMs land as signup first touch (see
// lib/signup-attribution.ts: a guest-route first touch yields to them).

export type CriarListaMedium = 'guest_page' | 'guest_success';

export function criarListaHref(medium: CriarListaMedium): string {
  const params = new URLSearchParams({
    utm_source: 'eunenem',
    utm_medium: medium,
    utm_campaign: 'guest_to_creator',
  });
  return `/login?${params.toString()}`;
}

/** Guest page band, below the mural. */
export function CriarListaBanner() {
  return (
    <section
      aria-labelledby="criar-lista-cta-title"
      data-testid="criar-lista-cta"
      style={{ background: 'var(--cream)', padding: '40px 0 48px' }}
    >
      <div className="eu-container">
        <div
          style={{
            maxWidth: 640,
            margin: '0 auto',
            background: 'var(--paper)',
            border: '1.5px dashed var(--lilac)',
            borderRadius: 24,
            padding: '24px 22px',
            textAlign: 'center',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <span className="eyebrow eyebrow-coral" style={{ fontSize: 20 }}>
            esperando bebê? ♡
          </span>
          <h2
            id="criar-lista-cta-title"
            style={{ fontSize: 'clamp(22px, 3vw, 28px)', color: 'var(--plum)', margin: '6px 0 8px' }}
          >
            Crie sua lista grátis
          </h2>
          <p
            style={{
              color: 'var(--ink-soft)',
              fontSize: 14.5,
              lineHeight: 1.5,
              margin: '0 auto 18px',
              maxWidth: 440,
            }}
          >
            Monte sua lista de chá de bebê em minutos. Seus convidados presenteiam e você recebe em
            dinheiro via Pix.
          </p>
          <a
            href={criarListaHref('guest_page')}
            target="_blank"
            rel="noopener"
            style={{
              display: 'inline-block',
              background: 'transparent',
              color: 'var(--plum)',
              border: '1.5px solid var(--lilac-deep)',
              borderRadius: 999,
              padding: '10px 22px',
              fontWeight: 600,
              fontSize: 14.5,
              textDecoration: 'none',
            }}
          >
            criar minha lista grátis →
          </a>
        </div>
      </div>
    </section>
  );
}

/** Quiet line under the success-screen actions. */
export function CriarListaLink() {
  return (
    <p
      data-testid="criar-lista-cta"
      style={{
        margin: '20px auto 0',
        paddingTop: 16,
        borderTop: '1px solid var(--line)',
        width: '100%',
        maxWidth: 320,
        textAlign: 'center',
        fontSize: 13.5,
        color: 'var(--ink-soft)',
        lineHeight: 1.5,
      }}
    >
      Esperando bebê?{' '}
      <a
        href={criarListaHref('guest_success')}
        target="_blank"
        rel="noopener"
        style={{ color: 'var(--plum)', fontWeight: 600 }}
      >
        Crie sua lista grátis →
      </a>
    </p>
  );
}
