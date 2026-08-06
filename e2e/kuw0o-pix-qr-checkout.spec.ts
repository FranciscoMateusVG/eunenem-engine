/**
 * Inter PIX checkout routing — visitor QR flow (aperture-kuw0o).
 *
 * Targets the dedicated :3004 server (playwright.config.ts) which boots with
 * COBRANCA_PIX_PROVIDER='fake', flipping obterConfigCheckout.pixViaQr to true
 * so a visitor picking PIX routes through OUR identity form (PixIdentityForm)
 * and QR screen (PixQrPanel) instead of the Stripe iframe. Absolute URLs are
 * used for navigation — the mechanism the stripe-webhook specs use for :3003
 * (fixtures default to the :3002 baseURL; all servers share one Postgres, so
 * seededData's magic-link mint against :3002 provisions data :3004 serves).
 *
 * The negative test runs against the DEFAULT :3002 server (COBRANCA_PIX_PROVIDER
 * unset → 'stripe'): the same PIX pick must NOT detour through our identity
 * form — it goes straight to the stripe_embedded arm. That asserts the flag
 * gate itself.
 *
 * ── COMPOSITION-ROOT FINDINGS (caught by this spec's first run; FIXED in the
 *    same PR — setup.ts 'fake' branch, aperture-kuw0o) ──
 *
 * The bare `new PixCobrancaProviderFake()` binding made the QR flow
 * undrivable through the real UI: (1) e2eMagicOutcomes defaulted false
 * (EUNENEM_FAKE_E2E_MAGIC only reached TransferenciaProviderFake), (2) the
 * fake's default frozen clock (2026-01-01) birthed every charge already
 * expired — PixQrPanel rendered the expired panel on mount, and (3) the
 * per-boot ordinal txids collided with persisted rows under the unique
 * intencao_external_ref index on the second local run. The composition root
 * now wires a real clock, the gated magic flag, and a per-boot-unique
 * txidFactory. Classic e2e-catches-what-lower-cant: the unit suite injects
 * its own options and never sees the binding.
 *
 * The magic test seeds a 1273-cent gift so the CHARGE totals exactly
 * PIX_COBRANCA_FAKE_MAGIC_CENTS.autoComplete (1337 = 1273 + ceil(5% fee))
 * → first consult reports 'concluida' → the poll flips the panel to
 * confirmed. Non-magic tests seed 4200 so the scannable state holds still.
 */
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedAvailableGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

/** Dedicated COBRANCA_PIX_PROVIDER='fake' server (playwright.config.ts). */
const PIX_SERVER = 'http://localhost:3004';

/** PIX_COBRANCA_FAKE_MAGIC_CENTS.autoComplete — arms the fake's first-consult
 *  'concluida' the moment e2eMagicOutcomes gets wired in setup.ts. */
const MAGIC_AUTO_COMPLETE_CENTS = 1337;

/** The fake provider's copia-e-cola prefix (pixCopiaEColaFactory default). */
const FAKE_BR_CODE_PREFIX = '000201FAKE-PIX-';

interface SeededGift {
  readonly nome: string;
}

async function seedMagicGift(
  seededData: {
    idCampanha: string;
    idOpcaoPresentes: string;
  },
  valorCents: number = MAGIC_AUTO_COMPLETE_CENTS,
): Promise<SeededGift> {
  const nome = `Pix QR ${randomUUID().slice(0, 8)}`;
  const db = createDatabase(DATABASE_URL);
  try {
    // Belt-and-suspenders: purge fake-charge rows from PRE-nonce runs
    // (finding #3's collisions are fixed by the per-boot txidFactory, but
    // legacy FAKE0000… rows may persist in long-lived local DBs).
    await db.deleteFrom('pagamentos').where('intencao_external_ref', 'like', 'FAKE%').execute();
    await seedAvailableGift(buildSeedGiftRepos(db), {
      idCampanha: seededData.idCampanha,
      idOpcaoPresentes: seededData.idOpcaoPresentes,
      nome,
      valorCents,
    });
  } finally {
    await db.destroy();
  }
  return { nome };
}

/**
 * Shared UI walk: /pagina/<slug> → add gift to cart → close the drawer →
 * "ou comprar agora →" opens the single-gift GiftCheckoutModal → PIX picked →
 * Continuar. Returns the modal locator (scoped by its aria-labelledby — the
 * cart drawer is also role=dialog).
 */
