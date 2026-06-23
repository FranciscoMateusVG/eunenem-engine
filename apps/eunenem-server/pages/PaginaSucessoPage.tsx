// aperture-xh4jk — Visitor lands here after Stripe processes their payment.
// Stripe's return_url pattern: /pagina/<slug>/sucesso?sessionId={CHECKOUT_SESSION_ID}
//
// This page READS the payment result via trpc.pagina.obterSucessoPagamento
// (Rex's aperture-vkrkm). The contribuicao state flip + mural insert both
// happen server-side via the webhook (Rex's aperture-24n36) — this page
// stays read-only so the post-redirect render is the single source of
// truth for what the visitor sees.
//
// CRAFT NOTE: this is the warm moment of the entire flow. Someone just
// gave money to make a baby's life easier. The page they land on is what
// they'll remember. Polaroid framing the gift, Caveat for the recadinho
// rotated like real handwriting, lilac/plum/cream palette — every choice
// here is on purpose.
//
// SCAFFOLD-FIRST: while Rex's pagina-router lands (aperture-vkrkm), this
// page consumes the typed boundary hook from @/lib/paginaApi.ts (added in
// aperture-3xgch, merged via PR #73). When Rex's real procs ship, the
// stub body inside paginaApi.useObterSucessoPagamento gets swapped to
// trpc.pagina.obterSucessoPagamento.useQuery and this component doesn't
// change at all.

import { useEffect, useMemo, useState } from "react";
import { Navbar } from "./components/eunenem/Navbar";
import { Footer } from "./components/eunenem/Footer";
import { BottleDoodle, FlowerDoodle, HeartDoodle } from "./components/eunenem/Doodles";
import { TweaksProvider } from "./components/eunenem/TweaksContext";
import {
  useObterSucessoPagamento,
  type ObterSucessoResult,
} from "@/lib/paginaApi";

// ── Page ──────────────────────────────────────────────────────────────────

export function PaginaSucessoPage({ slug }: { slug: string }) {
  // sessionId comes from ?sessionId= — read client-side only since the SSR
  // route resolver doesn't see query strings. First server render shows the
  // skeleton; client hydrates, reads the param, fires the query.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSessionId(params.get("sessionId"));
    setHydrated(true);
  }, []);

  const { data, isError, isLoading } = useObterSucessoPagamento(slug, sessionId, {
    enabled: hydrated,
    pollWhilePending: true,
  });

  // Track elapsed time on pending so we can soften the messaging if it
  // hangs. After ~30s we add a reassurance line.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (data?.status !== "pending") {
      setElapsedSec(0);
      return;
    }
    const t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [data?.status]);

  return (
    <TweaksProvider>
      <>
        <Navbar slug={slug} />
        <main
          className="flex-1 pt-16 sucesso-bg"
          aria-live={data?.status === "pending" ? "polite" : "off"}
        >
          <div className="eu-container sucesso-stage">
            {!hydrated || (isLoading && !data) ? (
              <SkeletonState />
            ) : !sessionId ? (
              <ExpiredState slug={slug} />
            ) : isError ? (
              <FailedState slug={slug} />
            ) : !data ? (
              <SkeletonState />
            ) : data.status === "approved" ? (
              <ApprovedState data={data} slug={slug} />
            ) : data.status === "pending" ? (
              <PendingState data={data} elapsedSec={elapsedSec} />
            ) : data.status === "rejected" ? (
              <FailedState slug={slug} />
            ) : (
              // status === 'unknown' — sessionId resolved but nothing has
              // settled yet (webhook hasn't fired AND provider sessao is
              // missing). Render as the friendly "sessão expirada" state.
              <ExpiredState slug={slug} />
            )}
          </div>
        </main>
        <Footer />
      </>
    </TweaksProvider>
  );
}

// ── Approved (the warm moment) ────────────────────────────────────────────

