import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type {
  EmailFeedbackAnswer,
  EmailFeedbackPostgres,
} from '../../../src/adapters/email/email-feedback.postgres.js';
import {
  LIFECYCLE_EMAIL_TYPES,
  type LifecycleEmailPreferencesPostgres,
  type LifecycleEmailType,
} from '../../../src/adapters/email/lifecycle-email-preferences.postgres.js';
import type { LifecycleEmailTokens } from './auth/lifecycle-email-tokens.js';

/**
 * Token pages linked from the lifecycle emails (aperture-tykv8):
 *   /avaliar-email        "Avalie sua experiência" (nota 1–5 + comentário)
 *   /email/descadastrar   one-type opt-out
 *   /email/preferencias   per-type toggles
 *
 * Plain server-rendered HTML, no JS. GET never writes (link scanners and
 * mail-client prefetchers follow GETs); every write is a same-origin POST
 * carrying the signed token as a hidden field. Tokens are never logged and
 * pages send no referrer, so they don't leak to third parties.
 */
export interface LifecycleEmailPagesDeps {
  tokens: Pick<
    LifecycleEmailTokens,
    'verifyFeedbackToken' | 'verifyPreferenceToken' | 'signPreferenceToken'
  >;
  preferences: Pick<LifecycleEmailPreferencesPostgres, 'getPreferences' | 'setPreferences'>;
  feedback: Pick<EmailFeedbackPostgres, 'save' | 'findByDeliveryId'>;
  /** Origins allowed to POST (BETTER_AUTH_URL + TRUSTED_ORIGINS). */
  allowedOrigins: readonly string[];
  /** Returns false when the bucket is exhausted. */
  consumeRateLimit: (key: string) => Promise<boolean>;
  /** Logged-in entry from the painel: who is signed in, or null. */
  resolveSessionUser: (headers: Headers) => Promise<{ userId: string; tenantId: string } | null>;
}

export const LIFECYCLE_EMAIL_TYPE_LABELS: Record<
  LifecycleEmailType,
  { label: string; description: string }
> = {
  welcome: {
    label: 'Boas-vindas',
    description: 'o primeiro e-mail, logo depois de criar sua conta.',
  },
  list_ready: {
    label: 'Lista pronta para compartilhar',
    description: 'quando sua lista ganha os primeiros presentes.',
  },
  event_reminder: {
    label: 'Lembrete do chá (5 dias antes)',
    description: 'uma passada de olho nos detalhes antes do grande dia.',
  },
  payment_received: {
    label: 'Presente recebido',
    description: 'cada vez que alguém presenteia pela sua lista.',
  },
};

const C = {
  page: '#efece9',
  card: '#ffffff',
  soft: '#f8f7f6',
  line: '#efe2e9',
  ink: '#6b3c5e',
  body: '#5c3a4f',
  muted: '#8a7282',
  accent: '#8e5fa8',
  ok: '#4f7a1f',
  error: '#b42318',
};
const HAND = "'Patrick Hand','Comic Sans MS','Segoe Print','Bradley Hand',cursive";
const SANS = 'Arial,Helvetica,sans-serif';

const FEEDBACK_RATE_LIMIT = 'lifecycle-email:feedback';
const PREFERENCES_RATE_LIMIT = 'lifecycle-email:preferences';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(c: Context, status: number, title: string, body: string) {
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  return c.html(
    `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · EuNeném</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:${C.page};color:${C.body};font-family:${SANS};font-size:16px;line-height:1.5}
main{max-width:560px;margin:0 auto;padding:32px 16px 48px}
.logo{display:block;margin:0 0 24px}
.card{background:${C.card};border:1px solid ${C.line};border-radius:24px;padding:32px 28px}
h1{font-family:${HAND};font-weight:normal;color:${C.ink};font-size:32px;line-height:1.15;margin:0 0 8px}
p{margin:0 0 16px}
.muted{color:${C.muted};font-size:14px}
fieldset{border:0;padding:0;margin:0 0 20px}
legend,label.title{display:block;font-size:12px;letter-spacing:2px;font-weight:bold;color:${C.muted};margin:0 0 10px;text-transform:uppercase}
.scale{display:flex;gap:10px}
.scale label{flex:1}
.scale input{position:absolute;opacity:0}
.scale span{display:block;text-align:center;font-family:${HAND};font-size:24px;line-height:52px;border-radius:14px;color:${C.ink};cursor:pointer;border:2px solid transparent}
.scale input:checked+span{border-color:${C.ink};box-shadow:0 0 0 2px ${C.card} inset}
.scale input:focus-visible+span{outline:3px solid ${C.accent};outline-offset:2px}
.ends{display:flex;justify-content:space-between;font-size:11px;letter-spacing:1px;color:${C.muted};margin-top:6px}
textarea{width:100%;min-height:120px;border:1px solid ${C.line};border-radius:14px;padding:12px;font:inherit;color:${C.body};background:${C.soft}}
.pref{display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-bottom:1px solid ${C.line}}
.pref:last-of-type{border-bottom:0}
.pref input{width:20px;height:20px;margin-top:2px;accent-color:${C.accent}}
.pref strong{display:block;color:${C.ink}}
button{display:inline-block;border:0;border-radius:999px;background:${C.accent};color:#fff;font:bold 14px ${SANS};letter-spacing:2px;text-transform:uppercase;padding:16px 32px;cursor:pointer}
button.secondary{background:transparent;color:${C.accent};border:2px solid ${C.accent}}
.notice{border-radius:14px;padding:12px 16px;margin:0 0 20px;font-size:15px}
.notice.ok{background:#eef4d6;color:${C.ok}}
.notice.error{background:#fde4ec;color:${C.error}}
a{color:${C.accent}}
</style></head>
<body><main>
<img class="logo" src="/public/logo-landing.png" width="132" height="44" alt="EuNeném">
<div class="card">${body}</div>
<p class="muted" style="margin-top:24px;text-align:center">dúvidas? <a href="mailto:oi@eunenem.com">oi@eunenem.com</a></p>
</main></body></html>`,
    status as 200,
  );
}

