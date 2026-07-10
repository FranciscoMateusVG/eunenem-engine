import { useEffect, useState } from "react";

import { Footer } from "@/components/eunenem/Footer";
import { sendEvent, sendPageView } from "@/lib/analytics";

// aperture-sgjnn — /faq Perguntas Frequentes page.
//
// Built verbatim from the operator's artifact
// (~/.claude/aperture-faq-source/"Perguntas Frequentes.html" + screenshots/
// faq-accordion.png): a numbered EuNeném-style accordion (01/02/03…) with a
// "+" expand affordance, marca-texto on the highlighted question words, stamp
// pills, and a "ainda tem dúvidas?" contact CTA. Content is the operator's
// exact copy — NOT invented.
//
// NOTE (content gap flagged to operator via aperture-sgjnn): the source
// artifact ships TWO answers incomplete — Q3 "taxas" is empty and Q4 "em
// quanto tempo" is truncated mid-sentence. Those are factual (fee schedule +
// payout timing) and must come from the operator, not be fabricated. They are
// marked PENDING below and rendered with a graceful contact fallback until the
// real copy lands.
//
// Reuses the shared <Footer/> + the app's existing design tokens; the
// FAQ-specific tokens the artifact relies on (--marker, --lime*, --coral*,
// shadows) are scoped on .faq-page so the page is self-contained.

type QPart = string | { hl: string };

interface QA {
  q: QPart[];
  /** Operator's exact answer HTML. `null` = pending operator copy (Q3/Q4). */
  a: string | null;
  stamp: string;
}

const FALAR_CONOSCO_HREF = "https://eunenem.com/minha-area/fale-com-a-gente";

// Verbatim from the artifact's FAQ[] array. Q3 (taxas) + Q4 (tempo) come
// incomplete in the source → null, pending the operator's real copy.
const FAQ: QA[] = [
  {
    q: ["para fazer minha lista de presentes eu preciso ", { hl: "pagar?" }],
    a: `não ♡ criar a sua listinha de mimos é totalmente <span class="accent">de graça</span>. você monta a lista com calma, escolhe os mimos favoritos e compartilha com quem ama — sem pagar nada pra começar. a EuNeném só cobra uma pequena taxa quando você recebe o valor dos presentes.`,
    stamp: "grátis pra começar ♡",
  },
  {
    q: ["eu recebo os presentes em casa ou em ", { hl: "dinheiro?" }],
    a: `Você recebe os presentes em <span class="accent">dinheiro</span>, não presentes físicos. Aqui os mimos da sua lista viram saldo pra você. assim, em vez de receber vários produtos repetidos, você recebe o valor e compra exatamente o que o seu neném precisa, na hora certa.`,
    stamp: "você no controle ♡",
  },
  {
    q: ["quais são as ", { hl: "taxas" }, " cobradas?"],
    // PENDING — artifact ships this answer empty; fee schedule must come from
    // the operator (do not invent).
    a: null,
    stamp: "sem surpresas ♡",
  },
  {
    q: ["em quanto tempo eu recebo o ", { hl: "dinheiro?" }],
    // PENDING — artifact truncates this answer ("…assim que c"); payout timing
    // must come from the operator (do not invent).
    a: null,
    stamp: "rapidinho ♡",
  },
  {
    q: ["como os convidados ", { hl: "compram" }, " os presentes?"],
    a: `super fácil ♡ você compartilha o link da sua lista e quem ama vocês acessa, escolhe um mimo e paga por <span class="accent">cartão ou PIX</span> em poucos cliques — sem precisar criar conta nem baixar nada.`,
    stamp: "só compartilhar ♡",
  },
  {
    q: ["o EuNeném é ", { hl: "seguro?" }, " posso confiar?"],
    a: `pode confiar de olhos fechados ♡ todos os pagamentos passam por parceiros <span class="accent">seguros</span> e os seus dados ficam protegidos com criptografia. muitas famílias já usaram a EuNeném pra realizar o chá de bebê dos sonhos.`,
    stamp: "pode confiar ♡",
  },
  {
    q: ["posso ", { hl: "desativar" }, " minha conta?"],
    a: `claro ♡ a sua conta é sua. se quiser pausar ou desativar a qualquer momento, é só falar com a nossa equipe pelo contato e a gente <span class="accent">cuida de tudo</span> pra você.`,
    stamp: "sem complicação ♡",
  },
];

