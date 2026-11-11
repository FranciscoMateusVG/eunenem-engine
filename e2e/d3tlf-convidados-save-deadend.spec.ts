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
// aperture-n06ca — date/time are required now; the compositor renders both
// inputs, so a blocked save stays fixable from this panel.
const ERR_DATE = 'escolha a data do evento ♡';
const ERR_TIME = 'escolha o horário do evento ♡';
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
  test('texto mode: saves the convite and manages a guest on desktop and mobile', async ({
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

    // Pre-flight blocks: inline errors render under the inputs, with the
    // wizard's copy. The user can fix everything from THIS panel.
    // aperture-n06ca — date/horário are required now and error inline too.
    await expect(page.getByRole('alert').filter({ hasText: ERR_BABY })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: ERR_HOST })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: ERR_DATE })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: ERR_TIME })).toBeVisible();
    await expect(babyInput).toHaveAttribute('aria-invalid', 'true');
    await expect(hostInput).toHaveAttribute('aria-invalid', 'true');

    // The raw backend message must NOT appear — the 400 is unreachable now.
    await expect(page.getByText(DEADEND_BACKEND_MSG)).toHaveCount(0);

    // Fix the fields inline → errors clear live → save succeeds for real.
    await babyInput.fill('Aurora');
    await expect(page.getByRole('alert').filter({ hasText: ERR_BABY })).toHaveCount(0);
    await hostInput.fill('Ana & João');
    await expect(page.getByRole('alert').filter({ hasText: ERR_HOST })).toHaveCount(0);
    await page.locator('input[type="date"]').fill('2027-03-20');
    await expect(page.getByRole('alert').filter({ hasText: ERR_DATE })).toHaveCount(0);
    await page.locator('input[type="time"]').fill('15:30');
    await expect(page.getByRole('alert').filter({ hasText: ERR_TIME })).toHaveCount(0);

    await salvar.click();
    await expect(page.getByText('Salvo com sucesso')).toBeVisible();

    // Round-trip proof: reload and confirm the convite row actually persisted
    // (hydration fills the compositor from the saved convite, not EMPTY_STATE).
    await openCompositor(page, seededData.slug);
    await expect(page.getByPlaceholder('Maria Helena')).toHaveValue('Aurora');
    await expect(page.getByPlaceholder('Mariana & Tiago')).toHaveValue('Ana & João');

    await page.getByRole('button', { name: 'adicionar convidado', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'adicionar convidado' });
    await add.locator('#convidado-name').fill('Convidada original');
    await add.locator('#convidado-phone').fill('31999990000');
    await add.getByRole('button', { name: 'Adicionar à lista' }).click();

    const original = page.getByTestId('convidado-row').filter({ hasText: 'Convidada original' });
    await original.getByRole('button', { name: 'Editar', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Editar convidado' });
    await edit.getByLabel('Nome', { exact: true }).fill('Convidada atualizada');
    await edit.getByLabel('Telefone com DDI').fill('+55 (31) 99999-0001');
    await edit.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(edit).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const updated = page.getByTestId('convidado-row').filter({ hasText: 'Convidada atualizada' });
    await expect(updated.getByText('+55 (31) 99999-0001', { exact: true })).toBeVisible();
    await updated.getByRole('button', { name: 'Excluir', exact: true }).click();
    const remove = page.getByRole('dialog', { name: 'Excluir convidado' });
    await remove.getByRole('button', { name: 'Cancelar' }).click();
    await expect(updated).toBeVisible();
    await updated.getByRole('button', { name: 'Excluir', exact: true }).click();
    await remove.getByRole('button', { name: 'Excluir convidado' }).click();
    await expect(updated).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'adicionar convidado', exact: true }),
    ).toBeVisible();
    await expect(updated).toHaveCount(0);
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
