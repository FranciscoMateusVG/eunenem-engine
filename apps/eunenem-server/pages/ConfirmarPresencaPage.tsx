import { useEffect, useState } from "react";
import { toast } from "sonner";

import { sendEvent, sendPageView } from "@/lib/analytics";
import { conviteStateFromData, useConvitePreviewData } from "@/lib/convite";
import type { FormatoMensagemConvite, StatusPresencaConvidado } from "@/lib/convidados";
import { convidadosErrorMessage } from "@/lib/convidados";
import { formatDateScrap } from "@/lib/mocks/convite";
import type { ConviteState } from "@/lib/mocks/convite";
import { paginaSharePath } from "@/lib/painelRoutes";
import { trpc } from "@/lib/trpc";
import { NotFoundPage } from "./NotFoundPage";
import { InvitePreview } from "./components/eunenem/painel/ConviteBody";

// aperture-confirmar-presenca — public (unauthenticated) RSVP page a guest
// opens from a WhatsApp link: /{slug}/confirmar-presenca/{idConvidado}.
//
// Data comes from two public tRPC procedures:
//   - eventoConvite.getPreview({ slug })                 — convite content
//     (mensagem/endereço/data/hora + visual template), already public.
//   - eventoListaDeConvidados.getParaConfirmar/{slug,id}  — this convidado's
//     nome + presenca + the host's chosen formatoMensagemConvite.
//
// No painel chrome (no PainelLayout/Navbar/Footer) — self-contained page,
// same pattern as FaqPage.tsx (own <style> block scoped to a page class,
// reusing the app's global CSS vars + the global `.hl` marca-texto class).

type RsvpChoice = "sim" | "talvez" | "nao";

function formatHora(time: string): string {
  const [h, m] = time.split(":");
  if (!h) return time;
  return m && m !== "00" ? `${Number(h)}h${m}` : `${Number(h)}h`;
}

