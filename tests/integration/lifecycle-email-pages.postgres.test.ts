import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLifecycleEmailTokens } from '../../apps/eunenem-server/server/auth/lifecycle-email-tokens.js';
import { createLifecycleEmailPages } from '../../apps/eunenem-server/server/lifecycle-email-pages.js';
import { consumeRateLimit } from '../../apps/eunenem-server/server/trpc/rate-limit.js';
import { EmailFeedbackPostgres } from '../../src/adapters/email/email-feedback.postgres.js';
import { LifecycleEmailPreferencesPostgres } from '../../src/adapters/email/lifecycle-email-preferences.postgres.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const ORIGIN = 'https://staging.eunenem.test';
const tokens = createLifecycleEmailTokens('pages-test-secret-long-enough-for-hmac-signing');
let testDb: TestDatabase;
let preferences: LifecycleEmailPreferencesPostgres;
let app: ReturnType<typeof createLifecycleEmailPages>;
const sessionUser = { userId: randomUUID(), tenantId: randomUUID() };

beforeAll(async () => {
  testDb = await createTestDatabase();
  preferences = new LifecycleEmailPreferencesPostgres(testDb.db);
  app = createLifecycleEmailPages({
    tokens,
    preferences,
    feedback: new EmailFeedbackPostgres(testDb.db),
    allowedOrigins: [ORIGIN],
    consumeRateLimit: async (key) =>
      (await consumeRateLimit(testDb.db, { key, max: 20, windowMs: 60_000 })).allowed,
    // The real resolver reads the BetterAuth cookie; here a header stands in for it.
    resolveSessionUser: async (headers) => (headers.get('x-test-session') ? sessionUser : null),
  });
}, 180000);
afterAll(async () => {
  await testDb?.teardown();
});

async function seedDelivery() {
  const tenantId = randomUUID();
  const eventId = randomUUID();
  const deliveryId = randomUUID();
  await testDb.db
    .insertInto('lifecycle_email_events')
    .values({
      id: eventId,
      tenant_id: tenantId,
      type: 'welcome',
      subject_id: randomUUID(),
      occurred_at: new Date(),
    })
    .execute();
  await testDb.db
    .insertInto('lifecycle_email_deliveries')
    .values({
      id: deliveryId,
      event_id: eventId,
      tenant_id: tenantId,
      user_id: randomUUID(),
      type: 'welcome',
    })
    .execute();
  return deliveryId;
}

const feedbackRows = (deliveryId: string) =>
  testDb.db
    .selectFrom('email_feedback')
    .selectAll()
    .where('delivery_id', '=', deliveryId)
    .execute();

function post(
  path: string,
  form: Record<string, string | string[]>,
  origin: string | null = ORIGIN,
) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) for (const item of [v].flat()) body.append(k, item);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (origin) headers.origin = origin;
  return app.request(path, { method: 'POST', headers, body: body.toString() });
}

describe('/avaliar-email', () => {
  it('GET with a rating link renders the form preselected and writes nothing', async () => {
    const deliveryId = await seedDelivery();
    const token = tokens.signFeedbackToken(deliveryId);
    const res = await app.request(`/avaliar-email?token=${token}&nota=4`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('como foi montar o seu chá?');
    expect(html).toMatch(/value="4" checked/);
    expect(html).toContain('Enviar avaliação');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(await feedbackRows(deliveryId)).toEqual([]);
  });

  it('POST stores rating + comment, idempotently per delivery, and confirms', async () => {
    const deliveryId = await seedDelivery();
    const token = tokens.signFeedbackToken(deliveryId);
    const first = await post('/avaliar-email', { token, nota: '3', comentario: '' });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Obrigada pela sua avaliação!');
    await post('/avaliar-email', { token, nota: '5', comentario: '  faltou <b>nada</b>  ' });
    const rows = await feedbackRows(deliveryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nota: 5, comentario: 'faltou <b>nada</b>' });
    // The next GET shows the saved answer, escaped.
    const html = await (await app.request(`/avaliar-email?token=${token}`)).text();
    expect(html).toMatch(/value="5" checked/);
    expect(html).toContain('faltou &lt;b&gt;nada&lt;/b&gt;');
    expect(html).not.toContain('<b>nada</b>');
  });

  it('comment-only answer from "escrever meu comentário" is accepted', async () => {
    const deliveryId = await seedDelivery();
    const token = tokens.signFeedbackToken(deliveryId);
    const res = await post('/avaliar-email', { token, comentario: 'só queria dizer obrigada' });
    expect(res.status).toBe(200);
    expect((await feedbackRows(deliveryId))[0]).toMatchObject({ nota: null });
  });

  it('rejects invalid input inline without writing', async () => {
    const deliveryId = await seedDelivery();
    const token = tokens.signFeedbackToken(deliveryId);
    for (const form of [
      { token, nota: '7' },
      { token, nota: '', comentario: '' },
      { token, nota: '2', comentario: 'x'.repeat(1001) },
    ]) {
      const res = await post('/avaliar-email', form);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain('role="alert"');
    }
    expect(await feedbackRows(deliveryId)).toEqual([]);
  });

  it('tampered, wrong-scope or unknown-delivery tokens never write', async () => {
    const deliveryId = await seedDelivery();
    const good = tokens.signFeedbackToken(deliveryId);
    const wrongScope = tokens.signPreferenceToken({ userId: randomUUID(), tenantId: randomUUID() });
    for (const token of [`${good}x`, wrongScope, 'nope']) {
      expect((await app.request(`/avaliar-email?token=${encodeURIComponent(token)}`)).status).toBe(
        400,
      );
      expect((await post('/avaliar-email', { token, nota: '5' })).status).toBe(400);
    }
    const ghost = tokens.signFeedbackToken(randomUUID());
    expect((await post('/avaliar-email', { token: ghost, nota: '5' })).status).toBe(404);
    expect(await feedbackRows(deliveryId)).toEqual([]);
  });

  it('cross-site POST is refused', async () => {
    const deliveryId = await seedDelivery();
    const token = tokens.signFeedbackToken(deliveryId);
    expect((await post('/avaliar-email', { token, nota: '5' }, 'https://evil.test')).status).toBe(
      403,
    );
    expect((await post('/avaliar-email', { token, nota: '5' }, null)).status).toBe(403);
    expect(await feedbackRows(deliveryId)).toEqual([]);
  });
});

