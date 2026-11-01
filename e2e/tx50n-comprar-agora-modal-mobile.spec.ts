/**
 * aperture-tx50n — the "ou comprar agora" GiftCheckoutModal on mobile.
 *
 * Operator report (01/11): at phone widths the PIX / Cartão option rows were
 * wider than the modal — "aprovado em segundos" and the card-brand list were
 * cut off, and "na hora ♡" / "+R$ 5,76 taxa cartão" wrapped over several
 * lines. Asserted at 320 and 375: no element of the modal sticks out of it,
 * the page has no horizontal scroll, and the price/micro lines are one line.
 * 1280 is checked for the same containment (no desktop regression).
 * Pure layout: nothing here initiates a payment.
 */
import { randomUUID } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedAvailableGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

/** Descendants whose box leaves the container's box (horizontally). */
async function horizontalOverflow(container: Locator): Promise<string[]> {
  return container.evaluate((el) => {
    const outer = el.getBoundingClientRect();
    const bad: string[] = [];
    for (const child of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      const r = child.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < outer.left - 0.5 || r.right > outer.right + 0.5) {
        bad.push(
          `${child.className || child.tagName}:${(child.textContent ?? '').trim().slice(0, 30)}`,
        );
      }
    }
    return bad;
  });
}

async function lineCount(target: Locator): Promise<number> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el);
    const lh = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    return Math.round(el.getBoundingClientRect().height / lh);
  });
}

for (const width of [320, 375, 1280] as const) {
  test(`tx50n — comprar agora modal fits at ${width}px`, async ({ page, seededData }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 760 });
    // Long name + a price with a visible card surcharge, as in the report.
    const nome = `Mobile Animal Musical - Zoop Toys ${randomUUID().slice(0, 6)}`;
    const db = createDatabase(DATABASE_URL);
    try {
      await seedAvailableGift(buildSeedGiftRepos(db), { ...seededData, nome, valorCents: 13190 });
    } finally {
      await db.destroy();
    }

    await page.goto(`/pagina/${seededData.slug}`);
    const card = page.locator('article').filter({ hasText: nome });
    await card.getByRole('button', { name: /\+ Adicionar/i }).click();
    const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
    await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
    await expect(drawer).toBeHidden();
    await card.getByRole('button', { name: /ou comprar agora/ }).click();

    const modal = page.locator('[role="dialog"][aria-labelledby="gift-checkout-title"]');
    await expect(modal).toBeVisible();
    const pix = modal.getByRole('radio', { name: /^Pix/ });
    const cartao = modal.getByRole('radio', { name: /^Cartão/ });
    await expect(pix).toBeVisible();
    await expect(cartao).toBeVisible();

    expect(await horizontalOverflow(modal), 'modal content overflows').toEqual([]);
    const scroll = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(scroll.scroll, 'page scrolls horizontally').toBeLessThanOrEqual(scroll.inner);

    for (const option of [pix, cartao]) {
      expect(await lineCount(option.locator('.metodo-card-price'))).toBe(1);
      expect(await lineCount(option.locator('.metodo-card-micro'))).toBe(1);
    }
  });
}
