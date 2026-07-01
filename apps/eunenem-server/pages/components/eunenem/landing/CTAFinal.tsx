import { useRef } from 'react';
import { useAuthModal } from '@/components/eunenem/auth/AuthModalProvider';

// aperture-q1j2 — final CTA on a tri-stop gradient.
// aperture-nop8l — CTA opens signup modal. FAQ moved to standalone /faq page.
export function CTAFinal() {
  const auth = useAuthModal();
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section
      className="fade-up py-22 relative overflow-hidden"
      style={{
        background:
          'linear-gradient(135deg, #FBE0EA 0%, #E8D5F0 50%, #FBF1E0 100%)',
      }}
    >
      <div
        className="absolute -top-50 -left-25 w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(255,255,255,0.5), transparent 60%)',
        }}
      />
      <div
        className="absolute -bottom-50 -right-25 w-[600px] h-[600px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(247,213,96,0.3), transparent 60%)',
        }}
      />

      <div className="relative z-10 mx-auto max-w-[800px] px-6 text-center">
        <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
          a sua data está chegando ✨
        </span>
        <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
          quanto antes{' '}
          <em className="not-italic text-lilac-deep">criar a lista</em>, mais
          tempo seus convidados têm para presentear.
        </h2>
        <p className="text-[17px] text-ink-soft my-6 max-w-[540px] mx-auto text-pretty">
          Junte-se a mais de 300 mil famílias que celebraram com a EuNeném.
        </p>
        <button
          ref={ctaRef}
          type="button"
          onClick={() => auth.open('signup', ctaRef.current)}
          className="btn-lilac btn-lilac-lg"
        >
          → criar minha lista agora — é grátis
        </button>
        <p className="text-[13px] text-ink-mute mt-4.5">
          Menos de 2 minutos · transparência total em taxas · suporte via
          WhatsApp
        </p>

      </div>
    </section>
  );
}
