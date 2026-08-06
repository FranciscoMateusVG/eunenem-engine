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
  opts: { clickContinuar?: boolean } = {},
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
  if (opts.clickContinuar !== false) {
    await modal.getByRole('button', { name: 'Continuar →' }).click();
  }
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

test.describe('kuw0o — irhxi QA regressions (:3004, fake cobrança provider)', () => {
  test('BLOCKER 1 (race, loading window): fast click during config load is impossible — CTAs disabled, copy neutral, then recovery', async ({
    page,
    seededData,
  }) => {
    const gift = await seedMagicGift(seededData, 4200);

    // THE actual timing race, made deterministic. Config rides the page's
    // 4-procedure batch, so a plain route-hold would starve the gift list
    // too. Instead: fail the config ENTRY inside batch #1 (lista/mural
    // resolve normally → cards render), then HOLD the standalone retry
    // request React Query fires next. RQ keeps the query in `pending`
    // (isLoading true) through the whole retry cycle — the loading window
    // now lasts exactly as long as the assertions need, WITH the page
    // fully interactive around it.
    let releaseRetry!: () => void;
    const retryHeld = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let configRequestCount = 0;
    await page.route(/\/api\/trpc\/[^?]*obterConfigCheckout/, async (route) => {
      configRequestCount += 1;
      if (configRequestCount === 1) {
        const upstream = await route.fetch();
        const procedures = (
          new URL(route.request().url()).pathname.split('/api/trpc/')[1] ?? ''
        ).split(',');
        const configIndex = procedures.findIndex((p) => p.includes('obterConfigCheckout'));
        const json = (await upstream.json()) as unknown[];
        json[configIndex] = {
          error: {
            message: 'sabotaged by e2e (attempt 1)',
            code: -32603,
            data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
          },
        };
        await route.fulfill({ response: upstream, json });
        return;
      }
      await retryHeld;
      await route.continue();
    });

    await page.goto(`${PIX_SERVER}/pagina/${seededData.slug}`);
    const card = page.locator('article').filter({ hasText: gift.nome });
    await card.getByRole('button', { name: /\+ Adicionar/i }).click();

    // DRAWER entry point, inside the loading window: Finalizar is DISABLED
    // ('preparando checkout...') and the processor copy is NEUTRAL — no
    // Stripe claim from the false default, no premature Inter claim.
    const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
    const finalizarLoading = drawer.getByRole('button', { name: 'preparando checkout...' });
    await expect(finalizarLoading).toBeVisible();
    await expect(finalizarLoading).toBeDisabled();
    await expect(drawer.getByText('Pagamento seguro ♡', { exact: true })).toBeVisible();
    await expect(drawer.getByText(/pelo Stripe|Banco Inter/)).toHaveCount(0);

    await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
    await card.getByRole('button', { name: /ou comprar agora/ }).click();
    const modal = page.locator('[role="dialog"][aria-labelledby="gift-checkout-title"]');
    await expect(modal).toBeVisible();
    await modal.getByRole('radio', { name: /^Pix/ }).click();

    // MODAL entry point, same window: the fast click physically cannot
    // take the presumed-Stripe branch — the CTA is disabled — and the
    // copy stays neutral.
    const continuarLoading = modal.getByRole('button', { name: 'Preparando checkout...' });
    await expect(continuarLoading).toBeVisible();
    await expect(continuarLoading).toBeDisabled();
    await expect(modal.getByText('Pagamento seguro ♡', { exact: true })).toBeVisible();
    await expect(modal.getByText(/pelo Stripe|Banco Inter/)).toHaveCount(0);

    // Release the held retry → config succeeds → CTA opens, the copy
    // names the REAL rail, and the flow lands on OUR identity form.
    releaseRetry();
    await expect(modal.getByRole('button', { name: 'Continuar →' })).toBeEnabled({
      timeout: 10_000,
    });
    await expect(modal.getByText(/Pagamento via PIX pelo Banco Inter/)).toBeVisible();
    await modal.getByRole('button', { name: 'Continuar →' }).click();
    await expect(modal.getByRole('heading', { name: 'de quem vem esse carinho?' })).toBeVisible();
    await expect(modal.locator('iframe')).toHaveCount(0);
  });

  test('BLOCKER 1 (error leg): failed config fails CLOSED — PIX blocked with retry, never a silent Stripe default', async ({
    page,
    seededData,
  }) => {
    const gift = await seedMagicGift(seededData, 4200);

    // obterConfigCheckout rides a 4-procedure tRPC batch (auth.me + lista
    // + mural + config — one URL), so a naive route-hold starves the whole
    // page. Instead: forward the batch upstream and rewrite ONLY the
    // config entry to a tRPC error. Deterministic: the config query FAILS
    // (configError leg — the same `disabled` expression also covers the
    // transient isLoading leg), lista/mural render normally.
    let sabotageConfig = true;
    await page.route(/\/api\/trpc\/[^?]*obterConfigCheckout/, async (route) => {
      if (!sabotageConfig) {
        await route.continue();
        return;
      }
      const upstream = await route.fetch();
      const procedures = (
        new URL(route.request().url()).pathname.split('/api/trpc/')[1] ?? ''
      ).split(',');
      const configIndex = procedures.findIndex((p) => p.includes('obterConfigCheckout'));
      const json = (await upstream.json()) as unknown[];
      json[configIndex] = {
        error: {
          message: 'sabotaged by e2e',
          code: -32603,
          data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
        },
      };
      await route.fulfill({ response: upstream, json });
    });

    const modal = await openModalAndPickPix(page, PIX_SERVER, seededData.slug, gift.nome, {
      clickContinuar: false,
    });

    // PIX selected + config errored: CTA blocked, error surfaced with a
    // retry — NOT a silent fall-through to the Stripe branch. And the
    // processor copy stays NEUTRAL beside the error (residual 2): the
    // false pixViaQr default must never leak a Stripe claim into the UI.
    await expect(modal.getByText(/não conseguimos preparar o checkout pix/)).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Continuar →' })).toBeDisabled();
    await expect(modal.getByText('Pagamento seguro ♡', { exact: true })).toBeVisible();
    await expect(modal.getByText(/pelo Stripe|Banco Inter/)).toHaveCount(0);

    // Retry with the sabotage lifted → config lands → the flow proceeds
    // to OUR identity form; never a blank Stripe-shaped phase.
    sabotageConfig = false;
    await modal.getByRole('button', { name: 'tentar de novo' }).click();
    await expect(modal.getByRole('button', { name: 'Continuar →' })).toBeEnabled({
      timeout: 10_000,
    });
    await modal.getByRole('button', { name: 'Continuar →' }).click();
    await expect(modal.getByRole('heading', { name: 'de quem vem esse carinho?' })).toBeVisible();
    await expect(modal.locator('iframe')).toHaveCount(0);
  });

  test('BLOCKER 2: processor copy tells the truth on the Inter rail (modal + drawer)', async ({
    page,
    seededData,
  }) => {
    const gift = await seedMagicGift(seededData, 4200);
    const modal = await openModalAndPickPix(page, PIX_SERVER, seededData.slug, gift.nome);

    // Modal metodo step, PIX selected on the Inter/fake rail: Banco Inter
    // copy present, the Stripe-processor line absent.
    await expect(modal.getByRole('heading', { name: 'de quem vem esse carinho?' })).toBeVisible();
    // (copy is asserted on the metodo step — reopen it via voltar)
    await modal.getByRole('button', { name: 'voltar' }).click();
    await expect(modal.getByText(/Pagamento via PIX pelo Banco Inter/)).toBeVisible();
    await expect(modal.getByText(/Pagamento processado pelo Stripe/)).toHaveCount(0);

    // Drawer footer, same rail: Banco Inter copy, no Stripe claim. The
    // helper already added the gift to the cart — reopen the drawer via
    // the floating cart trigger (the card now shows the qty stepper).
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Abrir carrinho/ }).click();
    const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
    await expect(drawer.getByText(/Pagamento PIX seguro pelo Banco Inter/)).toBeVisible();
    await expect(drawer.getByText(/Pagamento seguro pelo Stripe/)).toHaveCount(0);
  });

  test('BLOCKER 3 (single + cart): displayed amount == charged == persisted', async ({
    page,
    seededData,
  }) => {
    // 4200-cent gift → charge = 4200 + ceil(5%) = 4410. The QR screen must
    // show the CHARGED amount from the pix_qr response — bound here against
    // the wire value AND the persisted aggregate, with zero client-side
    // fee arithmetic.
    const gift = await seedMagicGift(seededData, 4200);
    const modal = await openModalAndPickPix(page, PIX_SERVER, seededData.slug, gift.nome);

    await modal.getByPlaceholder('Ana & João').fill('E2e Visitante Pix');
    await modal.getByPlaceholder('ana@email.com').fill('e2e-pix-visitor@e2e.local');
    const initiationPromise = page.waitForResponse(
      (res) =>
        res.url().includes('iniciarPagamentoContribuicao') && res.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: 'continuar para o pix ♡' }).click();
    const initiation = await initiationPromise;
    const body = JSON.parse(await initiation.text()) as Array<{
      result?: { data?: { valorCents?: number; txid?: string } };
    }>;
    const wire = body[0]?.result?.data;
    expect(wire?.valorCents, 'pix_qr response must carry the charged amount').toBe(4410);

    // Displayed: the QR heading renders the wire amount (R$ 44,10).
    await expect(modal.getByRole('heading', { name: /paga com pix — R\$\s*44,10/ })).toBeVisible();

    // Persisted: the charge row's aggregate equals the wire amount.
    const db = createDatabase(DATABASE_URL);
    try {
      const row = await db
        .selectFrom('pagamentos')
        .select(['intencao_total_paid_cents'])
        .where('intencao_external_ref', '=', wire?.txid ?? '')
        .executeTakeFirst();
      expect(Number(row?.intencao_total_paid_cents)).toBe(4410);
    } finally {
      await db.destroy();
    }

    // CART path: same binding through the drawer flow.
    await page.goto(`${PIX_SERVER}/pagina/${seededData.slug}`);
    const card = page.locator('article').filter({ hasText: gift.nome });
    await card.getByRole('button', { name: /\+ Adicionar/i }).click();
    const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
    await expect(drawer.getByRole('button', { name: /Finalizar compra/ })).toBeEnabled();
    await drawer.getByRole('button', { name: /Finalizar compra/ }).click();
    await expect(drawer.getByRole('heading', { name: 'de quem vem esse carinho?' })).toBeVisible();
    await drawer.getByPlaceholder('Ana & João').fill('E2e Carrinho Pix');
    await drawer.getByPlaceholder('ana@email.com').fill('e2e-pix-cart@e2e.local');
    const cartInitiation = page.waitForResponse(
      (res) => res.url().includes('iniciarPagamentoCarrinho') && res.request().method() === 'POST',
    );
    await drawer.getByRole('button', { name: 'continuar para o pix ♡' }).click();
    const cartBody = JSON.parse(await (await cartInitiation).text()) as Array<{
      result?: { data?: { valorCents?: number } };
    }>;
    expect(cartBody[0]?.result?.data?.valorCents).toBe(4410);
    await expect(drawer.getByRole('heading', { name: /paga com pix — R\$\s*44,10/ })).toBeVisible();
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

  test('BLOCKER 2 negative: Stripe processor copy stays on the default rail', async ({
    page,
    seededData,
  }) => {
    const configPromise = page.waitForResponse((res) => res.url().includes('obterConfigCheckout'));
    await page.goto(`http://localhost:3002/pagina/${seededData.slug}`);
    const card = page.locator('article').filter({ hasText: seededData.nomeContribuicao });
    await card.getByRole('button', { name: /\+ Adicionar/i }).click();
    const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
    await configPromise;
    await expect(drawer.getByText(/Pagamento seguro pelo Stripe/)).toBeVisible();
    await expect(drawer.getByText(/Banco Inter/)).toHaveCount(0);
  });
});
