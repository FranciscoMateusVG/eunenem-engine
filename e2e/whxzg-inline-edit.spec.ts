/**
 * aperture-whxzg — owner inline editing on the public gift page + any-colour
 * palette.
 *
 * Operator request (2026-09-14 screenshots): edit the page IN PLACE through
 * contextual icons instead of the "editar meu perfil" detour, and pick ANY
 * colour (presets + native picker + hex) for primária/acento.
 *
 * Pins, on the real production composition (Hono SSR + hydrated React):
 *   1. OWNER: contextual edit icons render on hero title / cover / polaroid /
 *      story text / story photo, are ≥44px targets, and clicking one opens
 *      the Personalizar panel FOCUSED on the matching input.
 *   2. Edits preview instantly (story text, baby name); Salvar persists and
 *      a reload matches; Cancelar discards the unsaved text/colour draft.
 *   3. Custom hex → the page CSS vars update; invalid hex never reaches CSS;
 *      the saved custom colour survives a reload.
 *   4. Photo persistence is DISCLOSED before the picker and Cancelar never
 *      claims to undo photos (GLaDOS/Izzy contract 2026-09-14).
 *   5. GUEST (fresh signed-out context): zero edit controls, no panel.
 *   6. MOBILE 390px: icons stay ≥44px inside the viewport; the panel becomes
 *      a full-width sheet that fits the viewport; Escape closes it.
 *
 * Not covered here (needs object storage): the actual photo upload PUT. The
 * persist-payload discipline for uploads is pinned at source level in
 * tests/unit/server/whxzg-inline-edit.test.ts.
 */
import { expect, type Page, test } from './fixtures.js';

const cssVar = (page: Page, name: string) =>
  page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toUpperCase(),
    name,
  );

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');

const EDIT_FIELDS = ['nomeBebe', 'fotoCapa', 'fotoPerfil', 'historia', 'fotoHistoria'] as const;

