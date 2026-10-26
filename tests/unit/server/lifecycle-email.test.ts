import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_EMAIL_TYPES,
  type LifecycleEmailCommonVars,
  renderLifecycleEmail,
} from '../../../apps/eunenem-server/server/auth/lifecycle-email.js';

const common: LifecycleEmailCommonVars = {
  recipientName: 'Helena',
  dashboardUrl: 'https://staging.eunenem.com/painel/helena',
  preferencesUrl: 'https://staging.eunenem.com/email/preferencias?token=PREF',
  unsubscribeUrl: 'https://staging.eunenem.com/email/descadastrar?token=UNSUB',
  feedbackUrl: 'https://staging.eunenem.com/avaliar-email?token=FB',
  assetBaseUrl: 'https://staging.eunenem.com',
};

function payment(overrides: Record<string, unknown> = {}) {
  return renderLifecycleEmail('payment_received', {
    ...common,
    ownerName: 'Helena',
    guestName: 'Tia Rosa',
    guestMessage: 'Que esse bebê chegue com muita saúde!',
    gifts: [{ name: 'Carrinho de passeio', quantity: 1 }],
    recipientIsOwner: true,
    ...overrides,
  });
}

function all() {
  return [
    renderLifecycleEmail('welcome', {
      ...common,
      giftCount: 0,
      startUrl: 'https://staging.eunenem.com/onboarding',
    }),
    renderLifecycleEmail('list_ready', {
      ...common,
      shareUrl: 'https://staging.eunenem.com/painel/helena/convite',
    }),
    renderLifecycleEmail('event_reminder', { ...common, eventDate: 'sábado, 25 de outubro' }),
    payment(),
  ];
}

