/**
 * aperture-bqvb5 — the owner thanks someone who gave a gift, from a phone.
 *
 * A paid gift with a recado shows up in Recados; "agradecer ♡" opens the
 * thank-you composer with that giver preselected. She sends the default
 * message, the gift is recorded as thanked, and reopening the composer shows
 * "agradecido ♡" plus a warning before thanking again. (Locally the server
 * has no SMTP, so delivery goes through the no-op transport; the real SMTP
 * path is covered by tests/integration/agradecer-presentes.postgres.test.ts.)
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedSoldOutGift } from './seed-helpers.js';
import { classifyTarget } from './target-classifier.js';

test.skip(
  !classifyTarget(process.env.E2E_BASE_URL).isLocal,
  'Thank-you fixtures run only against local test infrastructure.',
);

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('titular agradece quem presenteou pelo recado, no celular', async ({
  authenticatedPage: page,
  seededData,
}) => {
  const convidada = `Ana ${randomUUID().slice(0, 6)}`;
  const db = createDatabase(databaseUrl);
  let idPagamento: string;
  try {
    const nomePresente = `Banheira ${randomUUID().slice(0, 6)}`;
    await seedSoldOutGift(buildSeedGiftRepos(db), {
      ...seededData,
      nome: nomePresente,
      valorCents: 5000,
    });
    const row = await db
      .selectFrom('pagamentos as p')
      .innerJoin('intencao_items as i', 'i.id_pagamento', 'p.id')
      .innerJoin('contribuicoes as c', 'c.id', 'i.id_contribuicao')
      .select('p.id')
      .where('c.nome', '=', nomePresente)
      .executeTakeFirstOrThrow();
    idPagamento = row.id;
    await sql`UPDATE pagamentos SET intencao_contribuinte_nome=${`${convidada} Souza`},
      intencao_contribuinte_email=${`${randomUUID()}@e2e.local`},
      intencao_contribuinte_mensagem='Muitas felicidades!' WHERE id=${idPagamento}`.execute(db);
  } finally {
    await db.destroy();
  }

  await page.goto(`/painel/${seededData.slug}/c/${seededData.idCampanha}/mensagens`);
  await expect(page.getByText('Muitas felicidades!')).toBeVisible();

  await page.getByRole('button', { name: /agradecer ♡/ }).tap();
  const modal = page.getByRole('dialog', { name: 'Agradecer presentes' });
  await expect(modal).toBeVisible();
  const pessoa = modal.getByRole('checkbox', { name: new RegExp(convidada) });
  await expect(pessoa).toBeChecked();
  await expect(modal.getByLabel('prévia')).toContainText(`Oi, ${convidada.split(' ')[0]}!`);
  await expect(modal.getByText('agradecido ♡')).toHaveCount(0);

  const enviar = modal.getByRole('button', { name: 'enviar agradecimento' });
  const box = await enviar.boundingBox();
  expect(box && box.x + box.width <= 390, 'send button fits the phone viewport').toBe(true);
  await enviar.tap();
  await expect(page.getByText('agradecimento enviado ♡')).toBeVisible();
  await expect(modal).toBeHidden();

  const check = createDatabase(databaseUrl);
  try {
    const registro = await check
      .selectFrom('agradecimentos_presentes')
      .select('agradecido_em')
      .where('id_pagamento', '=', idPagamento)
      .executeTakeFirst();
    expect(registro?.agradecido_em).toBeInstanceOf(Date);
  } finally {
    await check.destroy();
  }

  await page.getByRole('button', { name: /agradecer ♡/ }).tap();
  await expect(modal.getByText('agradecido ♡')).toBeVisible();
  await expect(modal.getByRole('status')).toContainText('já foi agradecido');
  await expect(modal.getByRole('button', { name: 'enviar de novo' })).toBeVisible();
});