test.describe('Owner inline editing on /pagina/:slug (aperture-whxzg)', () => {
  test('icons → focused field, instant preview, save/reload, cancel, custom hex', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    await page.goto(`/pagina/${seededData.slug}`);
    await expect(page.getByTestId('pagina-baby-name')).toBeVisible();

    // ── 1. Every contextual icon exists, is labelled, and is a ≥44px target ──
    for (const field of EDIT_FIELDS) {
      const icon = page.getByTestId(`edit-${field}`);
      await expect(icon, field).toBeVisible();
      await expect(icon).toHaveAttribute('aria-label', /Editar|Trocar/);
      const box = await icon.boundingBox();
      expect(box, `${field} boundingBox`).not.toBeNull();
      expect(box?.width ?? 0, `${field} width`).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0, `${field} height`).toBeGreaterThanOrEqual(44);
    }
    // The panel is closed until an icon (or the pill) opens it.
    await expect(page.getByRole('dialog', { name: 'Personalizar página' })).toHaveCount(0);

    // ── Story icon → panel opens focused on the história textarea ──
    await page.getByTestId('edit-historia').click();
    const panel = page.getByRole('dialog', { name: 'Personalizar página' });
    await expect(panel).toBeVisible();
    await expect.poll(() => activeId(page)).toBe('tweaks-historia');

    // Instant preview: typing in the panel changes the page's Story section.
    const storyText = 'nossa história inline E2E ♡';
    await page.locator('#tweaks-historia').fill(storyText);
    await expect(page.locator('main').getByText(storyText)).toBeVisible();
    await expect(panel).toHaveAttribute('data-dirty', 'true');

    // ── 4. Photo disclosure BEFORE the picker; Cancelar never claims photo undo ──
    await expect(panel.getByTestId('capa-disclosure')).toHaveText(/foto salva na hora do envio/);
    await expect(panel.getByTestId('perfil-disclosure')).toHaveText(/foto salva na hora do envio/);
    await expect(panel.getByTestId('historia-disclosure')).toHaveText(
      /foto salva na hora do envio/,
    );
    await expect(panel.getByText(/fotos enviadas já estão salvas/)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Cancelar', exact: true })).toHaveAttribute(
      'title',
      /descarta só o texto e as cores não salvos/,
    );
    // Photo dropzones are keyboard-reachable focus targets with the field ids.
    for (const id of ['tweaks-foto-capa', 'tweaks-foto-perfil', 'tweaks-foto-historia']) {
      await expect(panel.locator(`#${id}`)).toHaveAttribute('role', 'button');
      await expect(panel.locator(`#${id}`)).toHaveAttribute('tabindex', '0');
    }

    // ── 2. Salvar persists; reload matches ──
    await panel.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.getByText('Personalização salva ♡')).toBeVisible();
    await expect(panel).toHaveAttribute('data-dirty', 'false');
    await page.reload();
    await expect(page.locator('main').getByText(storyText)).toBeVisible();

    // ── Title icon → focus on the nome input; Cancelar discards the draft ──
    await page.getByTestId('edit-nomeBebe').click();
    await expect.poll(() => activeId(page)).toBe('tweaks-nome-bebe');
    const nameBefore = (await page.getByTestId('pagina-baby-name').textContent()) ?? '';
    await page.locator('#tweaks-nome-bebe').fill('Helena Rascunho');
    await expect(page.getByTestId('pagina-baby-name')).toHaveText('Helena Rascunho');
    await page
      .getByRole('dialog', { name: 'Personalizar página' })
      .getByRole('button', { name: 'Cancelar', exact: true })
      .click();
    await expect(page.getByTestId('pagina-baby-name')).toHaveText(nameBefore);
    await expect(page.getByRole('dialog', { name: 'Personalizar página' })).toHaveAttribute(
      'data-dirty',
      'false',
    );

    // ── 3. Any colour: hex text → CSS var; invalid never applied; persists ──
    const panel2 = page.getByRole('dialog', { name: 'Personalizar página' });
    const primaryHex = panel2.getByLabel('Primária: código hex');
    await primaryHex.fill('#2E7D32');
    await expect.poll(() => cssVar(page, '--lilac')).toBe('#2E7D32');
    // deep/soft companions derived (not the lilac preset's)
    expect(await cssVar(page, '--lilac-deep')).not.toBe('#A77BBE');
    // invalid text → var unchanged + inline hint
    await primaryHex.fill('zzz');
    await expect(panel2.getByText('use um hex como #C9A5D8')).toBeVisible();
    expect(await cssVar(page, '--lilac')).toBe('#2E7D32');
    await primaryHex.fill('#2E7D32');
    // native colour input mirrors the applied value
    await expect(panel2.getByLabel('Primária: escolher qualquer cor')).toHaveValue('#2e7d32');
    const accentHex = panel2.getByLabel('Acento: código hex');
    await accentHex.fill('880e4f');
    await expect.poll(() => cssVar(page, '--coral-pink')).toBe('#880E4F');
    // preset swatch still works on top of a custom value
    await panel2.getByRole('button', { name: /^Acento: #F7D560/ }).click();
    await expect.poll(() => cssVar(page, '--coral-pink')).toBe('#F7D560');
    await accentHex.fill('#880E4F');

    await panel2.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.getByText('Personalização salva ♡')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('pagina-baby-name')).toBeVisible();
    await expect.poll(() => cssVar(page, '--lilac')).toBe('#2E7D32');
    await expect.poll(() => cssVar(page, '--coral-pink')).toBe('#880E4F');
    await page.getByRole('button', { name: 'Personalizar' }).click();
    await expect(page.getByLabel('Primária: código hex')).toHaveValue('#2E7D32');
  });

  test('guest (signed-out) sees no edit controls and no panel', async ({ browser, seededData }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`/pagina/${seededData.slug}`);
      await expect(page.getByTestId('pagina-baby-name')).toBeVisible();
      for (const field of EDIT_FIELDS) {
        await expect(page.getByTestId(`edit-${field}`)).toHaveCount(0);
      }
      await expect(page.locator('.eu-edit-btn')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Personalizar/ })).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Personalizar página' })).toHaveCount(0);
      // No owner-only data in the guest DOM either.
      await expect(page.locator('#tweaks-historia')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('mobile 390px — icons stay tappable in-viewport, panel is a full-width sheet, Escape closes', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/pagina/${seededData.slug}`);
    await expect(page.getByTestId('pagina-baby-name')).toBeVisible();

    for (const field of EDIT_FIELDS) {
      const icon = page.getByTestId(`edit-${field}`);
      await icon.scrollIntoViewIfNeeded();
      const box = await icon.boundingBox();
      expect(box, field).not.toBeNull();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.x ?? -1, `${field} x`).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0), `${field} right edge`).toBeLessThanOrEqual(390);
    }

    await page.getByTestId('edit-historia').click();
    const panel = page.getByRole('dialog', { name: 'Personalizar página' });
    await expect(panel).toBeVisible();
    await expect.poll(() => activeId(page)).toBe('tweaks-historia');
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(box?.width ?? 0).toBeGreaterThan(300);
    // Salvar / Cancelar are ≥44px tall on touch.
    const save = await panel.getByRole('button', { name: 'Salvar', exact: true }).boundingBox();
    expect(save?.height ?? 0).toBeGreaterThanOrEqual(44);

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });
});
