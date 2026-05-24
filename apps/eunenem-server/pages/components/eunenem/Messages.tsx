
import { useState } from "react";
import { FlowerDoodle, HeartDoodle, Tape } from "./Doodles";
import { useTweaks } from "./TweaksContext";
import { useMural } from "./MuralContext";
import { type MuralMessage } from "@/lib/mocks/messages";

// aperture-3d9t — Mural section ("o mural do <baby>").
//
// Grid of message cards. Each card:
// - rotated -3 to 3 degrees
// - scrapbook tape on top edge
// - avatar circle with initials + colored bg
// - name + timeAgo metadata
// - body in Caveat (italic + quotes) OR DM Sans (plain) per style
// - hover lifts the card and straightens its rotation
//
// Composer card at the end: dashed lilac border, "Escolher presente"
// CTA that anchor-jumps to the marketplace.

export function Messages() {
  const { tweaks } = useTweaks();
  const { messages, addMessage } = useMural();
  const [showComposer, setShowComposer] = useState(false);

  return (
    <section
      id="mural"
      className="eu-section relative overflow-hidden"
      style={{ background: "var(--cream-2)" }}
    >
      <FlowerDoodle
        size={26}
        className="anim-doodle-sway"
        style={{
          position: "absolute",
          top: 80,
          left: "6%",
          opacity: 0.35,
          ["--r" as string]: "-6deg",
        }}
      />
      <HeartDoodle
        size={18}
        color="var(--lilac-deep)"
        style={{
          position: "absolute",
          top: 120,
          right: "8%",
          opacity: 0.5,
          transform: "rotate(10deg)",
        }}
      />

      <div className="eu-container">
        <header style={{ textAlign: "center", marginBottom: 48 }}>
          <span className="eyebrow eyebrow-coral">com carinho ♡</span>
          <h2
            style={{
              fontSize: "clamp(36px, 4.4vw, 52px)",
              marginTop: 8,
            }}
          >
            o mural do{" "}
            <span style={{ color: "var(--coral-pink)" }}>
              {tweaks.babyName}
            </span>
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
            Cada presente vem com um recadinho pro {tweaks.babyName} já se
            acostumar com a voz de vocês. ♡
          </p>
        </header>

        <div
          className="grid gap-7"
          style={{
            gridTemplateColumns:
              "repeat(auto-fill, minmax(280px, 1fr))",
          }}
        >
          {messages.map((m) => (
            <MessageCard key={m.id} m={m} />
          ))}

          <ComposerCard
            babyName={tweaks.babyName}
            open={showComposer}
            onOpenChange={setShowComposer}
            onSubmit={(message) => {
              addMessage({
                authorName: "Você",
                avatarBg: "var(--lilac-deep)",
                avatarInitials: "VC",
                timeAgo: "agora há pouco",
                message,
                style: "caveat",
                rotation: -1,
              });
              setShowComposer(false);
            }}
          />
        </div>
      </div>
    </section>
  );
}

function MessageCard({ m }: { m: MuralMessage }) {
  const [hover, setHover] = useState(false);
  const isCaveat = m.style === "caveat";

  return (
    <article
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 18,
        padding: "22px 22px 18px",
        boxShadow: "var(--shadow-md)",
        position: "relative",
        transition: "transform 0.25s ease",
        transform: hover
          ? "rotate(0deg) translateY(-4px)"
          : `rotate(${m.rotation}deg)`,
      }}
    >
      <Tape
        width={70}
        height={18}
        rotate={-2}
        style={{
          top: -10,
          left: "50%",
          marginLeft: -35,
        }}
      />

      <div className="flex items-center gap-3 mb-3">
        <span
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            border: "2.5px solid #fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontFamily: "var(--font-patrick-hand), cursive",
            fontSize: 22,
            boxShadow: "var(--shadow-sm)",
            background: m.avatarBg,
            flexShrink: 0,
          }}
        >
          {m.avatarInitials}
        </span>
        <div>
          <div
            style={{
              fontWeight: 700,
              color: "var(--ink)",
              fontSize: 15,
              lineHeight: 1.1,
            }}
          >
            {m.authorName}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-mute)" }}>
            {m.timeAgo}
          </div>
        </div>
      </div>

      <div
        style={
          isCaveat
            ? {
                fontFamily: "var(--font-caveat), cursive",
                fontSize: 24,
                color: "var(--ink)",
                lineHeight: 1.25,
              }
            : {
                fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
                fontSize: 15,
                color: "var(--ink-soft)",
                lineHeight: 1.5,
              }
        }
      >
        {isCaveat ? `"${m.message}"` : m.message}
      </div>
    </article>
  );
}

interface ComposerCardProps {
  babyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (message: string) => void;
}

function ComposerCard({
  babyName,
  open,
  onOpenChange,
  onSubmit,
}: ComposerCardProps) {
  const [text, setText] = useState("");

  if (!open) {
    return (
      <div
        style={{
          background: "var(--paper)",
          border: "1.5px dashed var(--lilac)",
          borderRadius: 18,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          minHeight: 220,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-patrick-hand), cursive",
            fontSize: 24,
            color: "var(--plum)",
            marginBottom: 8,
          }}
        >
          seu recadinho aqui
        </div>
        <p
          style={{
            fontSize: 14,
            color: "var(--ink-soft)",
            marginBottom: 18,
          }}
        >
          Escolha um presente e deixe uma mensagem
          <br />
          pro {babyName} no checkout.
        </p>
        <div className="flex gap-2 flex-wrap justify-center">
          <a href="#presentes" className="btn-lilac no-underline">
            Escolher presente
          </a>
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            className="btn-outline"
          >
            Só deixar recado
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim().length === 0) return;
        onSubmit(text.trim());
        setText("");
      }}
      style={{
        background: "var(--paper)",
        border: "1.5px solid var(--lilac)",
        borderRadius: 18,
        padding: 22,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minHeight: 220,
      }}
    >
      <label
        htmlFor="composer-message"
        style={{
          fontFamily: "var(--font-caveat), cursive",
          fontSize: 22,
          color: "var(--plum)",
          transform: "rotate(-1deg)",
          display: "inline-block",
        }}
      >
        recadinho pro {babyName} ♡
      </label>
      <textarea
        id="composer-message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={280}
        autoFocus
        placeholder="Conta uma história, manda um abraço, deixa um conselho..."
        style={{
          width: "100%",
          padding: 12,
          borderRadius: 14,
          border: "1.5px solid var(--line)",
          fontSize: 15,
          fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
          color: "var(--ink)",
          lineHeight: 1.5,
          background: "var(--cream)",
          resize: "vertical",
          minHeight: 80,
          outline: "none",
        }}
      />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span style={{ fontSize: 12, color: "var(--ink-mute)" }}>
          {text.length}/280
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setText("");
              onOpenChange(false);
            }}
            className="btn-outline"
            style={{ padding: "8px 16px", fontSize: 12 }}
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={text.trim().length === 0}
            className="btn-lilac"
            style={{ padding: "10px 18px", fontSize: 12 }}
          >
            Postar no mural
          </button>
        </div>
      </div>
    </form>
  );
}