function flattenQ(parts: QPart[]): string {
  return parts.map((p) => (typeof p === "string" ? p : p.hl)).join("");
}

function renderQ(parts: QPart[]) {
  return parts.map((p, i) =>
    typeof p === "string" ? (
      <span key={i}>{p}</span>
    ) : (
      <span key={i} className="mark-hl">
        {p.hl}
      </span>
    ),
  );
}

export function FaqPage() {
  // First item open by default (mirrors the artifact's behaviour). Single-open
  // accordion: clicking an item closes whichever was open.
  const [openIdx, setOpenIdx] = useState<number>(0);

  useEffect(() => {
    sendPageView("FAQ");
  }, []);

  return (
    <div className="faq-page">
      <style>{FAQ_CSS}</style>

      <header className="faq-topbar">
        <div className="faq-topbar-inner">
          <a className="faq-logo" href="/" aria-label="EuNeném — início">
            <img src="/public/logo-landing.png" alt="EuNeném" className="faq-logo-img" />
          </a>
          <nav className="faq-nav-right">
            <a
              className="faq-nav-link"
              href={FALAR_CONOSCO_HREF}
              onClick={() => sendEvent("faq_contato_whatsapp_click", { origem: "topbar" })}
            >
              falar conosco
            </a>
          </nav>
        </div>
      </header>

      <main className="faq-wrap">
        <section className="faq-card" aria-label="Perguntas frequentes">
          <span aria-hidden="true" className="faq-washi faq-washi-tl" />

          <div className="faq-hero">
            <h1>
              perguntas <span className="mark-hl">frequentes</span>
            </h1>
            <p>
              tire todas as suas dúvidas sobre como funciona a EuNeném — do jeitinho
              mais simples, pra você cuidar do que importa.
            </p>
          </div>

          <div className="faq-list">
            {FAQ.map((item, i) => {
              const open = openIdx === i;
              const num = `0${i + 1}`;
              return (
                <div key={i} className={`faq-qa${open ? " open" : ""}`}>
                  <button
                    type="button"
                    className="faq-qa-head"
                    aria-expanded={open}
                    onClick={() => {
                      const next = open ? -1 : i;
                      if (next !== -1) {
                        sendEvent("faq_pergunta_expandida", { pergunta: flattenQ(item.q) });
                      }
                      setOpenIdx(next);
                    }}
                  >
                    <span className="faq-qa-num" aria-hidden="true">
                      {num}
                    </span>
                    <span className="faq-qa-q">{renderQ(item.q)}</span>
                    <span className="faq-plus" aria-hidden="true" />
                  </button>
                  <div className="faq-qa-body">
                    <div className="faq-qa-body-inner">
                      <div className="faq-qa-answer">
                        {item.a !== null ? (
                          <span dangerouslySetInnerHTML={{ __html: item.a }} />
                        ) : (
                          // PENDING operator copy — graceful, non-invented fallback.
                          <span>
                            estamos finalizando esse detalhe com todo o cuidado ♡ se
                            precisar dessa resposta agora, é só{" "}
                            <a
                              className="faq-inline-link"
                              href={FALAR_CONOSCO_HREF}
                              onClick={() =>
                                sendEvent("faq_contato_whatsapp_click", { origem: "resposta_pendente" })
                              }
                            >
                              falar com a gente
                            </a>
                            .
                          </span>
                        )}
                        <br />
                        <span className="faq-stamp">{item.stamp}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="faq-contact" aria-label="Contato">
          <span aria-hidden="true" className="faq-washi faq-washi-tr" />
          <span className="faq-eyebrow">não achou sua resposta?</span>
          <h2>
            ainda tem <span className="mark-hl">dúvidas?</span>
          </h2>
          <p>
            entre em contato com a gente ♡ estamos aqui pra te ajudar a criar o chá de
            bebê perfeito, com todo o carinho que esse momento merece.
          </p>
          <a
            className="faq-btn-coral"
            href={FALAR_CONOSCO_HREF}
            onClick={() => sendEvent("faq_contato_whatsapp_click", { origem: "cta_final" })}
          >
            falar conosco
          </a>
        </section>

        <p className="faq-footnote">feito com amor pra você e pro seu neném ♡</p>
      </main>

      <Footer />
    </div>
  );
}

// Ported from the artifact's <style> block, scoped under .faq-page. Tokens the
// app already defines (--plum, --lilac-deep/-soft, --ink-soft/-mute, --line,
// --cream, --paper) are reused; the FAQ-only ones are declared here.
const FAQ_CSS = `
.faq-page{
  --marker:#F7D560;
  --lime:#C7DC6E; --lime-deep:#8AA53A;
  --coral:#E78FA7; --coral-soft:#FBE0EA;
  --sh-low:0 10px 30px -16px rgba(107,60,94,.30);
  --sh-mid:0 18px 50px -22px rgba(107,60,94,.38);
  --sh-lilac:0 14px 30px -10px rgba(167,123,190,.40);
  color:var(--ink);
  background:var(--cream);
  background-image:radial-gradient(rgba(107,60,94,.022) 1px, transparent 1px);
  background-size:4px 4px;
  min-height:100vh;
  font-family:"DM Sans",system-ui,sans-serif;
  line-height:1.5;
}
.faq-page .mark-hl{
  background:linear-gradient(180deg,transparent 62%,var(--marker) 62%,var(--marker) 92%,transparent 92%);
  padding:0 .06em;border-radius:2px;
}

/* topbar */
.faq-topbar{position:sticky;top:0;z-index:50;background:rgba(248,247,246,.78);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);border-bottom:1px solid var(--line);}
.faq-topbar-inner{max-width:1080px;margin:0 auto;padding:12px 26px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
.faq-logo{display:inline-flex;align-items:center;text-decoration:none;}
.faq-logo-img{height:54px;width:auto;background:rgba(255,255,255,.95);padding:6px 12px;border-radius:14px;}
.faq-nav-right{display:flex;align-items:center;gap:18px;}
.faq-nav-link{font-size:12px;color:var(--ink-soft);text-decoration:none;text-transform:uppercase;letter-spacing:.12em;font-weight:600;}
.faq-nav-link:hover{color:var(--plum);}

/* page */
.faq-wrap{max-width:1080px;margin:0 auto;padding:46px 26px 90px;}
.faq-card{position:relative;background:var(--paper);border:1px solid var(--line);border-radius:26px;box-shadow:var(--sh-mid);padding:60px 56px 56px;overflow:hidden;}
.faq-card::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(620px 460px at 100% 0%, rgba(201,165,216,.30), rgba(232,213,240,.10) 42%, transparent 66%);}
.faq-card::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(420px 360px at 0% 100%, rgba(156,215,221,.16), transparent 60%);}
.faq-card > *{position:relative;z-index:1;}

.faq-washi{position:absolute;z-index:3;width:128px;height:30px;background:repeating-linear-gradient(45deg,rgba(247,213,96,.85) 0 9px,rgba(247,213,96,.55) 9px 18px);border-left:1px dashed rgba(107,60,94,.18);border-right:1px dashed rgba(107,60,94,.18);box-shadow:var(--sh-low);}
.faq-washi-tl{top:-13px;left:54px;transform:rotate(-5deg);}

.faq-hero{text-align:center;max-width:640px;margin:0 auto 14px;}
.faq-hero h1{font-family:"Patrick Hand",cursive;font-weight:400;font-size:clamp(40px,6vw,62px);color:var(--plum);line-height:1.02;margin:6px 0 18px;letter-spacing:.5px;}
.faq-hero p{font-size:16px;color:var(--ink-soft);margin:0 auto;max-width:430px;}

/* accordion */
.faq-list{max-width:760px;margin:46px auto 0;display:flex;flex-direction:column;gap:16px;}
.faq-qa{background:var(--paper);border:1px solid var(--line);border-radius:22px;box-shadow:var(--sh-low);overflow:hidden;transition:box-shadow .25s ease,border-color .25s ease,transform .25s ease;}
.faq-qa:nth-child(odd){transform:rotate(-.35deg);}
.faq-qa:nth-child(even){transform:rotate(.35deg);}
.faq-qa:hover{box-shadow:var(--sh-mid);border-color:var(--lilac-soft);}
.faq-qa.open{transform:rotate(0deg);border-color:var(--lilac);box-shadow:0 20px 48px -20px rgba(167,123,190,.5);}
.faq-qa-head{width:100%;border:0;background:transparent;cursor:pointer;display:flex;align-items:center;gap:18px;text-align:left;padding:24px 26px;font-family:inherit;}
.faq-qa-num{flex:none;font-family:"Caveat",cursive;font-weight:700;font-size:22px;color:var(--lilac-deep);width:30px;text-align:center;transform:rotate(-4deg);opacity:.85;}
.faq-qa-q{flex:1;font-family:"Patrick Hand",cursive;font-weight:400;font-size:clamp(20px,2.6vw,24px);color:var(--plum);line-height:1.18;letter-spacing:.2px;}
.faq-qa.open .faq-qa-q .mark-hl{background:linear-gradient(180deg,transparent 60%,var(--marker) 60%,var(--marker) 92%,transparent 92%);}
.faq-plus{flex:none;width:34px;height:34px;border-radius:11px;background:var(--lilac-soft);display:grid;place-items:center;position:relative;transform:rotate(-4deg);transition:background .25s ease,transform .35s ease;}
.faq-plus::before,.faq-plus::after{content:"";position:absolute;background:var(--lilac-deep);border-radius:2px;transition:transform .35s cubic-bezier(.3,1.4,.4,1),opacity .25s ease;}
.faq-plus::before{width:15px;height:2.4px;}
.faq-plus::after{width:2.4px;height:15px;}
.faq-qa.open .faq-plus{background:var(--lilac);transform:rotate(86deg);}
.faq-qa.open .faq-plus::before{background:#fff;}
.faq-qa.open .faq-plus::after{background:#fff;opacity:0;transform:scaleY(0);}
.faq-qa-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .38s cubic-bezier(.4,0,.2,1);}
.faq-qa.open .faq-qa-body{grid-template-rows:1fr;}
.faq-qa-body-inner{overflow:hidden;}
.faq-qa-answer{padding:0 26px 26px 74px;font-size:15.5px;color:var(--ink-soft);line-height:1.62;max-width:620px;}
.faq-qa-answer .accent{color:var(--lilac-deep);font-weight:600;}
.faq-inline-link{color:var(--lilac-deep);font-weight:600;text-decoration:underline;}
.faq-stamp{display:inline-block;margin-top:14px;font-family:"Caveat",cursive;font-weight:700;font-size:19px;color:var(--lime-deep);border:1.5px solid var(--lime);border-radius:999px;padding:3px 14px;transform:rotate(-3deg);background:rgba(199,220,110,.12);}

/* contact */
.faq-contact{position:relative;max-width:760px;margin:42px auto 0;background:linear-gradient(155deg,var(--coral-soft),#fff 70%);border:1px solid var(--line);border-radius:24px;box-shadow:var(--sh-low);padding:42px 40px;text-align:center;overflow:hidden;}
.faq-washi-tr{top:-13px;right:48px;background:repeating-linear-gradient(45deg,rgba(231,143,167,.8) 0 9px,rgba(231,143,167,.5) 9px 18px);transform:rotate(4deg);}
.faq-eyebrow{display:inline-block;font-family:"Caveat",cursive;font-weight:600;font-size:26px;color:var(--coral);transform:rotate(-3deg);margin-bottom:6px;}
.faq-contact h2{font-family:"Patrick Hand",cursive;font-weight:400;font-size:clamp(30px,4.4vw,42px);color:var(--plum);margin:4px 0 12px;letter-spacing:.3px;}
.faq-contact p{font-size:15.5px;color:var(--ink-soft);max-width:430px;margin:0 auto 26px;}
.faq-btn-coral{border:0;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;font-family:"DM Sans",sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.1em;border-radius:999px;background:linear-gradient(150deg,var(--coral),#d8728f);color:#fff;box-shadow:0 14px 30px -10px rgba(231,143,167,.55);font-size:12px;padding:14px 28px;transition:transform .18s ease;}
.faq-btn-coral:hover{transform:translateY(-2px) rotate(-1deg);}
.faq-footnote{text-align:center;margin:40px auto 0;max-width:520px;font-family:"Caveat",cursive;font-size:22px;color:var(--ink-mute);transform:rotate(-1deg);}

@media (max-width:640px){
  .faq-card{padding:44px 22px 40px;}
  .faq-qa-answer{padding-left:26px;}
  .faq-qa-head{padding:20px 18px;gap:12px;}
  .faq-washi-tl{left:24px;}
}
`;
