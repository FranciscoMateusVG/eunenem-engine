import { useEffect } from 'react';
import { Footer } from '@/components/eunenem/Footer';
import { PublicInfoHeader } from '@/components/eunenem/PublicInfoHeader';
import { sendPageView } from '@/lib/analytics';
import { EUNENEM_SUPPORT_WHATSAPP_URL } from '@/lib/painelRoutes';
import { pageViewProps } from '@/lib/rota-canonica';

const STEPS = [
  ['O convidado presenteia', 'Escolhe um presente e realiza o pagamento.'],
  ['O valor fica disponível', 'Até 10 minutos para Pix ou após 31 dias corridos para cartão de crédito.'],
  ['Você solicita o resgate', 'Quando o saldo estiver disponível.'],
  ['O dinheiro chega à sua conta', 'Em até 3 dias úteis após a solicitação.'],
];

/** Informational copy only; does not calculate fees or change payment rules. */
export function TaxasEPrazosPage() {
  useEffect(() => {
    sendPageView('Taxas e prazos', pageViewProps(window.location.pathname));
  }, []);

  return (
    <div className="taxas-info-page">
      <style>{TAXAS_CSS}</style>
      <PublicInfoHeader />
      <main className="taxas-info-wrap">
        <header className="taxas-info-intro">
          <span className="taxas-info-tape" aria-hidden="true" />
          <h1>taxas e prazos <span aria-hidden="true">♡</span></h1>
        </header>

        <section aria-labelledby="taxas-info-custo" className="taxas-info-section">
          <h2 id="taxas-info-custo">criar sua lista é grátis! ♡</h2>
          <p>Criar sua lista na EuNeném é <strong>gratuito</strong> e você recebe <strong>100% do valor que definir para cada presente</strong>. 💛</p>
          <dl className="taxas-info-facts">
            <div><dt>Criar sua lista</dt><dd>Grátis</dd></div>
            <div><dt>Você recebe</dt><dd>100% <span>do valor dos presentes</span></dd></div>
            <div><dt>Taxa de serviço</dt><dd>8,98% <span>paga pelo convidado</span></dd></div>
          </dl>
          <p>Quando um convidado escolhe um presente, a taxa de serviço da EuNeném já é acrescentada ao valor que ele paga.</p>
          <p>Para você, <strong>não há nenhum desconto sobre o valor do presente</strong>. A taxa é paga pelo convidado e representa apenas um pequeno acréscimo ao valor da contribuição.</p>
          <aside className="taxas-info-validade" aria-label="Validade das taxas">
            <strong>Importante ♡</strong>
            <p>As condições de taxas apresentadas nesta página são válidas para listas criadas a partir de <strong>13/09/2026</strong>.</p>
          </aside>
        </section>

        <section aria-labelledby="taxas-info-exemplo" className="taxas-info-section">
          <h2 id="taxas-info-exemplo">vamos fazer uma continha? ♡</h2>
          <div className="taxas-info-example">
            <dl>
              <div><dt>Valor do presente:</dt><dd>R$ 50,00</dd></div>
              <div><dt>Taxa de serviço (8,98%):</dt><dd>R$ 4,49</dd></div>
              <div className="taxas-info-total"><dt>Total pago pelo convidado:</dt><dd>R$ 54,49</dd></div>
              <div className="taxas-info-recebe"><dt>Você recebe:</dt><dd>R$ 50,00</dd></div>
            </dl>
          </div>
        </section>

        <section aria-labelledby="taxas-info-disponivel" className="taxas-info-section">
          <h2 id="taxas-info-disponivel">quando posso resgatar meus presentes? ♡</h2>
          <p>O prazo para receber o valor depende da forma de pagamento escolhida pelo convidado.</p>
          <div className="taxas-info-payment-grid">
            <article className="taxas-info-payment taxas-info-pix">
              <div className="taxas-info-payment-title">
                <svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="m13 3-9 9a5 5 0 0 0 0 8l9 9a4 4 0 0 0 6 0l9-9a5 5 0 0 0 0-8l-9-9a4 4 0 0 0-6 0Z" />
                  <path d="M4 12h5l7 7 7-7h5M4 20h5l7-7 7 7h5" />
                </svg>
                <h3>PIX</h3>
              </div>
              <p>Disponível para resgate em <strong>até 10 minutos</strong> após o pagamento.</p>
            </article>
            <article className="taxas-info-payment taxas-info-card">
              <div className="taxas-info-payment-title">
                <svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <rect x="3" y="6" width="26" height="20" rx="4" /><path d="M3 13h26M8 21h6" />
                </svg>
                <h3>Cartão de crédito</h3>
              </div>
              <p>Disponível para resgate após <strong>31 dias corridos</strong> do pagamento.</p>
            </article>
          </div>
        </section>

        <section aria-labelledby="taxas-info-resgate" className="taxas-info-section taxas-info-withdrawal">
          <div>
            <h2 id="taxas-info-resgate">pedi meu resgate. e agora? ♡</h2>
            <span className="taxas-info-deadline">Até 3 dias úteis</span>
          </div>
          <div>
            <p>Depois de solicitar o resgate, o valor é transferido para a sua conta bancária em <strong>até 3 dias úteis</strong>.</p>
            <p>Assim, você pode acompanhar os valores recebidos pela sua lista e solicitar o resgate quando estiverem disponíveis. 💛</p>
          </div>
        </section>

        <section aria-labelledby="taxas-info-etapas" className="taxas-info-section">
          <h2 id="taxas-info-etapas">do presente ao recebimento ♡</h2>
          <ol className="taxas-info-timeline">
            {STEPS.map(([title, description], index) => (
              <li key={title}>
                <span className="taxas-info-step" aria-hidden="true">{index + 1}</span>
                <div><h3>{title}</h3><p>{description}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="taxas-info-duvidas" className="taxas-info-section taxas-info-contact">
          <h2 id="taxas-info-duvidas">ainda ficou alguma dúvida? ♡</h2>
          <p>Estamos por aqui para ajudar você!</p>
          <div className="taxas-info-links">
            <a href="/faq">Perguntas frequentes</a>
            <a href={EUNENEM_SUPPORT_WHATSAPP_URL}>Fale com a gente</a>
          </div>
          <a className="taxas-info-terms" href="/termos-de-uso">Consulte também nossos Termos de Uso.</a>
        </section>
      </main>
      <Footer />
    </div>
  );
}

const TAXAS_CSS = `
.taxas-info-page{background:var(--cream);color:var(--ink-soft);font-family:"DM Sans",system-ui,sans-serif;line-height:1.65;font-weight:400;}
.taxas-info-page *{box-sizing:border-box;}
.taxas-info-wrap{max-width:940px;margin:0 auto;padding:40px 20px 48px;}
.taxas-info-page h1,.taxas-info-page h2{font-family:"Patrick Hand",cursive;font-weight:400;color:var(--plum);line-height:1.15;}
.taxas-info-page h1{font-size:clamp(36px,6vw,52px);margin:8px 0 12px;}
.taxas-info-page h2{font-size:clamp(25px,3.6vw,32px);margin:0 0 14px;}
.taxas-info-page h3{font-family:"DM Sans",system-ui,sans-serif;font-weight:700;font-size:16px;line-height:1.4;color:var(--plum);margin:0;}
.taxas-info-page p{font-size:15px;margin:0 0 12px;max-width:70ch;}
.taxas-info-page strong{font-weight:700;color:var(--plum);}
.taxas-info-intro{position:relative;text-align:center;margin:0 auto 32px;max-width:570px;}
.taxas-info-intro p{margin:0 auto;}
.taxas-info-tape{display:block;width:80px;height:17px;margin:0 auto 14px;background:repeating-linear-gradient(45deg,#e8d5f0 0 7px,#f2e8f6 7px 14px);transform:rotate(-4deg);}
.taxas-info-section{margin-top:32px;}
.taxas-info-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0;}
.taxas-info-facts>div{border:1px solid var(--line);border-radius:18px;padding:16px;background:#fff;}
.taxas-info-facts>div:nth-child(2){background:#f0f4df;border-color:#c7d5a1;}
.taxas-info-facts>div:nth-child(3){background:#f2e8f6;}
.taxas-info-facts dt{font-size:13px;font-weight:600;color:var(--plum);}
.taxas-info-facts dd{font-family:"Patrick Hand",cursive;font-size:30px;line-height:1.2;color:var(--plum);margin:6px 0 0;}
.taxas-info-facts dd span{display:block;font-family:"DM Sans",system-ui,sans-serif;font-size:14px;margin-top:4px;line-height:1.45;}
.taxas-info-validade{border-left:3px solid #b997cb;background:#f1eaf5;border-radius:0 12px 12px 0;padding:12px 16px;margin-top:20px;font-size:14px;}
.taxas-info-validade p{font-size:14px;margin:4px 0 0;}
.taxas-info-example{background:#fbf6e8;border:1px solid #e7ddc0;border-radius:20px;padding:20px;}
.taxas-info-example dl{margin:0 0 16px;}
.taxas-info-example dl>div{display:flex;justify-content:space-between;gap:16px;padding:9px 0;align-items:baseline;}
.taxas-info-example dt{font-size:15px;}
.taxas-info-example dd{font-size:17px;font-weight:600;white-space:nowrap;color:var(--plum);margin:0;font-variant-numeric:tabular-nums;}
.taxas-info-example .taxas-info-total{border-top:1px dashed #cdbda4;margin-top:5px;padding-top:14px;}
.taxas-info-example .taxas-info-recebe{background:#edf2d9;border:1px solid #c7d5a1;border-radius:12px;padding:12px 16px;margin-top:10px;color:var(--plum);font-weight:700;}
.taxas-info-recebe dd{font-size:25px;}
.taxas-info-example p{margin-bottom:0;}
.taxas-info-payment-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px;}
.taxas-info-payment{border:1px solid var(--line);border-radius:18px;padding:18px;}
.taxas-info-pix{background:#edf4ef;}
.taxas-info-card{background:#f3eaf7;}
.taxas-info-payment-title{display:flex;align-items:center;gap:10px;color:var(--plum);margin-bottom:12px;}
.taxas-info-payment p{margin:0;}
.taxas-info-payment strong{display:inline;font-size:18px;}
.taxas-info-withdrawal{background:#f9e9ef;border:1px solid #e8c9d5;border-radius:20px;padding:22px;display:grid;grid-template-columns:1fr 1.2fr;gap:24px;}
.taxas-info-withdrawal p:last-child{margin:0;}
.taxas-info-deadline{font-family:"Patrick Hand",cursive;font-size:30px;line-height:1.2;color:var(--plum);}
.taxas-info-timeline{list-style:none;padding:0;margin:20px 0 0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;}
.taxas-info-timeline li{position:relative;min-width:0;}
.taxas-info-step{display:grid;place-items:center;width:34px;height:34px;border:1px solid #b997cb;border-radius:50%;background:#f0e5f5;color:var(--plum);font-weight:700;margin-bottom:12px;position:relative;z-index:1;}
.taxas-info-timeline li:not(:last-child):before{content:"";position:absolute;top:17px;left:34px;width:calc(100% - 16px);border-top:1px dashed #b997cb;}
.taxas-info-timeline h3{font-size:14px;margin-bottom:6px;}
.taxas-info-timeline p{font-size:13px;margin:0;}
.taxas-info-contact{border-top:1px solid var(--line);padding-top:28px;text-align:center;}
.taxas-info-contact p{margin-left:auto;margin-right:auto;}
.taxas-info-links{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin:18px 0 12px;}
.taxas-info-links a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;border:1px solid #b997cb;border-radius:999px;color:var(--plum);font-size:14px;font-weight:600;text-decoration:none;background:#fff;}
.taxas-info-links a:hover{background:#f0e5f5;}
.taxas-info-terms{display:inline-flex;align-items:center;min-height:44px;color:var(--ink-soft);font-size:13px;text-underline-offset:3px;}
.taxas-info-page a:focus-visible{outline:3px solid var(--plum);outline-offset:4px;}
@media(max-width:600px){
  .taxas-info-wrap{padding:28px 18px 32px;}
  .taxas-info-intro{margin-bottom:28px;}
  .taxas-info-section{margin-top:28px;}
  .taxas-info-facts{grid-template-columns:1fr;gap:8px;margin:16px 0;}
  .taxas-info-facts>div{padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
  .taxas-info-facts dt{flex:1;}
  .taxas-info-facts dd{flex:1;font-size:26px;margin:0;}
  .taxas-info-facts dd span{font-size:13px;}
  .taxas-info-example{padding:14px;}
  .taxas-info-example dt{font-size:13px;}
  .taxas-info-example dd{font-size:16px;}
  .taxas-info-example .taxas-info-recebe{padding:10px 12px;}
  .taxas-info-recebe dd{font-size:23px;}
  .taxas-info-payment-grid{grid-template-columns:1fr;gap:10px;}
  .taxas-info-payment{padding:14px;}
  .taxas-info-payment-title{margin-bottom:8px;}
  .taxas-info-withdrawal{grid-template-columns:1fr;gap:12px;padding:16px;}
  .taxas-info-withdrawal h2{margin-bottom:8px;}
  .taxas-info-timeline{grid-template-columns:1fr;gap:16px;}
  .taxas-info-timeline li{display:flex;gap:12px;}
  .taxas-info-step{flex:none;margin:0;}
  .taxas-info-timeline li:not(:last-child):before{top:34px;left:17px;height:calc(100% - 18px);width:0;border-top:0;border-left:1px dashed #b997cb;}
  .taxas-info-timeline p{font-size:14px;}
}
`;
