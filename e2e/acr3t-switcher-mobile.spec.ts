/**
 * Topbar "ir para / minhas listas" switcher — mobile popover gate (aperture-acr3t).
 *
 * THE BUG: below the 900px breakpoint `.painel-topbar-nav` becomes a
 * horizontal scroll strip (`overflow-x: auto`). Per the CSS spec, a used
 * `overflow-x` of `auto` forces `overflow-y` to compute to `auto` as well,
 * so the nav became a clipping scroll container in BOTH axes — and the
 * switcher's absolutely-positioned dropdown, a descendant of the nav,
 * was clipped into invisibility. Tap toggled `open` fine; the menu just
 * painted into nothing. Desktop (≥900px) sets `overflow-x: visible`,
 * which is why the bug was mobile-only.
 *
 * THE FIX: portal the menu to <body> with position:fixed coords anchored
 * to the trigger (the repo's established idiom — see PresentesBody's
 * FilterButton, aperture-sm7uc), so no ancestor overflow/mask can clip it.
 *
 * ASSERTION DISCIPLINE: `toBeVisible()` is NOT enough here — an
 * overflow-clipped element still has a bounding box and computed
 * visibility, so it resolves "visible" while painting nothing (paint
 * ignores clips in that API; hit-testing honors them — playwright-gotchas
 * #5). The load-bearing assertion is `document.elementFromPoint` at the
 * menu's center returning a node INSIDE the menu: that's real-user
 * visibility AND tappability in one probe.
 */
import { expect, test } from './fixtures.js';

const MOBILE_VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Hit-test probe: does `document.elementFromPoint` at the center of the
 * menu land inside the menu? Catches ancestor-overflow clipping that
 * `toBeVisible()` cannot see.
 */
async function menuIsHitTestable(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const menu = document.querySelector('.painel-switcher-menu');
    if (!menu) return false;
    const r = menu.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
    return hit !== null && menu.contains(hit);
  });
}

/** Wait for the entry animation (painel-switcher-floatin, 0.16s) to settle. */
async function settleMenu(page: import('@playwright/test').Page): Promise<void> {
  await page
    .waitForFunction(() => {
      const menu = document.querySelector('.painel-switcher-menu');
      if (!menu) return false;
      return (
        getComputedStyle(menu).animationName === 'none' ||
        (menu as HTMLElement).getAnimations().every((a) => a.playState === 'finished')
      );
    })
    .catch(() => undefined);
}

async function openAndAssertSwitcher(page: import('@playwright/test').Page, slug: string) {
  await page.goto(`/painel/${slug}/lista`);

  const trigger = page.getByTestId('topbar-switcher');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const menu = page.locator('.painel-switcher-menu');
  await expect(menu).toBeVisible();
  await settleMenu(page);

  // The three sections: head, at least one campanha entry, footer link.
  await expect(menu.getByText('acessar uma lista', { exact: false })).toBeVisible();
  await expect(page.getByTestId('switcher-item').first()).toBeVisible();
  await expect(page.getByTestId('switcher-ver-todas')).toBeVisible();

  // Load-bearing: the menu must win hit-testing at its own center —
  // overflow-clipped or pointer-events-dead menus fail HERE, not above.
  expect(
    await menuIsHitTestable(page),
    'switcher menu must be genuinely painted + tappable (not overflow-clipped)',
  ).toBe(true);

  // The menu must sit inside the viewport horizontally (a 288px panel
  // anchored naively could hang off-screen at 375px).
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) {
    throw new Error('menu bounding box and viewport size must both exist');
  }
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
}

test.describe('Topbar campanha switcher — opens on mobile (aperture-acr3t)', () => {
  for (const vp of MOBILE_VIEWPORTS) {
    test(`opens with all three sections at ${vp.width}px`, async ({
      authenticatedPage: page,
      seededData,
    }) => {
      await page.setViewportSize(vp);
      await openAndAssertSwitcher(page, seededData.slug);
    });
  }

  test(`still opens on desktop (${DESKTOP_VIEWPORT.width}px)`, async ({
    authenticatedPage: page,
    seededData,
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await openAndAssertSwitcher(page, seededData.slug);
  });

  test('closes on outside tap (portal keeps outside-close contract)', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORTS[0]);
    await page.goto(`/painel/${seededData.slug}/lista`);

    const trigger = page.getByTestId('topbar-switcher');
    await trigger.click();
    const menu = page.locator('.painel-switcher-menu');
    await expect(menu).toBeVisible();

    // Tap well below the menu (portal must still close on outside pointerdown).
    await page.mouse.click(200, 600);
    await expect(menu).toHaveCount(0);
  });
});
