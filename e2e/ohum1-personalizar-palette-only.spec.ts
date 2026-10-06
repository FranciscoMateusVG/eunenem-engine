/**
 * aperture-ohum1 — the guest-view "Personalizar" panel must never edit EVENT
 * identity (event type / dates) and a painel Perfil save must not clobber a
 * palette save.
 *
 * History: ohum1 originally pinned the panel as PALETTE-ONLY (zero inputs).
 * aperture-whxzg (operator request 2026-09-14) SUPERSEDES that half: the
 * panel is now the OWNER's inline editor for the supported public-page
 * fields (nome do bebê, história, assinatura, fotos, paleta) — it only mounts
 * for the owner (getPerfilPublicoBySlug.isOwner), so it is no longer a
 * "guest-view theming toy". What ohum1 still guards, unchanged:
 *   1. Event identity (Evento / Data prevista / tipo) is NOT editable here —
 *      those stay in the painel Perfil form (single source: eventos row).
 *   2. A palette save works from the panel.
 *   3. The painel Perfil form remains an identity edit surface (incl. papais)
 *      and a Perfil save does NOT clobber the palette save (the old tweaks.*
 *      echo reset saved colors to the demo defaults).
 */
import { expect, test } from './fixtures.js';

test.describe('Personalizar (owner view) — no event identity; palette survives Perfil save (aperture-ohum1)', () => {
  test('panel has no event/date fields; palette save works; painel Perfil save does not clobber it', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    // ── 1. Owner on their own page: open the Personalizar panel ──
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
    await expect(panel.getByRole('button', { name: 'Salvar', exact: true })).toBeVisible();

    // EVENT identity ABSENT — no event-type select, no date inputs (those live
    // in painel Perfil; the evento row is the single source). aperture-whxzg
    // added text/photo/colour inputs on purpose, so the old "zero inputs"
    // assertion is retired; we pin the specific shapes that must stay out.
    await expect(panel.getByText('Evento')).toHaveCount(0);
    await expect(panel.getByText('Data prevista')).toHaveCount(0);
    await expect(panel.locator('select')).toHaveCount(0);
    await expect(panel.locator('input[type="date"]')).toHaveCount(0);
    await expect(panel.locator('#perfil-tea, #perfil-nascimento, #perfil-evento')).toHaveCount(0);

    await page.screenshot({ path: '/tmp/ohum1-panel.png' });

    // ── 2. Palette save works from the panel ──
    await panel.getByRole('button', { name: /^Primária: #9CD7DD/ }).click();
    await panel.getByRole('button', { name: 'Salvar', exact: true }).click();
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
    // …and the painel edits are what the owner editor now shows (one store).
    await expect(page.locator('#tweaks-nome-bebe')).toHaveValue('Helena E2E');
    await expect(page.locator('#tweaks-papais')).toHaveValue('Mari & Rodrigo E2E');
  });
});