async function openModalAndPickPix(
  page: import('@playwright/test').Page,
  origin: string,
  slug: string,
  giftName: string,
) {
  // Arm BEFORE goto: obterConfigCheckout fires on page load (CartDrawer
  // mounts the hook) or at modal mount — either way it resolves before the
  // await below, and pixViaQr MUST be cached before Continuar is clicked or
  // the modal falls back to the Stripe route (pixViaQr ?? false).
  const configPromise = page.waitForResponse((res) => res.url().includes('obterConfigCheckout'));
  await page.goto(`${origin}/pagina/${slug}`);

  const card = page.locator('article').filter({ hasText: giftName });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /\+ Adicionar/i }).click();

  // Adding auto-opens the CartDrawer — close it; when closed in summary
  // phase it unmounts entirely (CartDrawer.tsx ~L298), freeing the card.
  const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
  await expect(drawer).toBeHidden();

  // The in-cart stepper's single-shot escape hatch opens GiftCheckoutModal.
  await card.getByRole('button', { name: /ou comprar agora/ }).click();

  const modal = page.locator('[role="dialog"][aria-labelledby="gift-checkout-title"]');
  await expect(modal).toBeVisible();

  // PIX is the default metodo — assert, then click anyway (explicit pick).
  const pixRadio = modal.getByRole('radio', { name: /^Pix/ });
  await pixRadio.click();
  await expect(pixRadio).toHaveAttribute('aria-checked', 'true');

  await configPromise;
  await modal.getByRole('button', { name: 'Continuar →' }).click();
  return modal;
}