function invalidLink(c: Context, status = 400) {
  return page(
    c,
    status,
    'Link inválido',
    `<h1>este link não vale mais</h1>
<p>ele pode ter expirado (os links dos e-mails valem por 30 dias) ou estar incompleto.</p>
<p class="muted">se precisar de ajuda, é só escrever pra gente.</p>`,
  );
}

function sameOrigin(c: Context, allowed: readonly string[]): boolean {
  const origin = c.req.header('origin');
  return origin !== undefined && allowed.includes(origin);
}

function forbidden(c: Context) {
  return page(c, 403, 'Não permitido', '<h1>não foi possível salvar</h1><p>abra o link do e-mail de novo e tente outra vez.</p>');
}

function tooMany(c: Context) {
  return page(c, 429, 'Muitas tentativas', '<h1>calma, só um minutinho</h1><p>recebemos muitas tentativas seguidas. tente de novo daqui a pouco.</p>');
}

function hiddenToken(token: string): string {
  return `<input type="hidden" name="token" value="${esc(token)}">`;
}

// ── Avalie sua experiência ──────────────────────────────────────────────────

const RATING_COLOURS = ['#fbe0ea', '#e78fa7', '#f7d560', '#c7dc6e', '#8aa53a'];

const NotaQuery = z.coerce.number().int().min(1).max(5);

const FeedbackForm = z
  .object({
    token: z.string().min(1).max(2048),
    nota: z
      .string()
      .optional()
      .refine((v) => !v || /^[1-5]$/.test(v), 'a nota precisa ser de 1 a 5.')
      .transform((v) => (v ? Number(v) : null)),
    comentario: z
      .string()
      .optional()
      .transform((v) => v?.trim() ?? '')
      .pipe(z.string().max(1000, 'o comentário pode ter até 1000 caracteres.'))
      .transform((v) => (v === '' ? null : v)),
  })
  .refine((v) => v.nota !== null || v.comentario !== null, {
    message: 'escolha uma nota ou escreva um comentário.',
  });

function feedbackPage(
  c: Context,
  opts: {
    status: number;
    token: string;
    answer: EmailFeedbackAnswer;
    notice?: { kind: 'ok' | 'error'; text: string };
  },
) {
  const { answer } = opts;
  const scale = RATING_COLOURS.map(
    (bg, i) =>
      `<label><input type="radio" name="nota" value="${i + 1}"${answer.nota === i + 1 ? ' checked' : ''}><span style="background:${bg}${i === 4 ? ';color:#fff' : ''}">${i + 1}</span></label>`,
  ).join('');
  const notice = opts.notice
    ? `<div class="notice ${opts.notice.kind}" role="${opts.notice.kind === 'error' ? 'alert' : 'status'}">${esc(opts.notice.text)}</div>`
    : '';
  return page(
    c,
    opts.status,
    'Avalie sua experiência',
    `<p class="muted" style="letter-spacing:2px;font-size:12px;font-weight:bold;margin:0 0 8px">AVALIE SUA EXPERIÊNCIA</p>
<h1>como foi montar o seu chá?</h1>
<p>leva um segundinho e ajuda a gente a cuidar melhor das próximas mamães.</p>
${notice}
<form method="post" action="/avaliar-email">
${hiddenToken(opts.token)}
<fieldset><legend>Nota (1 a 5)</legend><div class="scale">${scale}</div>
<div class="ends"><span>PODERIA SER MELHOR</span><span>AMEI</span></div></fieldset>
<label class="title" for="comentario">Comentário (opcional)</label>
<textarea id="comentario" name="comentario" maxlength="1000" placeholder="conta pra gente: o que foi fácil, o que faltou? ♡">${esc(answer.comentario ?? '')}</textarea>
<p class="muted" style="margin:6px 0 20px">até 1000 caracteres.</p>
<button type="submit">Enviar avaliação</button>
</form>`,
  );
}

