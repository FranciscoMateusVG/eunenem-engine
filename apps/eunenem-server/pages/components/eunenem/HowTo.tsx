
import { useState } from "react";
import { HeartDoodle, StarDoodle } from "./Doodles";

// aperture-3d9t — HowTo section (4-step explainer).
//
// Each step: numbered circle in corner + rotated colored block with
// emoji + Patrick Hand title + DM Sans description. Hover wiggles
// the block (rotate flip + lift) with overshoot easing per Visual
// Identity §8.

interface Step {
  n: number;
  emoji: string;
  color: string;
  rot: number;
  title: string;
  desc: string;
}

const STEPS: Step[] = [
  {
    n: 1,
    emoji: "🎁",
    color: "var(--pink)",
    rot: -3,
    title: "Escolha um presente",
    desc: 'Navegue pela listinha e clique em "Presentear". Pode ser um ou mais presentes.',
  },
  {
    n: 2,
    emoji: "✏️",
    color: "var(--green)",
    rot: 4,
    title: "Deixe uma mensagem",
    desc: "Escreva um recadinho carinhoso pros papais e pro bebê lerem no mural.",
  },
  {
    n: 3,
    emoji: "💳",
    color: "var(--blue)",
    rot: -4,
    title: "Pague com Pix ou cartão",
    desc: "Checkout seguro, em poucos cliques. Pagamento processado por parceiro certificado.",
  },
  {
    n: 4,
    emoji: "✨",
    color: "var(--lilac)",
    rot: 3,
    title: "Pronto — chegou no Pix",
    desc: "O valor cai direto na conta dos papais. Eles compram o presente do jeito que fica melhor.",
  },
];

export function HowTo() {
  return (
    <section id="como" className="eu-section" style={{ background: "var(--cream)" }}>
      <StarDoodle
        size={18}
        color="var(--yellow)"
        className="anim-twinkle"
        style={{ position: "absolute", top: 90, right: "12%" }}
      />
      <HeartDoodle
        size={20}
        color="var(--coral-pink)"
        className="anim-doodle-sway"
        style={{
          position: "absolute",
          bottom: 120,
          left: "8%",
          opacity: 0.45,
          ["--r" as string]: "-10deg",
        }}
      />

      <div className="eu-container">
        <header style={{ textAlign: "center", marginBottom: 64 }}>
          <span className="eyebrow">como funciona</span>
          <h2
            style={{
              fontSize: "clamp(36px, 4.4vw, 52px)",
              marginTop: 8,
            }}
          >
            Presentear é fácil —{" "}
            <span className="hl">e leva 2 minutos</span>
          </h2>
          <p
            style={{
              color: "var(--ink-soft)",
              fontSize: 16,
              marginTop: 12,
              maxWidth: 540,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            A gente cuida da parte chata pra você. É só escolher, pagar
            e mandar carinho.
          </p>
        </header>

        <div
          className="grid gap-7"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          {STEPS.map((s) => (
            <StepCard key={s.n} step={s} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StepCard({ step }: { step: Step }) {
  const [hover, setHover] = useState(false);

  return (
    <article
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 24,
        padding: "28px 24px",
        boxShadow: "var(--shadow-sm)",
        position: "relative",
        textAlign: "left",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: -14,
          left: 16,
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "var(--paper)",
          border: "1.5px solid var(--lilac)",
          color: "var(--lilac-deep)",
          fontFamily: "var(--font-patrick-hand), cursive",
          fontSize: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        {step.n}
      </div>
      <div
        aria-hidden="true"
        style={{
          width: 92,
          height: 92,
          borderRadius: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 40,
          color: "#fff",
          marginBottom: 22,
          boxShadow: "var(--shadow-sm)",
          background: step.color,
          transform: hover
            ? `rotate(${-step.rot - 2}deg) translateY(-6px) scale(1.06)`
            : `rotate(${step.rot}deg)`,
          transition: "transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)",
        }}
      >
        {step.emoji}
      </div>
      <h3
        style={{
          fontSize: 24,
          color: "var(--plum)",
          marginBottom: 8,
          lineHeight: 1.1,
        }}
      >
        {step.title}
      </h3>
      <p
        style={{
          fontSize: 14.5,
          color: "var(--ink-soft)",
          lineHeight: 1.55,
        }}
      >
        {step.desc}
      </p>
    </article>
  );
}