function ApprovedState({
  data,
  slug,
}: {
  data: ObterSucessoResult;
  slug: string;
}) {
  const valorBRL = useMemo(() => Math.round(data.valor / 100), [data.valor]);
  return (
    <section className="sucesso-section sucesso-section--approved">
      {/* Soft doodles in the corners — same family as the visitor page so
          the success page reads as 'still inside eunenem' not as a generic
          confirmation screen. */}
      <BottleDoodle
        size={28}
        className="anim-doodle-sway sucesso-doodle sucesso-doodle--tl"
        style={{ ["--r" as string]: "-12deg" }}
      />
      <FlowerDoodle
        size={28}
        className="anim-doodle-sway sucesso-doodle sucesso-doodle--tr"
        style={{ ["--r" as string]: "10deg" }}
      />
      <HeartDoodle
        size={22}
        className="anim-doodle-sway sucesso-doodle sucesso-doodle--bl"
        style={{ ["--r" as string]: "8deg" }}
      />
      <HeartDoodle
        size={22}
        className="anim-doodle-sway sucesso-doodle sucesso-doodle--br"
        style={{ ["--r" as string]: "-8deg" }}
      />

      <span className="eyebrow eyebrow-coral sucesso-eyebrow">
        recebemos seu carinho ♡
      </span>
      <h1 className="sucesso-h1">
        obrigado
        {data.contribuinte.nome ? (
          <>
            , <span className="sucesso-h1-name">{firstName(data.contribuinte.nome)}</span>
          </>
        ) : null}
        !
      </h1>

      {/* Polaroid — the visual anchor. Tilted 1.8deg, soft-shadow, paper
          tape on top-left to feel like it was stuck onto the page. */}
      <article className="sucesso-polaroid anim-polaroid-drop" aria-labelledby="sucesso-gift-name">
        <span className="sucesso-polaroid-tape" aria-hidden="true" />
        <div className="sucesso-polaroid-photo">
          <span aria-hidden="true" className="sucesso-polaroid-emoji">
            🎁
          </span>
          <span className="sucesso-polaroid-stamp" aria-hidden="true">
            ✓ presenteado
          </span>
        </div>
        <div className="sucesso-polaroid-caption">
          <h2 id="sucesso-gift-name" className="sucesso-gift-name">
            {data.giftName}
          </h2>
          <p className="sucesso-gift-valor">R$ {valorBRL} ♡</p>
        </div>
      </article>

      {/* Recadinho — the moment of warmth. Caveat, rotated -1.5deg, max
          width tight so the line breaks like a handwritten note. Falls back
          to a polite default when Stripe's custom_fields.mensagem is empty
          (operator decision 2026-05-31: never render blank). */}
      <blockquote className="sucesso-recadinho anim-recadinho-in">
        <span aria-hidden="true" className="sucesso-recadinho-quote">"</span>
        {data.recadinho && data.recadinho.trim().length > 0
          ? data.recadinho
          : `um abraço apertado pro ${data.babyName} ♡`}
        <span aria-hidden="true" className="sucesso-recadinho-quote sucesso-recadinho-quote--end">"</span>
      </blockquote>

      <p className="sucesso-tagline">
        ...e o <span className="sucesso-tagline-name">{data.babyName}</span> já vai saber! ♡
      </p>

      <a href={`/pagina/${slug}`} className="btn-lilac sucesso-cta">
        voltar pra listinha ←
      </a>
    </section>
  );
}

// ── Pending (auto-refetch with reassurance) ───────────────────────────────