// ── Preferências / descadastrar ─────────────────────────────────────────────

const PreferenceForm = z.object({
  token: z.string().min(1).max(2048),
  tipo: z.array(z.enum(LIFECYCLE_EMAIL_TYPES)).default([]),
});

const UnsubscribeForm = z.object({
  token: z.string().min(1).max(2048),
  acao: z.enum(['desativar', 'reativar']),
});

function preferencesPage(
  c: Context,
  opts: {
    token: string;
    types: readonly LifecycleEmailType[];
    current: Record<LifecycleEmailType, boolean>;
    saved?: boolean;
  },
) {
  const rows = opts.types
    .map((type) => {
      const { label, description } = LIFECYCLE_EMAIL_TYPE_LABELS[type];
      return `<label class="pref"><input type="checkbox" name="tipo" value="${type}"${opts.current[type] ? ' checked' : ''}><span><strong>${esc(label)}</strong><span class="muted">${esc(description)}</span></span></label>`;
    })
    .join('');
  return page(
    c,
    200,
    'Preferências de e-mail',
    `<h1>preferências de e-mail</h1>
<p>escolha quais e-mails automáticos você quer receber da EuNeném.</p>
${opts.saved ? '<div class="notice ok" role="status">Preferências salvas.</div>' : ''}
<form method="post" action="/email/preferencias">
${hiddenToken(opts.token)}
<fieldset><legend>E-mails automáticos</legend>${rows}</fieldset>
<button type="submit">Salvar preferências</button>
</form>
<p class="muted" style="margin-top:20px">e-mails de acesso (link de login) e comprovantes de pagamento continuam chegando normalmente.</p>`,
  );
}

function unsubscribePage(
  c: Context,
  opts: { token: string; type: LifecycleEmailType; enabled: boolean; changed: boolean },
) {
  const { label } = LIFECYCLE_EMAIL_TYPE_LABELS[opts.type];
  const heading = opts.changed
    ? opts.enabled
      ? 'Pronto! e-mails reativados'
      : 'Pronto! você não vai mais receber esse e-mail'
    : opts.enabled
      ? 'quer parar de receber esse e-mail?'
      : 'esse e-mail já está desativado';
  return page(
    c,
    200,
    'Descadastrar',
    `<h1>${esc(heading)}</h1>
<p>tipo de e-mail: <strong>${esc(label)}</strong></p>
<p class="muted">os outros e-mails automáticos não mudam. e-mails de acesso e comprovantes de pagamento continuam chegando normalmente.</p>
<form method="post" action="/email/descadastrar">
${hiddenToken(opts.token)}
${
  opts.enabled
    ? '<input type="hidden" name="acao" value="desativar"><button type="submit">Desativar este tipo de e-mail</button>'
    : '<input type="hidden" name="acao" value="reativar"><button type="submit" class="secondary">Reativar este e-mail</button>'
}
</form>`,
  );
}

async function readForm(c: Context): Promise<Record<string, string | string[]>> {
  const body = await c.req.parseBody({ all: true });
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(body)) {
    const values = [value].flat().filter((v): v is string => typeof v === 'string');
    out[key] = key === 'tipo' ? values : (values[0] ?? '');
  }
  return out;
}

