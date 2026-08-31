/**
 * aperture-ohum1 — the guest-view "Personalizar" panel is PALETTE-ONLY.
 *
 * Operator report (staging screenshot): "Ver como convidado" → "Personalizar"
 * opened a tweaks panel that edited Nome do bebê, Papais and Data prevista
 * alongside the Paleta. Event identity must NOT be editable from a guest-view
 * theming panel — those fields live in the owner settings flow
 * (/painel/:slug/perfil, PerfilBody).
 *
 * This spec pins three things:
 *   1. The panel on /pagina/:slug (owner-visible) shows ONLY palette
 *      controls — no identity inputs at all.
 *   2. A palette save works from the scoped panel.
 *   3. The painel Perfil form remains the identity edit surface — including
 *      the "papais" field that MOVED there (TweaksPanel was its only edit
 *      path before) — and a Perfil save does NOT clobber the palette save
 *      (the old tweaks.* echo reset saved colors to the demo defaults).
 */
import { expect, test } from './fixtures.js';

test.describe('Personalizar (guest view) — palette only (aperture-ohum1)', () => {
  test('panel shows palette only; identity edits live in painel Perfil and do not clobber the palette', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    // ── 1. Guest view as the owner: open the Personalizar panel ──
    await page.goto(`/pagina/${seededData.slug}`);
    const toggle = page.getByRole('button', { name: 'Personalizar' });
    await expect(toggle).toBeVisible();
    await toggle.click();

    const panel = page.getByRole('dialog', { name: 'Personalizar página' });
    await expect(panel).toBeVisible();

    // Palette controls present.
    await expect(panel.getByText('Paleta')).toBeVisible();
    await expect(panel.getByText('Primária')).toBeVisible();
    await expect(panel.getByText('Acento')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Salvar' })).toBeVisible();

    // Identity fields ABSENT — by label and structurally (the palette is
    // swatch buttons; a panel with zero inputs cannot edit text/dates).
    await expect(panel.getByText('Evento')).toHaveCount(0);
    await expect(panel.getByText('Nome do bebê')).toHaveCount(0);
    await expect(panel.getByText('Papais')).toHaveCount(0);
    await expect(panel.getByText('Data prevista')).toHaveCount(0);
    await expect(panel.locator('input, textarea, select')).toHaveCount(0);

    await page.screenshot({ path: '/tmp/ohum1-panel.png' });

    // ── 2. Palette save works from the scoped panel ──
    await panel.getByRole('button', { name: /^Primária: #9CD7DD/ }).click();
    await panel.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Personalização salva ♡')).toBeVisible();

    // ── 3. Painel Perfil form: identity fields editable, incl. papais ──
    await page.goto(`/painel/${seededData.slug}/perfil`);
    const babyInput = page.locator('#perfil-baby');
    const papaisInput = page.locator('#perfil-papais');
    const teaInput = page.locator('#perfil-tea');
    await expect(babyInput).toBeVisible();
    await expect(papaisInput).toBeVisible();
    await expect(teaInput).toBeVisible();

    await babyInput.fill('Helena E2E');
    await papaisInput.fill('Mari & Rodrigo E2E');
    await page.getByRole('button', { name: /salvar alterações/i }).click();
    await expect(page.getByText('Tudo salvo! Feito com carinho ♡')).toBeVisible();

    // Persisted: reload and the values survive.
    await page.reload();
    await expect(babyInput).toHaveValue('Helena E2E');
    await expect(papaisInput).toHaveValue('Mari & Rodrigo E2E');

    // ── 4. The Perfil save did NOT clobber the palette save ──
    // (Regression guard: the old echo sent never-hydrated TweaksContext
    // defaults, silently resetting corPrimaria/corAcento on every save.)
    await page.goto(`/pagina/${seededData.slug}`);
    await page.getByRole('button', { name: 'Personalizar' }).click();
    await expect(
      page.getByRole('button', { name: 'Primária: #9CD7DD (selecionado)' }),
    ).toBeVisible();
  });
});
