/**
 * aperture-w7v66 — public gift cards on mobile (2-column grid).
 *
 * Operator report (01/11): at phone widths the "✓ Presenteado" tag wrapped to
 * two lines, "Já presenteado ♡" / "+ Adicionar" became fat multi-line pills,
 * the "− 1 no carrinho +" stepper pushed its + outside the card, long prices
 * cut the "presente" label, and long names made cards different heights.
 *
 * Asserted at 320 and 375: every card descendant stays inside its card, tag
 * and CTAs are one line, names clamp to 3 lines (full name kept in title),
 * every name block has the same height, and the "presente" label is hidden.
 * At 1280 the label stays and nothing overflows (no desktop regression).
 */
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedAvailableGift, seedSoldOutGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

const LONG_NAME = 'Berço Cômoda Guarda Roupa Ditália Bbi-51 Bb-120 Bb-322 Cozy';

async function seedCards(seededData: { idCampanha: string; idOpcaoPresentes: string }) {
  const tag = randomUUID().slice(0, 6);
  const names = {
    long: `${LONG_NAME} ${tag}`,
    expensive: `Cadeira MamaRoo ${tag}`,
    taken: `Jogo de lençol ${tag}`,
    inCart: `Banheira ${tag}`,
  };
  const db = createDatabase(DATABASE_URL);
  try {
    const repos = buildSeedGiftRepos(db);
    await seedAvailableGift(repos, { ...seededData, nome: names.long, valorCents: 89900 });
    await seedAvailableGift(repos, { ...seededData, nome: names.expensive, valorCents: 217852 });
    await seedSoldOutGift(repos, { ...seededData, nome: names.taken, valorCents: 1090 });
    await seedAvailableGift(repos, {
      ...seededData,
      nome: names.inCart,
      valorCents: 40323,
      quantidade: 3,
    });
  } finally {
    await db.destroy();
  }
  return names;
}

async function openPageWithCartItem(page: Page, slug: string, inCart: string) {
  await page.goto(`/pagina/${slug}`);
  const card = page.locator('article').filter({ hasText: inCart });
  await card.getByRole('button', { name: /\+ Adicionar/i }).click();
  const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
  await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
  await expect(drawer).toBeHidden();
  await expect(card.getByText(/no carrinho/)).toHaveCount(1);
}

/** Every rendered descendant's box must sit inside the card's box. */
async function overflowingChildren(card: Locator): Promise<string[]> {
  return card.evaluate((el) => {
    const outer = el.getBoundingClientRect();
    const bad: string[] = [];
    for (const child of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      const r = child.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (
        r.left < outer.left - 0.5 ||
        r.right > outer.right + 0.5 ||
        r.top < outer.top - 0.5 ||
        r.bottom > outer.bottom + 0.5
      ) {
        bad.push(`${child.tagName}:${(child.textContent ?? '').trim().slice(0, 30)}`);
      }
    }
    return bad;
  });
}

/** Rendered line count of an element's text (content-box height / line-height). */
async function lineCount(target: Locator): Promise<number> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el);
    const lh = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    const box = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'] as const;
    const chrome = box.reduce((sum, k) => sum + Number.parseFloat(style[k]), 0);
    return Math.round((el.getBoundingClientRect().height - chrome) / lh);
  });
}

for (const width of [320, 375] as const) {
  test(`w7v66 — mobile ${width}px: gift cards stay compact, one-line and inside the card`, async ({
    page,
    seededData,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const names = await seedCards(seededData);
    await openPageWithCartItem(page, seededData.slug, names.inCart);

    const cards = page.locator('article[data-testid="pagina-gift-item"]');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      expect(await overflowingChildren(card), `card ${i} overflows`).toEqual([]);
      // "presente" label next to the price is hidden on mobile.
      await expect(card.getByText('presente', { exact: true })).toBeHidden();
      // Names clamp to at most 3 lines.
      expect(await lineCount(card.locator('h3'))).toBeLessThanOrEqual(3);
    }

    // Uniform name block across the grid: a long name no longer makes its
    // card (and its whole row) taller than the rest.
    const heights = await cards
      .locator('h3')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(new Set(heights).size, `heights: ${heights.join(',')}`).toBe(1);

    // Long name: clamped visually, full text still available.
    const long = cards.filter({ has: page.locator(`h3[title="${names.long}"]`) });
    await expect(long).toHaveCount(1);

    // Tag + CTAs are single line.
    const taken = cards.filter({ hasText: names.taken });
    const tag = taken.getByText(/presenteado/i).first();
    expect(await lineCount(tag)).toBe(1);
    const takenCta = taken.getByRole('button', { name: /presenteado/i });
    expect(await lineCount(takenCta)).toBe(1);

    const addCta = cards
      .filter({ hasText: names.expensive })
      .getByRole('button', { name: /Adicionar/ });
    expect(await lineCount(addCta)).toBe(1);

    // Stepper: + and − both inside the card and clickable.
    const inCart = cards.filter({ hasText: names.inCart });
    await inCart.getByRole('button', { name: `Aumentar ${names.inCart}` }).click();
    await expect(inCart.getByText(/^2/)).toBeVisible();
  });
}

test('w7v66 — desktop 1280: price label kept, nothing overflows', async ({ page, seededData }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const names = await seedCards(seededData);
  await openPageWithCartItem(page, seededData.slug, names.inCart);
  const cards = page.locator('article[data-testid="pagina-gift-item"]');
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    expect(await overflowingChildren(cards.nth(i)), `card ${i} overflows`).toEqual([]);
  }
  await expect(
    cards.filter({ hasText: names.expensive }).getByText('presente', { exact: true }),
  ).toBeVisible();
  await expect(cards.filter({ hasText: names.inCart }).getByText('1 no carrinho')).toBeVisible();
});
