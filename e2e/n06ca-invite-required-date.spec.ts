/**
 * aperture-n06ca — invite date/time are MANDATORY, not optional.
 *
 * Operator report (eunenem staging screenshot): wizard step 4 ("quando e
 * onde?") bannered "data e hora são opcionais — você pode preencher depois"
 * and labeled the fields "data (opcional)" / "horário (opcional)". People
 * shipped invites with no date. Decision: date + hour are required.
 *
 * Enforcement layers under test:
 *   1. UI copy — the optional banner and "(opcional)" labels are GONE from
 *      the quando step;
 *   2. step gate — "próximo passo" on quando blocks with inline PT-BR
 *      errors (conviteFieldErrors: date/time joined babyName/host) until
 *      both fields are filled;
 *   3. draft re-entry — a legacy draft saved with no date re-enters the
 *      wizard normally and is blocked at the same gate (covered implicitly:
 *      the fresh account hydrates date=''/time='', the exact same state a
 *      null-dataHoraIso draft rehydrates to via conviteStateFromData).
 *
 * The backend layer (SaveEventoConviteInputSchema rejecting null and the
 * ":01 seconds" no-time sentinel) is pinned in
 * tests/unit/server/mu1v9-date-unify.test.ts and
 * tests/integration/eunenem-server-evento-convite-router-auth.test.ts.
 */

import { expect, test } from './fixtures';

// Inline error copy (ConviteBody.conviteFieldErrors).
const ERR_DATE = 'escolha a data do evento ♡';
const ERR_TIME = 'escolha o horário do evento ♡';

test.describe('aperture-n06ca — quando e onde requires date + hour', () => {
  test('step 4 blocks proceeding without date/hour, proceeds once filled', async ({
    authenticatedPage: page,
    seededData,
  }, testInfo) => {
    // No networkidle: the wizard streams template thumbnails + keeps live
    // queries, so idle never settles — wait for the wizard shell instead.
    await page.goto(`/painel/${seededData.slug}/convite`);
    await expect(page.locator('.cv-wiz-step-title')).toBeVisible();

    const next = page.getByRole('button', { name: 'próximo passo' });

    // Step 1 (fundo) and step 2 (tipo) have no required fields.
    await expect(page.locator('.cv-wiz-step-title')).toHaveText('fundo do convite');
    await next.click();
    await expect(page.locator('.cv-wiz-step-title')).toHaveText('qual tipo de evento?');
    await next.click();

    // Step 3 (quem) — fill its required fields so we can advance.
    await page.getByPlaceholder('Maria Helena').fill('Aurora');
    await page.getByPlaceholder('Mariana & Tiago').fill('Ana & João');
    await next.click();

    // Step 4 (quando e onde?) — the optionality copy must be gone.
    await expect(page.locator('.cv-wiz-step-title')).toHaveText('quando e onde?');
    await expect(page.getByText('opcional')).toHaveCount(0);
    await expect(page.getByText('você pode preencher depois')).toHaveCount(0);

    // Attempt to proceed with EMPTY date + hour → blocked, inline errors.
    await next.click();
    await expect(page.locator('.cv-wiz-step-title')).toHaveText('quando e onde?');
    await expect(page.getByRole('alert').filter({ hasText: ERR_DATE })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: ERR_TIME })).toBeVisible();
    await expect(page.locator('#cv-date')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#cv-time')).toHaveAttribute('aria-invalid', 'true');
    await page.screenshot({ path: testInfo.outputPath('n06ca-validation.png') });

    // Fill the date only — still blocked on the hour.
    await page.locator('#cv-date').fill('2027-03-20');
    await expect(page.getByRole('alert').filter({ hasText: ERR_DATE })).toHaveCount(0);
    await next.click();
    await expect(page.locator('.cv-wiz-step-title')).toHaveText('quando e onde?');
    await expect(page.getByRole('alert').filter({ hasText: ERR_TIME })).toBeVisible();

    // Fill the hour too → the gate opens and the wizard advances.
    await page.locator('#cv-time').fill('15:30');
    await expect(page.getByRole('alert').filter({ hasText: ERR_TIME })).toHaveCount(0);
    await next.click();
    await expect(page.locator('.cv-wiz-step-title')).toHaveText('a cara do convite');
  });

  test('salvar rascunho with empty date/hour jumps back to the quando step blocked', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    // No networkidle: the wizard streams template thumbnails + keeps live
    // queries, so idle never settles — wait for the wizard shell instead.
    await page.goto(`/painel/${seededData.slug}/convite`);
    await expect(page.locator('.cv-wiz-step-title')).toBeVisible();

    // Fill only the quem fields, leave date/hour empty, then hit "salvar"
    // from the topbar (guardComplete path — same guard the final "enviar
    // convite" uses).
    const next = page.getByRole('button', { name: 'próximo passo' });
    await next.click(); // fundo → tipo
    await next.click(); // tipo → quem
    await page.getByPlaceholder('Maria Helena').fill('Aurora');
    await page.getByPlaceholder('Mariana & Tiago').fill('Ana & João');

    await page.getByRole('button', { name: 'salvar rascunho' }).click();

    // guardComplete jumps to the first offending step (quando) and surfaces
    // the inline errors — nothing is persisted.
    await expect(page.locator('.cv-wiz-step-title')).toHaveText('quando e onde?');
    await expect(page.getByText('faltou preencher alguns campos ♡')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: ERR_DATE })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: ERR_TIME })).toBeVisible();
  });
});
