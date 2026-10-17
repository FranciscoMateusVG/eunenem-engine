/**
 * Render every lifecycle email (and its edge-case variants) to HTML + PNG for
 * visual review against the operator's PDFs. Synthetic data only; sends nothing.
 *
 *   pnpm tsx scripts/render-lifecycle-email-previews.ts [outDir] [assetBaseUrl]
 *
 * assetBaseUrl defaults to https://eunenem.com (where /public/logo-landing.png
 * is served). Uses the Playwright Chromium already installed for e2e.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import {
  type LifecycleEmailCommonVars,
  type RenderedLifecycleEmail,
  renderLifecycleEmail,
} from '../apps/eunenem-server/server/auth/lifecycle-email.js';

const outDir = resolve(process.argv[2] ?? 'lifecycle-email-previews');
const base = process.argv[3] ?? 'https://eunenem.com';

const common: LifecycleEmailCommonVars = {
  recipientName: 'Helena',
  dashboardUrl: `${base}/painel/helena`,
  preferencesUrl: `${base}/email/preferencias?token=preview`,
  unsubscribeUrl: `${base}/email/descadastrar?token=preview`,
  feedbackUrl: `${base}/avaliar-email?token=preview`,
  assetBaseUrl: base,
};

const payment = {
  ...common,
  ownerName: 'Helena',
  guestName: 'Tia Rosa',
  guestMessage: 'Que esse bebê chegue com muita saúde e cercado de amor! ♡',
  gifts: [{ name: 'Carrinho de passeio', quantity: 1 }],
  recipientIsOwner: true,
};

const previews: Record<string, RenderedLifecycleEmail> = {
  '1-welcome': renderLifecycleEmail('welcome', {
    ...common,
    giftCount: 0,
    startUrl: `${base}/painel/helena`,
  }),
  '2-list-ready': renderLifecycleEmail('list_ready', {
    ...common,
    shareUrl: `${base}/painel/helena/convite`,
  }),
  '3-event-reminder': renderLifecycleEmail('event_reminder', {
    ...common,
    eventDate: 'sábado, 25 de outubro',
  }),
  '4-payment-received': renderLifecycleEmail('payment_received', payment),
  '4b-payment-anonymous-no-message-multi': renderLifecycleEmail('payment_received', {
    ...payment,
    guestName: null,
    guestMessage: null,
    gifts: [
      { name: 'Fraldas P', quantity: 3 },
      { name: 'Banheira dobrável', quantity: 1 },
    ],
  }),
  '4c-payment-member-variant': renderLifecycleEmail('payment_received', {
    ...payment,
    recipientName: 'Marcos',
    recipientIsOwner: false,
  }),
};

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, email] of Object.entries(previews)) {
    await writeFile(join(outDir, `${name}.html`), email.html);
    await writeFile(join(outDir, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}`);
    for (const [suffix, width] of [
      ['', 680],
      ['-mobile', 360],
    ] as const) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.setContent(email.html, { waitUntil: 'networkidle' });
      await page.screenshot({ path: join(outDir, `${name}${suffix}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`rendered ${Object.keys(previews).length} emails to ${outDir}`);