function IconCalendar({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function IconClock({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </svg>
  );
}

function IconPin({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconHeart({ size = 20, filled }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function IconQuestion({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IconX({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

const RSVP_OPTIONS: [RsvpChoice, string, React.ReactNode][] = [
  ["sim", "irei", <IconHeart key="sim" filled />],
  ["talvez", "talvez", <IconQuestion key="talvez" />],
  ["nao", "não irei", <IconX key="nao" />],
];

export function ConfirmarPresencaPage({
  slug,
  idConvidado,
}: {
  slug: string;
  idConvidado: string;
}) {
  // aperture-ppuay — page-view tracking (EVENT_MAP addition), the RSVP surface.
  useEffect(() => {
    sendPageView('Confirmar Presenca');
  }, []);

  const convidadoQuery = trpc.eventoListaDeConvidados.getParaConfirmar.useQuery({
    slug,
    idConvidado,
  });
  // aperture-1yx1n — CONVIDADO-FIRST campanha resolution (Izzy's G3 red):
  // this URL carries no campanha, so the convite preview must come from the
  // CONVIDADO's campanha, not the slug default (oldest). getParaConfirmar
  // gains an additive idCampanha field (aphk8 amendment pending) — read it
  // shim-style: pre-deploy it's undefined → today's oldest-campanha
  // behavior; post-deploy the right convite loads. The preview query is
  // GATED on the convidado hop so a non-oldest guest never flashes (or
  // 404s on) the wrong campanha's convite.
  const idCampanhaConvidado = (convidadoQuery.data as { idCampanha?: string } | undefined)
    ?.idCampanha;
  const conviteQuery = useConvitePreviewData(slug, {
    idCampanha: idCampanhaConvidado,
    enabled: !convidadoQuery.isLoading,
  });
  const utils = trpc.useUtils();
  const confirmarPresenca = trpc.eventoListaDeConvidados.confirmarPresenca.useMutation({
    onSuccess: (_data, variables) => {
      // aperture-ppuay — RSVP confirmation (EVENT_MAP addition). resposta is the
      // guest's choice (sim | talvez | nao).
      sendEvent("presenca_confirmada", { resposta: variables.presenca });
      void utils.eventoListaDeConvidados.getParaConfirmar.invalidate({ slug, idConvidado });
    },
  });
  const [pending, setPending] = useState<RsvpChoice | null>(null);

  if (conviteQuery.isLoading || convidadoQuery.isLoading) {
    return (
      <main className="cp-page">
        <style>{CP_CSS}</style>
        <div className="cp-loading">carregando seu convite...</div>
      </main>
    );
  }

  const notFound =
    conviteQuery.error?.data?.code === "NOT_FOUND" ||
    convidadoQuery.error?.data?.code === "NOT_FOUND" ||
    !conviteQuery.data?.evento;

  if (notFound) {
    return <NotFoundPage pathname={`/${slug}/confirmar-presenca/${idConvidado}`} />;
  }

  if (conviteQuery.error || convidadoQuery.error || !convidadoQuery.data) {
    return (
      <main className="cp-page">
        <style>{CP_CSS}</style>
        <div className="cp-loading">
          não consegui carregar essa página agora.
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="cp-btn cp-btn-ghost"
              onClick={() => {
                void conviteQuery.refetch();
                void convidadoQuery.refetch();
              }}
            >
              tentar de novo
            </button>
          </div>
        </div>
      </main>
    );
  }

  const state = conviteStateFromData(conviteQuery.data);

  return (
    <ConfirmarPresencaView
      slug={slug}
      idCampanha={idCampanhaConvidado ?? null}
      nome={convidadoQuery.data.nome}
      presenca={convidadoQuery.data.presenca}
      formatoMensagemConvite={convidadoQuery.data.formatoMensagemConvite}
      state={state}
      interactive
      pending={pending}
      onConfirmar={async (presenca) => {
        setPending(presenca);
        try {
          await confirmarPresenca.mutateAsync({ slug, idConvidado, presenca });
          toast.success("Salvo com sucesso.");
        } catch (error) {
          toast.error("não foi possível confirmar agora", {
            description: convidadosErrorMessage(error),
          });
        } finally {
          setPending(null);
        }
      }}
    />
  );
}

/**
 * Pure presentational view for the RSVP page — reused both by the real public
 * page above (`interactive`, backed by a real confirmarPresenca mutation) and
 * by the "pré-visualizar link" preview inside the painel (non-interactive,
 * mock convidado data), so the two never drift apart visually.
 */
export function ConfirmarPresencaView({
  slug,
  idCampanha = null,
  nome,
  presenca,
  formatoMensagemConvite,
  state,
  interactive,
  onConfirmar,
  pending = null,
}: {
  slug: string;
  /** aperture-2v91z — the convidado's campanha, so the promo CTA keeps context. */
  idCampanha?: string | null;
  nome: string;
  presenca: StatusPresencaConvidado;
  formatoMensagemConvite: FormatoMensagemConvite;
  state: ConviteState;
  interactive: boolean;
  onConfirmar?: (presenca: RsvpChoice) => void | Promise<void>;
  pending?: RsvpChoice | null;
}) {
  const date = formatDateScrap(state.date);
  const isVirtual = formatoMensagemConvite === "convite_virtual";
  const activeChoice: RsvpChoice | null =
    presenca === "sim" || presenca === "talvez" || presenca === "nao" ? presenca : null;

  return (
    <main className="cp-page">
      <style>{CP_CSS}</style>

      <div className="cp-wrap">
        <p className="cp-greeting">Olá, {nome}!</p>
        <h1 className="cp-title">
          Você está <span className="hl">convidado</span> para celebrar com a gente
        </h1>

        <div className={isVirtual ? "cp-grid cp-grid-2col" : "cp-grid cp-grid-1col"}>
          <div className="cp-col-left">
            <section className="cp-card">
              <span className="cp-card-eyebrow">um recadinho do anfitrião</span>
              {state.message && <p className="cp-message">{state.message}</p>}
              {state.host && <p className="cp-signature">com carinho, {state.host} ♡</p>}
            </section>

            <section className="cp-card cp-info-card">
              {date && (
                <div className="cp-info-row">
                  <span className="cp-info-icon"><IconCalendar /></span>
                  <div>
                    <span className="cp-info-label">quando</span>
                    <span className="cp-info-value">
                      {date.weekday}, {date.day} de {date.monthFull}
                    </span>
                  </div>
                </div>
              )}
              {state.time && (
                <div className="cp-info-row">
                  <span className="cp-info-icon"><IconClock /></span>
                  <div>
                    <span className="cp-info-label">que horas</span>
                    <span className="cp-info-value">{formatHora(state.time)}</span>
                  </div>
                </div>
              )}
              {state.mode === "presencial" && state.address && (
                <div className="cp-info-row">
                  <span className="cp-info-icon"><IconPin /></span>
                  <div>
                    <span className="cp-info-label">onde</span>
                    <span className="cp-info-value" style={{ whiteSpace: "pre-line" }}>
                      {state.address}
                    </span>
                  </div>
                </div>
              )}
              {state.mode === "online" && state.onlineLink && (
                <div className="cp-info-row">
                  <span className="cp-info-icon"><IconPin /></span>
                  <div>
                    <span className="cp-info-label">onde</span>
                    <span className="cp-info-value">{state.onlineLink}</span>
                  </div>
                </div>
              )}
            </section>

            <section className="cp-card cp-rsvp-card">
              <span className="cp-rsvp-script">contamos com você?</span>
              <h3 className="cp-rsvp-title">
                confirme sua <span className="hl">presença</span>
              </h3>
              <label className="cp-field-label" htmlFor="cp-nome">
                seu nome completo
              </label>
              <input
                id="cp-nome"
                className="cp-input"
                value={nome}
                disabled
                readOnly
              />
              <div className="cp-rsvp-grid">
                {RSVP_OPTIONS.map(([choice, label, icon]) => (
                  <button
                    key={choice}
                    type="button"
                    className={`cp-rsvp-tile cp-rsvp-${choice}${activeChoice === choice ? " active" : ""}`}
                    disabled={interactive && pending !== null}
                    onClick={interactive ? () => void onConfirmar?.(choice) : undefined}
                  >
                    <span className="cp-rsvp-tile-icon">{icon}</span>
                    <span className="cp-rsvp-tile-label">
                      {interactive && pending === choice ? "salvando…" : label}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>

          {isVirtual && (
            <div className="cp-col-right">
              <div className="cp-invite-frame">
                <InvitePreview state={state} format="story" fidelity="scrapbook" scale={0.85} />
              </div>
            </div>
          )}
        </div>

        <section className={`cp-promo${isVirtual ? "" : " cp-promo-narrow"}`}>
          <span className="cp-promo-glow" aria-hidden="true" />
          <div className="cp-promo-main">
            <div className="cp-promo-content">
              <span className="cp-promo-badge">
                não deixe pra depois <IconHeart size={13} filled />
              </span>
              <h2 className="cp-promo-title">
                escolha o <span className="hl">presente</span> sem sair de casa
              </h2>
              <p className="cp-promo-text">
                Aproveite para escolher um presente da lista! Ela foi preparada pelos pais com tudo o que o bebê realmente precisa. Assim você acerta na escolha, evita filas e presentes repetidos e ainda pode deixar uma mensagem cheia de carinho. Tudo isso pode ser feito antes mesmo do evento.
              </p>
            </div>
            <div className="cp-promo-cta">
              {/* aperture-2v91z — promo CTA keeps the CONVIDADO's campanha. */}
              <a href={paginaSharePath(slug, idCampanha)} className="cp-promo-btn">
                ver a lista de presentes <span className="cp-promo-btn-arrow" aria-hidden="true">→</span>
              </a>
              <span className="cp-promo-note">leva 2 minutinhos ♡</span>
            </div>
          </div>
          <div className="cp-promo-tags">
            <span className="cp-promo-tag">
              <span className="cp-promo-check">✓</span> sem enfrentar filas
            </span>
            <span className="cp-promo-tag">
              <span className="cp-promo-check">✓</span> não erre no presente
            </span>
            <span className="cp-promo-tag">
              <span className="cp-promo-check">✓</span> 100% virtual
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}

const CP_CSS: string = `
.cp-page{
  min-height:100vh;
  background:var(--cream);
  background-image:radial-gradient(rgba(107,60,94,.022) 1px, transparent 1px);
  background-size:4px 4px;
  padding:48px 20px 80px;
  font-family:var(--font-dm-sans), system-ui, sans-serif;
}
.cp-loading{
  max-width:480px;
  margin:120px auto 0;
  text-align:center;
  color:var(--ink-soft);
  font-size:15px;
}
.cp-wrap{
  max-width:1100px;
  margin:0 auto;
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:8px;
}
.cp-greeting{
  font-family:var(--font-caveat), cursive;
  font-size:22px;
  color:var(--plum);
  margin:0;
}
.cp-title{
  font-family:var(--font-patrick-hand), cursive;
  font-weight:400;
  font-size:clamp(28px, 4.2vw, 44px);
  color:var(--plum);
  text-align:center;
  max-width:820px;
  line-height:1.15;
  margin:0 0 32px;
}
.cp-grid{
  width:100%;
  display:grid;
  gap:28px;
  align-items:start;
}
.cp-grid-2col{ grid-template-columns:1.05fr 1fr; }
.cp-grid-1col{ grid-template-columns:1fr; max-width:60%; margin:0 auto; }
.cp-col-left{ display:flex; flex-direction:column; gap:20px; min-width:0; }
.cp-col-right{ display:flex; justify-content:center; }
.cp-card{
  background:var(--paper);
  border:1px solid var(--line);
  border-radius:22px;
  box-shadow:0 14px 36px rgba(107,60,94,.1);
  padding:24px 26px;
}
.cp-card-eyebrow{
  display:block;
  font-family:var(--font-caveat), cursive;
  font-size:20px;
  color:var(--green-deep);
  margin-bottom:10px;
}
.cp-message{
  font-family:var(--font-patrick-hand), cursive;
  font-size:18px;
  line-height:1.5;
  color:var(--ink);
  margin:0 0 12px;
  white-space:pre-line;
}
.cp-signature{
  font-family:var(--font-caveat), cursive;
  font-size:20px;
  color:var(--plum);
  margin:0;
}
.cp-info-card{ display:flex; flex-direction:column; }
.cp-info-row{ display:flex; align-items:flex-start; gap:12px; padding:14px 0; }
.cp-info-row + .cp-info-row{ border-top:1px solid var(--line); }
.cp-info-icon{
  flex-shrink:0;
  width:40px; height:40px;
  border-radius:20%;
  display:grid; place-items:center;
  background:var(--lilac-soft);
  color:var(--lilac-deep);
}
.cp-info-label{
  display:block;
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:.08em;
  font-weight:600;
  color:var(--ink-mute);
}
.cp-info-value{
  display:block;
  font-family:var(--font-patrick-hand), cursive;
  font-size:17px;
  color:var(--ink);
}
.cp-field-label{
  display:block;
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:.08em;
  font-weight:600;
  color:var(--ink-soft);
  margin-bottom:6px;
}
.cp-input{
  width:100%;
  box-sizing:border-box;
  font-family:var(--font-patrick-hand), cursive;
  font-size:16px;
  color:var(--ink-soft);
  background:var(--cream);
  border:1px solid var(--line);
  border-radius:12px;
  padding:11px 14px;
  margin-bottom:16px;
}
.cp-rsvp-script{
  display:block;
  font-family:var(--font-caveat), cursive;
  font-size:20px;
  font-weight:600;
  color:var(--coral-pink);
  margin-bottom:2px;
}
.cp-rsvp-title{
  font-family:var(--font-patrick-hand), cursive;
  font-weight:400;
  font-size:26px;
  color:var(--ink);
  margin:2px 0 20px;
}
.cp-rsvp-grid{
  display:grid;
  grid-template-columns:repeat(3, 1fr);
  gap:10px;
}
.cp-rsvp-tile{
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  gap:9px;
  padding:18px 8px;
  border-radius:18px;
  border:1px solid var(--line);
  background:var(--cream);
  color:var(--ink-soft);
  font-family:var(--font-dm-sans), sans-serif;
  font-weight:600;
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:.06em;
  cursor:pointer;
}
.cp-rsvp-tile:disabled{ opacity:.6; cursor:not-allowed; }
.cp-rsvp-tile-icon{
  width:40px;
  height:40px;
  display:grid;
  place-items:center;
}
.cp-rsvp-tile-label{ line-height:1; text-align:center; }
.cp-rsvp-tile.cp-rsvp-sim.active{
  background:linear-gradient(135deg, var(--lilac), var(--lilac-deep));
  color:#fff;
  border-color:transparent;
  box-shadow:var(--shadow-cta);
}
.cp-rsvp-tile.cp-rsvp-sim.active .cp-rsvp-tile-icon{ border-color:#fff; }
.cp-rsvp-tile.cp-rsvp-talvez.active{
  background:rgba(247,213,96,.35);
  border-color:rgba(247,213,96,.7);
  color:#8a6a14;
}
.cp-rsvp-tile.cp-rsvp-nao.active{
  background:var(--pink-soft);
  border-color:rgba(231,143,167,.4);
  color:var(--coral-pink);
}
@media (max-width: 420px){
  .cp-rsvp-grid{ gap:6px; }
  .cp-rsvp-tile{ padding:12px 4px; gap:6px; }
  .cp-rsvp-tile-icon{ width:28px; height:28px; }
  .cp-rsvp-tile-label{ font-size:9.5px; }
}
.cp-invite-frame{
  position:relative;
  display:flex;
  justify-content:center;
  padding:20px;
  background:rgba(255,255,255,.72);
  border:1px solid var(--line);
  border-radius:24px;
}
.cp-invite-tag{
  position:absolute;
  top:-13px;
  left:50%;
  transform:translateX(-50%);
  background:var(--paper);
  border:1px solid var(--line);
  border-radius:999px;
  padding:4px 14px;
  font-family:var(--font-caveat), cursive;
  font-size:15px;
  color:var(--plum);
}
.cp-btn{
  display:inline-flex; align-items:center; gap:6px;
  padding:10px 16px; border-radius:999px;
  font-family:var(--font-dm-sans), sans-serif;
  font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em;
  cursor:pointer;
}
.cp-btn-ghost{ background:transparent; border:1px solid var(--line); color:var(--ink); }
.cp-promo{
  position:relative;
  overflow:hidden;
  margin-top:32px;
  width:100%;
  display:flex;
  flex-direction:column;
  gap:24px;
  padding:40px 44px;
  border-radius:28px;
  border:1px solid var(--line);
  background:linear-gradient(120deg, var(--lilac-soft) 0%, var(--pink-soft) 55%, var(--lilac-soft) 100%);
}
.cp-promo-main{
  width:100%;
  display:grid;
  grid-template-columns:1.4fr 1fr;
  align-items:center;
  gap:28px;
}
.cp-promo-narrow{
  max-width:60%;
  margin-left:auto;
  margin-right:auto;
}
.cp-promo-glow{
  position:absolute;
  top:-50px;
  right:-40px;
  width:220px;
  height:220px;
  border-radius:50%;
  background:radial-gradient(circle, rgba(247,213,96,.55), transparent 70%);
  pointer-events:none;
}
.cp-promo-content{ position:relative; z-index:1; min-width:0; }
.cp-promo-badge{
  display:inline-flex;
  align-items:center;
  gap:6px;
  background:var(--paper);
  color:var(--green-deep);
  font-family:var(--font-caveat), cursive;
  font-weight:600;
  font-size:16px;
  padding:7px 16px;
  border-radius:999px;
  margin-bottom:14px;
}
.cp-promo-title{
  font-family:var(--font-patrick-hand), cursive;
  font-weight:400;
  font-size:clamp(24px, 3vw, 32px);
  color:var(--ink);
  margin:0 0 12px;
  line-height:1.2;
}
.cp-promo-text{
  font-size:14.5px;
  color:var(--ink-soft);
  max-width:440px;
  line-height:1.55;
  margin:0 0 18px;
}
.cp-promo-tags{
  position:relative;
  z-index:1;
  width:100%;
  display:flex;
  flex-wrap:wrap;
  justify-content:center;
  gap:10px;
}
.cp-promo-tag{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:5px;
  background:var(--paper);
  border:1px solid var(--line);
  border-radius:999px;
  padding:7px 14px;
  font-size:12.5px;
  font-weight:600;
  color:var(--ink);
  white-space:nowrap;
}
.cp-promo-check{ color:var(--green-deep); }
.cp-promo-cta{
  position:relative;
  z-index:1;
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:10px;
}
.cp-promo-btn{
  display:inline-flex;
  align-items:center;
  justify-content:space-between;
  gap:14px;
  width:100%;
  padding:20px 26px;
  border-radius:20px;
  background:linear-gradient(135deg, var(--lilac), var(--lilac-deep));
  color:#fff;
  font-family:var(--font-dm-sans), sans-serif;
  font-weight:700;
  font-size:14px;
  text-transform:uppercase;
  letter-spacing:.04em;
  text-decoration:none;
  box-shadow:var(--shadow-cta);
}
.cp-promo-btn-arrow{
  font-size:22px;
  line-height:1;
  flex-shrink:0;
}
.cp-promo-note{
  font-family:var(--font-caveat), cursive;
  font-size:20px;
  color:var(--lilac-deep);
}
@media (max-width: 860px){
  .cp-grid-2col{ grid-template-columns:1fr; }
  .cp-grid-1col{ max-width:100%; }
  .cp-promo-narrow{ max-width:100%; }
  .cp-col-right{ order:-1; }
}
@media (max-width: 720px){
  .cp-promo-main{ grid-template-columns:1fr; text-align:center; }
  .cp-promo{ padding:32px 26px; }
  .cp-promo-tags{ flex-direction:column; align-items:center; justify-content:center; }
  .cp-promo-tag{ width:100%; justify-content:center; }
  .cp-promo-text{ max-width:none; }
}
`;