function PendingState({
  data,
  elapsedSec,
}: {
  data: ObterSucessoResult;
  elapsedSec: number;
}) {
  return (
    <section className="sucesso-section sucesso-section--pending">
      <span className="eyebrow eyebrow-coral sucesso-eyebrow">processando ♡</span>
      <h1 className="sucesso-h1">
        estamos confirmando<span className="sucesso-h1-dots">...</span>
      </h1>

      <article className="sucesso-polaroid sucesso-polaroid--pending" aria-busy="true">
        <span className="sucesso-polaroid-tape" aria-hidden="true" />
        <div className="sucesso-polaroid-photo anim-skeleton-pulse" />
        <div className="sucesso-polaroid-caption">
          <h2 className="sucesso-gift-name">{data.giftName}</h2>
          <p className="sucesso-gift-valor">aguardando pagamento</p>
        </div>
      </article>

      <p className="sucesso-pending-copy">
        geralmente leva alguns segundos — vamos te avisar aqui mesmo quando
        cair ♡
      </p>

      {elapsedSec > 30 && (
        <p className="sucesso-pending-longwait">
          tá demorando um pouquinho — fica tranquilo, vamos mandar a
          confirmação no seu email assim que cair. pode fechar essa página
          se quiser ♡
        </p>
      )}
    </section>
  );
}

// ── Failed ────────────────────────────────────────────────────────────────

function FailedState({ slug }: { slug: string }) {
  return (
    <section className="sucesso-section sucesso-section--failed">
      <span className="eyebrow eyebrow-coral sucesso-eyebrow">ops</span>
      <h1 className="sucesso-h1">não deu certo dessa vez ♡</h1>

      <article className="sucesso-polaroid sucesso-polaroid--failed" aria-hidden="true">
        <span className="sucesso-polaroid-tape" aria-hidden="true" />
        <div className="sucesso-polaroid-photo">
          <span className="sucesso-polaroid-emoji" aria-hidden="true">
            🌧️
          </span>
        </div>
        <div className="sucesso-polaroid-caption">
          <h2 className="sucesso-gift-name">pagamento não concluído</h2>
          <p className="sucesso-gift-valor">tudo bem, pode tentar de novo</p>
        </div>
      </article>

      <p className="sucesso-pending-copy">
        seu cartão ou Pix não foi cobrado. pode escolher o presente de novo
        que vai dar certo ♡
      </p>

      <a href={`/pagina/${slug}`} className="btn-lilac sucesso-cta">
        tentar de novo →
      </a>
    </section>
  );
}

// ── Expired / session-not-found ──────────────────────────────────────────

function ExpiredState({ slug }: { slug: string }) {
  return (
    <section className="sucesso-section sucesso-section--expired">
      <span className="eyebrow eyebrow-coral sucesso-eyebrow">sessão</span>
      <h1 className="sucesso-h1">essa sessão já passou ♡</h1>

      <p className="sucesso-pending-copy" style={{ maxWidth: 520 }}>
        o link que te trouxe aqui expirou ou não é mais válido — não te
        preocupa, é só voltar pra listinha e escolher um presente de novo.
      </p>

      <a href={`/pagina/${slug}`} className="btn-lilac sucesso-cta">
        voltar pra listinha →
      </a>
    </section>
  );
}

// ── Skeleton (first paint / hydration) ───────────────────────────────────

function SkeletonState() {
  return (
    <section className="sucesso-section" aria-busy="true">
      <div
        className="anim-skeleton-pulse"
        style={{
          height: 28,
          width: 180,
          borderRadius: 999,
          background: "var(--cream-2)",
          margin: "0 auto 24px",
        }}
      />
      <div
        className="anim-skeleton-pulse"
        style={{
          height: 64,
          width: "min(420px, 80%)",
          borderRadius: 16,
          background: "var(--cream-2)",
          margin: "0 auto 48px",
        }}
      />
      <article className="sucesso-polaroid sucesso-polaroid--pending" aria-hidden="true">
        <span className="sucesso-polaroid-tape" aria-hidden="true" />
        <div className="sucesso-polaroid-photo anim-skeleton-pulse" />
        <div className="sucesso-polaroid-caption">
          <div
            className="anim-skeleton-pulse"
            style={{
              height: 26,
              width: "60%",
              borderRadius: 8,
              background: "var(--cream-2)",
              margin: "0 auto 10px",
            }}
          />
          <div
            className="anim-skeleton-pulse"
            style={{
              height: 18,
              width: "30%",
              borderRadius: 8,
              background: "var(--cream-2)",
              margin: "0 auto",
            }}
          />
        </div>
      </article>
    </section>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}
