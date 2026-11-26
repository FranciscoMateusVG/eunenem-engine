/**
 * aperture-bqvb5 — the owner could not add a "presente personalizado" on a phone.
 *
 * THE BUG: the price field is `inputMode="decimal"`, so phones open their
 * numeric keypad. Many of those keypads (common Android keyboards, iPhones set
 * to a non-BR region) only offer "." as the decimal key, so the owner types
 * "50.00". The gift price parser only accepted "," as the decimal separator,
 * so "50.00" parsed to 0: the form showed "o valor por unidade deve ser de
 * pelo menos R$ 10,00" and "Adicionar à lista" stayed disabled. Desktop users
 * type "50,00" on a full keyboard, which is why the desktop spec
 * (painel-adicionar-qty) never saw it.
 *
 * Also asserted: at 320px the footer actions stay inside the modal (the
 * "Adicionar à lista" button used to be clipped by the modal edge).
 */
import { randomUUID } from 'node:crypto';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

// Pixel 7 / iPhone SE metrics, emulated in Chromium (the suite's only browser).
const PHONES = [
  { name: 'Pixel 7', viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625 },
  { name: 'iPhone SE', viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 },
] as const;

for (const phone of PHONES) {
  test.describe(`Painel — presente personalizado no celular (${phone.name})`, () => {
    test.use({
      viewport: phone.viewport,
      deviceScaleFactor: phone.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
    });

    test('price typed with the keypad decimal point ("50.00") adds the gift at R$ 50,00', async ({
      authenticatedPage: page,
      seededData,
    }) => {
      const giftName = `Cadeirinha celular ${randomUUID().slice(0, 8)}`;

      await page.goto(`/painel/${seededData.slug}/lista`);
      await expect(page.getByText(seededData.nomeContribuicao)).toBeVisible();

      await page.getByRole('button', { name: 'Criar item personalizado' }).tap();
      await page.getByLabel('nome do presente').tap();
      await page.keyboard.type(giftName);
      await page.getByLabel('valor por unidade').tap();
      await page.keyboard.type('50.00');

      await expect(page.getByRole('alert')).toHaveCount(0);
      const add = page.getByRole('button', { name: 'Adicionar à lista' });
      await expect(add).toBeEnabled();

      // Every footer action must sit fully inside the modal (not clipped).
      const modal = page.locator('.lista-modal');
      const modalBox = await modal.boundingBox();
      for (const button of [page.getByRole('button', { name: 'Cancelar' }), add]) {
        const box = await button.boundingBox();
        expect(box, 'footer button must be laid out').not.toBeNull();
        expect(modalBox, 'modal must be laid out').not.toBeNull();
        if (box && modalBox) {
          expect(box.x).toBeGreaterThanOrEqual(modalBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(modalBox.x + modalBox.width);
        }
      }

      const created = page.waitForResponse(
        (r) => r.url().includes('/api/trpc/contribuicao.create') && r.request().method() === 'POST',
      );
      await add.tap();
      expect((await created).status()).toBeLessThan(300);
      await expect(page.getByText(giftName)).toBeVisible();

      const db = createDatabase(DATABASE_URL);
      try {
        const rows = await new ContribuicaoRepositoryPostgres(db).findByCampanhaId(
          seededData.idCampanha,
        );
        const row = rows.find((r) => r.nome === giftName);
        expect(row?.valor).toBe(5000);
      } finally {
        await db.destroy();
      }
    });
  });
}
