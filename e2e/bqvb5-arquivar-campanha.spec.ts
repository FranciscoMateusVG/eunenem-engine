/**
 * aperture-bqvb5 — the titular archives and unarchives a list from Minhas
 * Listas.
 *
 *   - Archive asks for confirmation; the card then shows the archived tag and
 *     is greyed out, but its painel link keeps working.
 *   - The public page of the archived list is unavailable to everyone (404,
 *     no gifts, nothing to buy).
 *   - Unarchive brings the card and the public page back.
 */
import { sql } from 'kysely';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { classifyTarget } from './target-classifier.js';

test.skip(
  !classifyTarget(process.env.E2E_BASE_URL).isLocal,
  'Archive fixtures run only against local test infrastructure.',
);

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

test.describe('Minhas Listas — arquivar lista', () => {
  test('titular arquiva (página pública sai do ar) e desarquiva (volta)', async ({
    authenticatedPage: page,
    seededData,
    browser,
  }) => {
    const db = createDatabase(databaseUrl);
    try {
      // Skip the first-run onboarding so /campanhas renders the list grid.
      await sql`UPDATE usuarios SET onboarding_concluido_em=now(),tutorial_completado_em=now() WHERE id=${seededData.session.userId}`.execute(
        db,
      );
    } finally {
      await db.destroy();
    }
    const publicUrl = `/pagina/${seededData.slug}/c/${seededData.idCampanha}`;
    const visitante = await browser.newContext();
    const visitor = await visitante.newPage();
    try {
      await expect(
        (await visitor.goto(publicUrl))?.status(),
        'list is public before archiving',
      ).toBe(200);
      await expect(visitor.getByText(seededData.nomeContribuicao)).toBeVisible();

      await page.goto('/campanhas');
      const card = page
        .getByTestId('card-campanha')
        .filter({ has: page.locator(`a[href$="/c/${seededData.idCampanha}"]`) });
      await expect(card).toBeVisible();
      await expect(card).not.toHaveAttribute('data-arquivada', 'true');

      await card.getByRole('button', { name: /^Arquivar lista/ }).click();
      const confirmar = page.getByRole('dialog', { name: 'Arquivar lista' });
      await expect(confirmar).toContainText('página pública');
      await confirmar.getByRole('button', { name: 'Arquivar' }).click();

      await expect(card).toHaveAttribute('data-arquivada', 'true');
      await expect(card.getByText('arquivada', { exact: true })).toBeVisible();
      expect(
        await card.evaluate((el) => getComputedStyle(el).filter),
        'archived card is greyed out',
      ).toContain('grayscale');
      // The painel link (internal screens) stays.
      await expect(card.locator(`a[href$="/c/${seededData.idCampanha}"]`)).toBeVisible();

      expect((await visitor.goto(publicUrl))?.status()).toBe(404);
      await expect(visitor.getByText(seededData.nomeContribuicao)).toHaveCount(0);
      await expect(visitor.getByRole('button', { name: /Adicionar/i })).toHaveCount(0);

      await card.getByRole('button', { name: /^Desarquivar lista/ }).click();
      await expect(card).not.toHaveAttribute('data-arquivada', 'true');
      await expect(card.getByText('arquivada', { exact: true })).toHaveCount(0);

      expect((await visitor.goto(publicUrl))?.status()).toBe(200);
      await expect(visitor.getByText(seededData.nomeContribuicao)).toBeVisible();
    } finally {
      await visitante.close();
    }
  });
});
