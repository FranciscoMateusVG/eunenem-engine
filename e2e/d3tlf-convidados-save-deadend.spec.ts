/**
 * aperture-d3tlf — regression: the "Mensagem do convite" compositor on
 * /painel/:slug/convidados must never dead-end a save on required fields
 * the panel doesn't render.
 *
 * The bug: the compositor holds the FULL ConviteState and saves the full
 * payload (savePayloadFromConviteState), but only exposed 4 inputs
 * (mensagem/endereço/data/horário). A fresh account that never completed
 * the convite wizard has host="" + babyName="" (EMPTY_STATE), so SALVAR
 * hit the backend RemetenteConvite/nomeExibido min(1) validation and
 * toasted 'Remetente do convite não pode ser vazio' — naming fields with
 * no input anywhere on the screen (operator-reported, 2026-08-05).
 *
 * The fix under test:
 *   1. texto mode renders 'nome do bebê' + 'de quem vem o convite' inputs;
 *   2. onSaveConvite pre-flights conviteFieldErrors client-side — the raw
 *      backend 400 is unreachable from this panel; errors surface inline
 *      (role=alert, mirrored from the wizard's FieldError treatment);
 *   3. convite_virtual mode with no saved convite points at the existing
 *      'Criar convite' CTA instead of an unactionable error.
 *
 * Uses `seededData`: a fresh magic-link-provisioned user whose campanha has
 * NO saved convite row — exactly the bug's precondition.
 */

import { expect, test } from './fixtures';

// Wizard-mirrored inline error copy (ConviteBody.conviteFieldErrors).
const ERR_BABY = 'preencha o nome do bebê ♡';
const ERR_HOST = 'diga de quem vem o convite ♡';
// The backend zod message that used to leak through as a dead end.
const DEADEND_BACKEND_MSG = 'Remetente do convite não pode ser vazio';

async function openCompositor(page: import('@playwright/test').Page, slug: string) {
  await page.goto(`/painel/${slug}/convidados`, { waitUntil: 'networkidle' });
  const trigger = page.locator('.cv-invite-collapse-trigger', {
    hasText: 'Mensagem do convite',
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator('.cv-invite-collapse-body')).toBeVisible();
}

test.describe('aperture-d3tlf — convidados compositor save is never a dead end', () => {
  test('texto mode: blocked save surfaces inline fixable errors, then saves once filled', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    await openCompositor(page, seededData.slug);

    // Default formato is 'texto' — the fields grid is visible, including the
    // two previously-missing required inputs.
    const babyInput = page.getByPlaceholder('Maria Helena');
    const hostInput = page.getByPlaceholder('Mariana & Tiago');
    await expect(babyInput).toBeVisible();
    await expect(hostInput).toBeVisible();

    // Fill ONLY the message — the operator's original repro shape.
    await page.locator('.cv-invite-textarea').fill('vem celebrar com a gente ♡');

    const salvar = page.getByRole('button', { name: 'Salvar convite' });
    await salvar.click();

    // Pre-flight blocks: inline errors render under the two inputs, with the
    // wizard's copy. The user can fix everything from THIS panel.
    await expect(page.getByRole('alert').filter({ hasText: ERR_BABY })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: ERR_HOST })).toBeVisible();
    await expect(babyInput).toHaveAttribute('aria-invalid', 'true');
    await expect(hostInput).toHaveAttribute('aria-invalid', 'true');

    // The raw backend message must NOT appear — the 400 is unreachable now.
    await expect(page.getByText(DEADEND_BACKEND_MSG)).toHaveCount(0);

    // Fix the fields inline → errors clear live → save succeeds for real.
    await babyInput.fill('Aurora');
    await expect(page.getByRole('alert').filter({ hasText: ERR_BABY })).toHaveCount(0);
    await hostInput.fill('Ana & João');
    await expect(page.getByRole('alert').filter({ hasText: ERR_HOST })).toHaveCount(0);

    await salvar.click();
    await expect(page.getByText('Salvo com sucesso')).toBeVisible();

    // Round-trip proof: reload and confirm the convite row actually persisted
    // (hydration fills the compositor from the saved convite, not EMPTY_STATE).
    await openCompositor(page, seededData.slug);
    await expect(page.getByPlaceholder('Maria Helena')).toHaveValue('Aurora');
    await expect(page.getByPlaceholder('Mariana & Tiago')).toHaveValue('Ana & João');
  });

  test('convite_virtual mode with no saved convite: save points at the Criar convite CTA', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    await openCompositor(page, seededData.slug);

    // Switch to the virtual-invite tab — fresh account has no saved convite,
    // so the panel shows the 'Criar convite' prompt instead of a preview.
    await page.getByRole('button', { name: /convite virtual/ }).click();
    await expect(page.getByText('Você ainda não criou seu convite.')).toBeVisible();
    const cta = page.getByRole('link', { name: 'Criar convite' });
    await expect(cta).toBeVisible();

    await page.getByRole('button', { name: 'Salvar convite' }).click();

    // Pre-flight redirects intent to the CTA — no dead-end backend error.
    await expect(page.getByText('crie seu convite primeiro ♡')).toBeVisible();
    await expect(page.getByText(DEADEND_BACKEND_MSG)).toHaveCount(0);

    // The CTA it points at really routes to the convite editor.
    await expect(cta).toHaveAttribute('href', /\/painel\/.+\/convite/);
  });
});