test.describe('kuw0o — PIX checkout routing (:3004, fake cobrança provider)', () => {
  test('visitor PIX pick routes to OUR identity form (not Stripe), validates inline, and initiates a pix_qr charge', async ({
    page,
    seededData,
  }) => {
    // NON-magic price: the charge stays 'ativa' so the QR screen is stable
    // under assertion (a 1337 gift auto-confirms on the FIRST poll and the
    // panel flips to the success state before locators can look at it).
    const gift = await seedMagicGift(seededData, 4200);
    const modal = await openModalAndPickPix(page, PIX_SERVER, seededData.slug, gift.nome);

    // (b) OUR identity form — not a Stripe iframe.
    await expect(modal.getByRole('heading', { name: 'de quem vem esse carinho?' })).toBeVisible();
    await expect(modal.locator('iframe')).toHaveCount(0);

    // (c) Empty submit → inline role=alert errors, no network call.
    await modal.getByRole('button', { name: 'continuar para o pix ♡' }).click();
    await expect(
      modal.getByRole('alert').filter({ hasText: 'conta pra gente quem você é ♡' }),
    ).toBeVisible();
    await expect(
      modal.getByRole('alert').filter({ hasText: 'precisamos de um email válido ♡' }),
    ).toBeVisible();

    // Fill nome/email/recadinho and submit for real.
    await modal.getByPlaceholder('Ana & João').fill('E2e Visitante Pix');
    await modal.getByPlaceholder('ana@email.com').fill('e2e-pix-visitor@e2e.local');
    await modal.getByPlaceholder('a gente já te ama tanto ♡').fill('um recadinho de teste ♡');

    const initiationPromise = page.waitForResponse(
      (res) =>
        res.url().includes('iniciarPagamentoContribuicao') && res.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: 'continuar para o pix ♡' }).click();

    // The mutation resolved through the PIX-cobrança branch: 2xx + the
    // pix_qr union arm carrying the fake provider's BR Code. (Wire-level
    // assert — the scannable QR screen itself is unreachable today, see
    // FINDING #2 in the header.)
    const initiation = await initiationPromise;
    expect(initiation.status(), 'iniciarPagamentoContribuicao should 2xx').toBeGreaterThanOrEqual(
      200,
    );
    expect(initiation.status()).toBeLessThan(300);
    const body = await initiation.text();
    expect(body, 'mutation must return the pix_qr arm, not stripe_embedded').toContain('"pix_qr"');
    expect(body, `fake provider BR Code must ride the response`).toContain(FAKE_BR_CODE_PREFIX);

    // With the composition root's real clock, the charge is born live —
    // the scannable QR screen renders (never Stripe, never the expired
    // panel on mount).
    await expect(
      modal.locator('canvas[role="img"][aria-label="QR code do pagamento pix"]'),
    ).toBeVisible();
    await expect(modal.locator('iframe')).toHaveCount(0);
  });

  test('QR screen renders scannable state and the copy button flips to copiado', async ({
    page,
    context,
    seededData,
  }) => {
    // Chromium headless denies clipboard by default — grant BEFORE the
    // copy click or writeText rejects silently (playwright-gotchas #2).
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // NON-magic price — the charge stays 'ativa' so the scannable state
    // holds still for the assertions (see the happy-path test's note).
    const gift = await seedMagicGift(seededData, 4200);
    const modal = await openModalAndPickPix(page, PIX_SERVER, seededData.slug, gift.nome);

    await modal.getByPlaceholder('Ana & João').fill('E2e Visitante Pix');
    await modal.getByPlaceholder('ana@email.com').fill('e2e-pix-visitor@e2e.local');
    await modal.getByPlaceholder('a gente já te ama tanto ♡').fill('um recadinho de teste ♡');
    await modal.getByRole('button', { name: 'continuar para o pix ♡' }).click();

    // (c) QR screen: client-rendered canvas, non-empty copia-e-cola with
    // the fake prefix, live countdown.
    await expect(
      modal.locator('canvas[role="img"][aria-label="QR code do pagamento pix"]'),
    ).toBeVisible();
    const copiaECola = modal.getByLabel('código pix copia e cola');
    await expect(copiaECola).toHaveValue(new RegExp(`^${FAKE_BR_CODE_PREFIX}`));
    await expect(modal.getByText('expira em')).toBeVisible();

    // (d) Copy button flips its label.
    await modal.getByRole('button', { name: 'copiar', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'copiado ♡' })).toBeVisible();
  });

  test('magic 1337-cent charge auto-confirms — the poll flips the panel to the success state', async ({
    page,
    seededData,
  }) => {
    // MAGIC total: the fake matches criarCobranca's amountCents — which is
    // the aggregate totalPaidCents = contribution + platform fee (5% / 500
    // bps on eunenem presentes, REGRAS_TAXA_SEED, Math.ceil —
    // calculo-taxa.ts:52). Seed the GIFT at 1273 so the CHARGE lands
    // exactly on 1337: 1273 + ceil(63.65) = 1337. Then the FIRST consult
    // reports 'concluida' and the panel flips within one poll cycle. No
    // scannable-state assertions here — that surface is covered by the
    // non-magic test above precisely because this flip is instant.
    const gift = await seedMagicGift(seededData, 1273);
    const modal = await openModalAndPickPix(page, PIX_SERVER, seededData.slug, gift.nome);

    await modal.getByPlaceholder('Ana & João').fill('E2e Visitante Pix');
    await modal.getByPlaceholder('ana@email.com').fill('e2e-pix-visitor@e2e.local');
    await modal.getByPlaceholder('a gente já te ama tanto ♡').fill('um recadinho de teste ♡');
    await modal.getByRole('button', { name: 'continuar para o pix ♡' }).click();

    await expect(modal.getByText('recebemos seu carinho ♡')).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe('kuw0o — flag gate (:3002, default stripe provider)', () => {
  test('with COBRANCA_PIX_PROVIDER unset, the PIX pick does NOT show our identity form', async ({
    page,
    seededData,
  }) => {
    // seededData already seeds one available gift; baseURL-relative walk is
    // impossible here because the shared helper takes an absolute origin —
    // :3002 is the suite's default baseURL made explicit.
    const initiationPromise = page.waitForResponse(
      (res) =>
        res.url().includes('iniciarPagamentoContribuicao') && res.request().method() === 'POST',
    );
    const modal = await openModalAndPickPix(
      page,
      'http://localhost:3002',
      seededData.slug,
      seededData.nomeContribuicao,
    );

    // pixViaQr=false → Continuar fires the mutation DIRECTLY (no identity
    // detour) and the response carries the stripe_embedded arm.
    const initiation = await initiationPromise;
    expect(initiation.status()).toBeGreaterThanOrEqual(200);
    expect(initiation.status()).toBeLessThan(300);
    expect(await initiation.text()).toContain('"stripe_embedded"');

    // The metodo step is gone (phase flipped to the stripe step) and our
    // identity form never rendered.
    await expect(modal.getByRole('button', { name: 'Continuar →' })).toBeHidden();
    await expect(modal.getByRole('heading', { name: 'de quem vem esse carinho?' })).toHaveCount(0);
  });
});
