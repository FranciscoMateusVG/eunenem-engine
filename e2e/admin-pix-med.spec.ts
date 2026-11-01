import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedMultiItemApprovedPagamento } from './seed-helpers.js';
import { classifyTarget } from './target-classifier.js';

test.skip(!classifyTarget(process.env.E2E_BASE_URL).isLocal, 'MED fixtures are local-only.');

const databaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame';

test('admin records MED through real API and sees payment/campaign hold, then releases', async ({
  adminAuthenticatedPage: page,
  seededData,
}) => {
  const db = createDatabase(databaseUrl);
  let pagamentoId: string;
  try {
    const seed = await seedMultiItemApprovedPagamento(buildSeedGiftRepos(db), {
      idCampanha: seededData.idCampanha,
      idOpcaoPresentes: seededData.idOpcaoPresentes,
      items: [{ nome: `MED ${randomUUID()}`, valorCents: 5000, quantidade: 1 }],
    });
    pagamentoId = seed.pagamentoId;
    await sql`UPDATE pagamentos SET intencao_metodo = 'pix' WHERE id = ${pagamentoId}`.execute(db);
  } finally {
    await db.destroy();
  }
  await page.goto(`/admin/pagamento/${pagamentoId}`);
  await page.getByLabel('Valor contestado (R$)').fill('1.00');
  await page.getByLabel('Data do bloqueio').fill('2026-11-01T09:00');
  await page.getByLabel('ID do caso (opcional)').fill(randomUUID());
  await page.getByRole('button', { name: 'Registrar contestação e reter repasse' }).click();
  await expect(page.getByText('MED bloqueada', { exact: true })).toBeVisible();
  await expect(page.getByText(/Repasse retido por MED/)).toBeVisible();
  await page.goto(`/admin/campanha/${seededData.idCampanha}`);
  await expect(page.getByText('MED bloqueada', { exact: true })).toBeVisible();
  await page.goto(`/admin/pagamento/${pagamentoId}`);
  await page.getByLabel('Data da resolução confirmada pelo banco').fill('2026-11-01T10:00');
  await page.getByLabel('Notas da resolução').fill('Liberação confirmada no banco');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Marcar liberada' }).click();
  await expect(page.getByText('MED liberada', { exact: true })).toBeVisible();
  await expect(page.getByText(/Repasse retido por MED/)).toHaveCount(0);
});