describe('/email/descadastrar', () => {
  it('GET confirms without writing; POST turns off only that type', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const token = tokens.signPreferenceToken({ userId, tenantId, type: 'payment_received' });
    const page = await app.request(`/email/descadastrar?token=${token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Desativar este tipo de e-mail');
    expect(html).toContain('Presente recebido');
    expect((await preferences.getPreferences(userId, tenantId)).payment_received).toBe(true);

    const done = await post('/email/descadastrar', { token, acao: 'desativar' });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Pronto!');
    expect(await preferences.getPreferences(userId, tenantId)).toEqual({
      welcome: true,
      list_ready: true,
      event_reminder: true,
      payment_received: false,
    });

    await post('/email/descadastrar', { token, acao: 'reativar' });
    expect((await preferences.getPreferences(userId, tenantId)).payment_received).toBe(true);
  });

  it('an untyped token is sent to the preferences page', async () => {
    const token = tokens.signPreferenceToken({ userId: randomUUID(), tenantId: randomUUID() });
    const res = await app.request(`/email/descadastrar?token=${token}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/email/preferencias?token=${token}`);
  });

  it('invalid token and cross-site POST are refused', async () => {
    expect((await app.request('/email/descadastrar?token=bad')).status).toBe(400);
    const userId = randomUUID();
    const tenantId = randomUUID();
    const token = tokens.signPreferenceToken({ userId, tenantId, type: 'welcome' });
    expect(
      (await post('/email/descadastrar', { token, acao: 'desativar' }, 'https://evil.test')).status,
    ).toBe(403);
    expect((await preferences.getPreferences(userId, tenantId)).welcome).toBe(true);
  });
});

describe('/email/preferencias', () => {
  it('GET lists the four types with current state; POST saves the toggles', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    await preferences.setPreferences(userId, tenantId, { event_reminder: false });
    const token = tokens.signPreferenceToken({ userId, tenantId });
    const html = await (await app.request(`/email/preferencias?token=${token}`)).text();
    for (const label of [
      'Boas-vindas',
      'Lista pronta para compartilhar',
      'Lembrete do chá (5 dias antes)',
      'Presente recebido',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/value="welcome" checked/);
    expect(html).not.toMatch(/value="event_reminder" checked/);
    expect(html).toContain('Salvar preferências');

    const saved = await post('/email/preferencias', {
      token,
      tipo: ['event_reminder', 'payment_received'],
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('Preferências salvas.');
    expect(await preferences.getPreferences(userId, tenantId)).toEqual({
      welcome: false,
      list_ready: false,
      event_reminder: true,
      payment_received: true,
    });
  });

  it('painel entry without a token uses the session, and asks to log in otherwise', async () => {
    const anon = await app.request('/email/preferencias');
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain('href="/login"');
    expect(anonHtml).not.toContain('Salvar preferências');

    const res = await app.request('/email/preferencias', { headers: { 'x-test-session': '1' } });
    const html = await res.text();
    expect(html).toContain('Salvar preferências');
    const token = /name="token" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(tokens.verifyPreferenceToken(token)).toEqual(sessionUser);
    await post('/email/preferencias', { token, tipo: ['welcome'] });
    expect(
      await preferences.getPreferences(sessionUser.userId, sessionUser.tenantId),
    ).toMatchObject({
      welcome: true,
      payment_received: false,
    });
  });

  it('a type-scoped token can only change its own type', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const token = tokens.signPreferenceToken({ userId, tenantId, type: 'welcome' });
    const html = await (await app.request(`/email/preferencias?token=${token}`)).text();
    expect(html).toContain('Boas-vindas');
    expect(html).not.toContain('Presente recebido');
    await post('/email/preferencias', { token, tipo: [] });
    expect(await preferences.getPreferences(userId, tenantId)).toEqual({
      welcome: false,
      list_ready: true,
      event_reminder: true,
      payment_received: true,
    });
  });
});