describe('lifecycle emails — shared email-safe contract', () => {
  it('exposes the four journey types plus the two owner alerts', () => {
    expect([...LIFECYCLE_EMAIL_TYPES]).toEqual([
      'welcome',
      'list_ready',
      'event_reminder',
      'payment_received',
      'new_message',
      'presence_confirmed',
    ]);
  });

  it.each(
    all().map((m, i) => [LIFECYCLE_EMAIL_TYPES[i], m] as const),
  )('%s is table-based, inline-styled, script/form free and has a text part', (_type, m) => {
    expect(m.subject.length).toBeGreaterThan(5);
    expect(m.html).toMatch(/^<!doctype html>/i);
    expect(m.html).toContain('role="presentation"');
    expect(m.html).not.toMatch(/<script|<form|<input|display:\s*(flex|grid)|var\(--/i);
    // Solid colour BEFORE the gradient, so clients without gradients keep contrast.
    expect(m.html).toMatch(
      /bgcolor="#[0-9a-f]{6}"[^>]*background-color:#[0-9a-f]{6};background-image:linear-gradient/,
    );
    // Handwritten brand font always has web-safe fallbacks.
    expect(m.html).toContain("'Patrick Hand','Comic Sans MS','Segoe Print','Bradley Hand',cursive");
    // Hosted logo with alt + explicit size.
    expect(m.html).toMatch(
      /<img src="https:\/\/staging\.eunenem\.com\/public\/logo-landing\.png" width="\d+" height="\d+" alt="EuNeném"/,
    );
    // Footer: unsubscribe (per type) + preferences, both in HTML and text.
    expect(m.html).toContain('href="https://staging.eunenem.com/email/descadastrar?token=UNSUB"');
    expect(m.html).toContain('href="https://staging.eunenem.com/email/preferencias?token=PREF"');
    expect(m.text).toContain(
      'descadastrar: https://staging.eunenem.com/email/descadastrar?token=UNSUB',
    );
    expect(m.text).toContain(
      'preferências de e-mail: https://staging.eunenem.com/email/preferencias?token=PREF',
    );
    // Avalie sua experiência: five rating links + comment link (no rating preset).
    for (const n of [1, 2, 3, 4, 5]) {
      expect(m.html).toContain(
        `href="https://staging.eunenem.com/avaliar-email?token=FB&amp;nota=${n}"`,
      );
    }
    expect(m.html).toContain('href="https://staging.eunenem.com/avaliar-email?token=FB"');
    expect(m.text).toContain('avalie sua experiência');
    // No HTML leaks into the text part.
    expect(m.text).not.toMatch(/<[a-z]/i);
    expect(m.html).toContain('<meta name="color-scheme" content="light only">');
    // No third-party request when the email is opened (only our hosted logo).
    expect(m.html).not.toContain('fonts.googleapis.com');
    expect(m.html.match(/https?:\/\/[^"' )]+\.(png|jpe?g|gif|css|woff2?)/g)).toEqual([
      'https://staging.eunenem.com/public/logo-landing.png',
      'https://staging.eunenem.com/public/logo-landing.png',
    ]);
    // Outlook: fixed 600px ghost table; the fluid table itself is max-width only.
    expect(m.html).toContain('<!--[if mso]><table role="presentation" align="center" width="600"');
    expect(m.html).not.toMatch(/<table[^>]*width="600"[^>]*width:100%/);
  });

  it('uses the approved contact channels', () => {
    for (const m of [all()[0], all()[2]]) {
      expect(m.html).toContain('href="mailto:oi@eunenem.com"');
      expect(m.html).toContain('href="https://wa.me/5511961080489"');
      expect(m.html).toContain('+55 11 96108-0489');
      expect(m.text).toContain('oi@eunenem.com');
      expect(m.text).toContain('+55 11 96108-0489');
    }
    for (const m of all().filter((_, i) => i !== 1)) {
      expect(m.html).toContain('href="https://www.instagram.com/eu_nenem"');
    }
  });
});

describe('welcome', () => {
  const render = (giftCount: number | null) =>
    renderLifecycleEmail('welcome', { ...common, giftCount, startUrl: 'https://x.test/comecar' });

  it('follows the PDF copy and CTA', () => {
    const m = render(0);
    expect(m.subject).toBe('bem-vinda, que alegria ♡');
    expect(m.html).toContain('bem-vinda,<br>que alegria');
    expect(m.html).toContain('COMEÇAR MEU CHÁ DE BEBÊ');
    expect(m.html).toContain('href="https://x.test/comecar"');
    expect(m.html).toContain('monte sua lista de mimos');
    expect(m.html).toContain('você recebeu este e-mail porque criou uma conta na EuNeném.');
    expect(m.text).toContain('Começar meu chá de bebê: https://x.test/comecar');
  });

  it('shows the real number of mimos and hides the line when unknown', () => {
    expect(render(0).html).toContain('0 mimos por enquanto');
    expect(render(1).html).toContain('1 mimo na sua lista');
    expect(render(12).html).toContain('12 mimos na sua lista');
    expect(render(12).text).toContain('12 mimos na sua lista');
    expect(render(null).html).not.toContain('mimos por enquanto');
    expect(render(null).html).not.toContain('SUA LISTA</td>');
  });
});

describe('list_ready (Compartilhar meu chá)', () => {
  it('follows the PDF copy and links the CTA to the invitation panel', () => {
    const m = renderLifecycleEmail('list_ready', {
      ...common,
      shareUrl: 'https://x.test/painel/h/convite',
    });
    expect(m.subject).toBe('seu chá já está pronto!');
    expect(m.html).toContain('seu chá já está pronto!');
    expect(m.html).toContain('COMPARTILHAR MEU CHÁ');
    expect(m.html).toContain('href="https://x.test/painel/h/convite"');
    expect(m.html).toContain('três toques e o mimo é seu');
    expect(m.html).toContain('CHÁ DE BEBÊ ONLINE, FEITO COM CARINHO');
    expect(m.html).toContain('porque criou uma lista de presentes na EuNeném.');
    expect(m.text).toContain('Compartilhar meu chá: https://x.test/painel/h/convite');
  });
});

describe('event_reminder (D−5)', () => {
  it('follows the PDF checklist and CTA', () => {
    const m = renderLifecycleEmail('event_reminder', {
      ...common,
      eventDate: 'sábado, 25 de outubro',
    });
    expect(m.subject).toBe('respira, está tudo caminhando ♡');
    expect(m.html).toContain('respira, está<br>tudo caminhando');
    for (const item of [
      'dar uma última olhada na lista de convidados',
      'mandar o convite para quem ainda não recebeu',
      'conferir se a lista de presentes está do seu jeito',
      'ver quem já confirmou presença',
      'separar os últimos detalhes do evento',
    ]) {
      expect(m.html).toContain(item);
      expect(m.text).toContain(item);
    }
    expect(m.html).toContain('VER MEU CHÁ');
    expect(m.html).toContain(`href="${common.dashboardUrl}"`);
    expect(m.html).toContain('sábado, 25 de outubro');
  });

  it('omits the date line when there is no date', () => {
    const m = renderLifecycleEmail('event_reminder', { ...common, eventDate: null });
    expect(m.html).not.toContain('seu chá é ');
  });
});

describe('payment_received (presente recebido)', () => {
  it('fills the PDF variables', () => {
    const m = payment();
    expect(m.subject).toBe('hoje alguém escolheu fazer parte da história do seu bebê');
    expect(m.html).toContain('Helena, aconteceu uma coisa bonita hoje.');
    expect(m.html).toContain(
      '<strong style="color:#6b3c5e">Tia Rosa</strong> passou pela sua lista',
    );
    expect(m.html).toContain('RECADINHO DE TIA ROSA');
    expect(m.html).toContain('“Que esse bebê chegue com muita saúde!”');
    expect(m.html).toContain('PRESENTE RECEBIDO');
    expect(m.html).toContain('Carrinho de passeio');
    expect(m.html).toContain('VER MEU CHÁ');
    expect(m.html).toContain('feliz por você,');
    expect(m.text).toContain('Tia Rosa passou pela sua lista');
    expect(m.text).not.toContain('{{');
    expect(m.html).not.toContain('{{');
  });

  it('anonymous guest becomes "alguém"', () => {
    for (const guestName of [null, '', '   ']) {
      const m = payment({ guestName });
      expect(m.html).toContain(
        '<strong style="color:#6b3c5e">alguém</strong> passou pela sua lista',
      );
      expect(m.html).toContain('>RECADINHO<');
    }
  });

  it('no message hides the whole recadinho block', () => {
    for (const guestMessage of [null, '', '  ']) {
      const m = payment({ guestMessage });
      expect(m.html).not.toContain('RECADINHO');
      expect(m.text).not.toContain('recadinho');
    }
  });

  it('multiple gifts render as a list with quantities', () => {
    const m = payment({
      gifts: [
        { name: 'Fraldas P', quantity: 3 },
        { name: 'Banheira', quantity: 1 },
      ],
    });
    expect(m.html).toContain('PRESENTES RECEBIDOS');
    expect(m.html).toContain('Fraldas P × 3');
    expect(m.html).toContain('Banheira');
    expect(m.html).not.toContain('Banheira × 1');
    expect(m.text).toContain('- Fraldas P × 3');
    expect(m.text).toContain('- Banheira');
  });

  it('no gift snapshot falls back to a neutral line', () => {
    expect(payment({ gifts: [] }).html).toContain('um presente da sua lista');
  });

  it('escapes guest-controlled text in HTML and keeps line breaks safe', () => {
    const m = payment({
      guestName: '<img src=x onerror=alert(1)>',
      guestMessage: 'oi\n<script>alert(1)</script> & beijos',
      gifts: [{ name: '"><b>x</b>', quantity: 1 }],
    });
    expect(m.html).not.toContain('<script>alert');
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).not.toContain('"><b>x</b>');
    expect(m.html).toContain('oi<br>&lt;script&gt;alert(1)&lt;/script&gt; &amp; beijos');
  });

  it('a member with extrato access gets the neutral variant', () => {
    const m = payment({ recipientIsOwner: false, recipientName: 'Marcos', ownerName: 'Helena' });
    expect(m.subject).toBe('hoje alguém escolheu fazer parte da história do bebê de Helena');
    expect(m.html).toContain('Marcos, aconteceu uma coisa bonita hoje no chá de Helena.');
    expect(m.html).toContain('passou pela lista de Helena');
    expect(m.html).not.toContain('sua lista');
    expect(m.html).toContain('porque tem acesso a um chá de bebê na EuNeném.');
  });

  it('a member never gets the "avalie sua experiência" block; the owner still does', () => {
    const member = payment({
      recipientIsOwner: false,
      recipientName: 'Marcos',
      ownerName: 'Helena',
    });
    for (const part of [member.html, member.text]) {
      expect(part).not.toMatch(/avalie sua experi[eê]ncia/i);
      expect(part).not.toContain('como foi montar o seu chá?');
      expect(part).not.toContain('avaliar-email');
      expect(part).not.toMatch(/poderia ser melhor/i);
      expect(part).not.toMatch(/escrever meu coment[aá]rio/i);
    }
    // The rest of the member footer is intact.
    expect(member.html).toContain(
      'href="https://staging.eunenem.com/email/descadastrar?token=UNSUB"',
    );
    expect(member.text).toContain(
      'descadastrar: https://staging.eunenem.com/email/descadastrar?token=UNSUB',
    );
    expect(member.text).toContain(
      'preferências de e-mail: https://staging.eunenem.com/email/preferencias?token=PREF',
    );
    const owner = payment();
    expect(owner.html).toContain('como foi montar o seu chá?');
    expect(owner.html).toContain('href="https://staging.eunenem.com/avaliar-email?token=FB"');
    expect(owner.text).toContain('avalie sua experiência — como foi montar o seu chá?');
  });

  it('a member without a known owner name gets neutral copy, never their own name as owner', () => {
    for (const ownerName of [undefined, null, '  ']) {
      const m = payment({ recipientIsOwner: false, recipientName: 'Marcos', ownerName });
      expect(m.subject).toBe('hoje alguém escolheu fazer parte da história do bebê');
      expect(m.html).toContain('do bebê</h1>');
      expect(m.html).toContain('Marcos, aconteceu uma coisa bonita hoje no chá.');
      expect(m.html).toContain('passou pela lista do chá');
      expect(m.html).not.toMatch(/de Marcos|Marcos,.*de Marcos/);
      expect(m.text).not.toContain('de Marcos');
    }
  });

  it('owner name falls back to the recipient name', () => {
    expect(payment({ ownerName: undefined, recipientName: 'Ana' }).html).toContain(
      'Ana, aconteceu uma coisa bonita hoje.',
    );
  });
});

const painel = 'https://staging.eunenem.com/painel/helena/c/0b6c2d1e-0000-4000-8000-000000000001';
function recado(overrides: Record<string, unknown> = {}) {
  return renderLifecycleEmail('new_message', {
    ...common,
    dashboardUrl: painel,
    guestName: 'Tia Rosa',
    guestMessage: 'Que venha com saúde!\nbeijos <3',
    ...overrides,
  });
}
function presenca(overrides: Record<string, unknown> = {}) {
  return renderLifecycleEmail('presence_confirmed', {
    ...common,
    dashboardUrl: painel,
    guestName: 'Vovó Lúcia',
    ...overrides,
  });
}

describe('owner alerts (new_message, presence_confirmed)', () => {
  it.each([
    ['new_message', recado()],
    ['presence_confirmed', presenca()],
  ] as const)('%s keeps the email-safe contract, with opt-out links and no feedback block', (_t, m) => {
    expect(m.html).toMatch(/^<!doctype html>/i);
    expect(m.html).toContain('role="presentation"');
    expect(m.html).not.toMatch(/<script|<form|<input|display:\s*(flex|grid)|var\(--/i);
    expect(m.html).toMatch(
      /bgcolor="#[0-9a-f]{6}"[^>]*background-color:#[0-9a-f]{6};background-image:linear-gradient/,
    );
    expect(m.html).toContain('href="https://staging.eunenem.com/email/descadastrar?token=UNSUB"');
    expect(m.html).toContain('href="https://staging.eunenem.com/email/preferencias?token=PREF"');
    expect(m.text).toContain(
      'descadastrar: https://staging.eunenem.com/email/descadastrar?token=UNSUB',
    );
    expect(m.text).toContain(
      'preferências de e-mail: https://staging.eunenem.com/email/preferencias?token=PREF',
    );
    // Frequent alerts never carry the onboarding survey.
    expect(m.html).not.toContain('avaliar-email');
    expect(m.text).not.toContain('avalie sua experiência');
    expect(m.text).not.toMatch(/<[a-z]/i);
    expect(m.html).not.toContain('fonts.googleapis.com');
  });

  it('new_message shows the escaped recado and links to the campaign mensagens page', () => {
    const m = recado();
    expect(m.subject).toBe('Tia Rosa deixou um recadinho pro seu bebê ♡');
    expect(m.html).toContain('Helena, chegou um recadinho novo.');
    expect(m.html).toContain('“Que venha com saúde!<br>beijos &lt;3”');
    expect(m.html).not.toContain('<3');
    expect(m.html).toContain(`href="${painel}/mensagens"`);
    expect(m.text).toContain('“Que venha com saúde!\nbeijos <3”');
    expect(m.text).toContain(`Ver recados: ${painel}/mensagens`);
  });

  it('new_message without a guest name or text stays neutral', () => {
    const m = recado({ guestName: '  ', guestMessage: null });
    expect(m.subject).toBe('alguém deixou um recadinho pro seu bebê ♡');
    expect(m.html).not.toContain('recadinho de');
  });

  it('presence_confirmed names the guest, escapes it, and links to convidados', () => {
    const m = presenca({ guestName: 'Lu <b>' });
    expect(m.subject).toBe('Lu <b> confirmou presença no seu chá ♡');
    expect(m.html).toContain('<title>Lu &lt;b&gt; confirmou presença no seu chá ♡</title>');
    expect(m.html).toContain('<strong style="color:#6b3c5e">Lu &lt;b&gt;</strong>');
    expect(m.html).toContain(`href="${painel}/convidados"`);
    expect(m.text).toContain(`Ver convidados: ${painel}/convidados`);
    expect(presenca({ guestName: null }).subject).toBe(
      'um convidado confirmou presença no seu chá ♡',
    );
  });
});