export function createLifecycleEmailPages(deps: LifecycleEmailPagesDeps): Hono {
  const app = new Hono();

  app.get('/avaliar-email', async (c) => {
    const token = c.req.query('token') ?? '';
    const claims = deps.tokens.verifyFeedbackToken(token);
    if (!claims) return invalidLink(c);
    const saved = await deps.feedback.findByDeliveryId(claims.deliveryId);
    const preset = NotaQuery.safeParse(c.req.query('nota'));
    return feedbackPage(c, {
      status: 200,
      token,
      answer: {
        nota: preset.success ? preset.data : (saved?.nota ?? null),
        comentario: saved?.comentario ?? null,
      },
    });
  });

  app.post('/avaliar-email', async (c) => {
    if (!sameOrigin(c, deps.allowedOrigins)) return forbidden(c);
    const raw = await readForm(c);
    const token = typeof raw.token === 'string' ? raw.token : '';
    const claims = deps.tokens.verifyFeedbackToken(token);
    if (!claims) return invalidLink(c);
    if (!(await deps.consumeRateLimit(`${FEEDBACK_RATE_LIMIT}:${claims.deliveryId}`))) {
      return tooMany(c);
    }
    const parsed = FeedbackForm.safeParse(raw);
    if (!parsed.success) {
      const nota = typeof raw.nota === 'string' ? NotaQuery.safeParse(raw.nota) : null;
      return feedbackPage(c, {
        status: 422,
        token,
        answer: {
          nota: nota?.success ? nota.data : null,
          comentario: typeof raw.comentario === 'string' ? raw.comentario.slice(0, 1000) : null,
        },
        notice: { kind: 'error', text: parsed.error.issues[0]?.message ?? 'confira os campos.' },
      });
    }
    const result = await deps.feedback.save({
      deliveryId: claims.deliveryId,
      nota: parsed.data.nota,
      comentario: parsed.data.comentario,
    });
    if (result === 'delivery_not_found') return invalidLink(c, 404);
    return feedbackPage(c, {
      status: 200,
      token,
      answer: { nota: parsed.data.nota, comentario: parsed.data.comentario },
      notice: {
        kind: 'ok',
        text: 'Obrigada pela sua avaliação! se quiser, dá pra mudar a nota ou o comentário aqui mesmo.',
      },
    });
  });

  app.get('/email/descadastrar', async (c) => {
    const token = c.req.query('token') ?? '';
    const claims = deps.tokens.verifyPreferenceToken(token);
    if (!claims) return invalidLink(c);
    if (!claims.type) return c.redirect(`/email/preferencias?token=${encodeURIComponent(token)}`, 303);
    const current = await deps.preferences.getPreferences(claims.userId, claims.tenantId);
    return unsubscribePage(c, { token, type: claims.type, enabled: current[claims.type], changed: false });
  });

  app.post('/email/descadastrar', async (c) => {
    if (!sameOrigin(c, deps.allowedOrigins)) return forbidden(c);
    const parsed = UnsubscribeForm.safeParse(await readForm(c));
    if (!parsed.success) return invalidLink(c);
    const claims = deps.tokens.verifyPreferenceToken(parsed.data.token);
    if (!claims?.type) return invalidLink(c);
    if (!(await deps.consumeRateLimit(`${PREFERENCES_RATE_LIMIT}:${claims.userId}`))) {
      return tooMany(c);
    }
    const enabled = parsed.data.acao === 'reativar';
    await deps.preferences.setPreferences(claims.userId, claims.tenantId, { [claims.type]: enabled });
    return unsubscribePage(c, { token: parsed.data.token, type: claims.type, enabled, changed: true });
  });

  app.get('/email/preferencias', async (c) => {
    let token = c.req.query('token');
    if (token === undefined) {
      // Painel entry: no email link, so mint an all-types token for the
      // signed-in user. It only travels in this page's hidden form field.
      const user = await deps.resolveSessionUser(c.req.raw.headers);
      if (!user) {
        return page(
          c,
          200,
          'Preferências de e-mail',
          `<h1>preferências de e-mail</h1>
<p>entre na sua conta para escolher quais e-mails automáticos você quer receber.</p>
<p><a href="/login">entrar na minha conta</a></p>
<p class="muted">ou use o link “preferências de e-mail” no rodapé de qualquer e-mail nosso.</p>`,
        );
      }
      token = deps.tokens.signPreferenceToken(user);
    }
    const claims = deps.tokens.verifyPreferenceToken(token);
    if (!claims) return invalidLink(c);
    const current = await deps.preferences.getPreferences(claims.userId, claims.tenantId);
    const types = claims.type ? [claims.type] : LIFECYCLE_EMAIL_TYPES;
    return preferencesPage(c, { token, types, current });
  });

  app.post('/email/preferencias', async (c) => {
    if (!sameOrigin(c, deps.allowedOrigins)) return forbidden(c);
    const parsed = PreferenceForm.safeParse(await readForm(c));
    if (!parsed.success) return invalidLink(c);
    const claims = deps.tokens.verifyPreferenceToken(parsed.data.token);
    if (!claims) return invalidLink(c);
    if (!(await deps.consumeRateLimit(`${PREFERENCES_RATE_LIMIT}:${claims.userId}`))) {
      return tooMany(c);
    }
    // A type-scoped token (from one email's footer) only ever changes its own type.
    const types = claims.type ? [claims.type] : LIFECYCLE_EMAIL_TYPES;
    const patch = Object.fromEntries(types.map((t) => [t, parsed.data.tipo.includes(t)]));
    await deps.preferences.setPreferences(claims.userId, claims.tenantId, patch);
    const current = await deps.preferences.getPreferences(claims.userId, claims.tenantId);
    return preferencesPage(c, { token: parsed.data.token, types, current, saved: true });
  });

  return app;
}
