/**
 * aperture-0vne4 — an admin viewing their own /pagina/<slug> gets the painel's
 * edit/remove buttons on the gift cards (same modals, same rules). Guests and
 * members without presentes:gerenciar never see them.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { browserCookieFor, mintMagicLinkSession } from './magic-link-auth.js';
import { buildSeedGiftRepos, seedAvailableGift, seedSoldOutGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame';

function card(page: import('@playwright/test').Page, nome: string) {
  return page.locator(`article[data-gift-nome="${nome}"]`);
}

test('owner edits and removes gifts from the public page; removal stays blocked after a purchase', async ({
  authenticatedPage: page,
  seededData,
}) => {
  const db = createDatabase(DATABASE_URL);
  const repos = buildSeedGiftRepos(db);
  const base = { idCampanha: seededData.idCampanha, idOpcaoPresentes: seededData.idOpcaoPresentes };
  const removivel = `Removível ${randomUUID().slice(0, 6)}`;
  const comprado = `Comprado ${randomUUID().slice(0, 6)}`;
  try {
    await seedAvailableGift(repos, { ...base, nome: removivel, valorCents: 3000 });
    await seedSoldOutGift(repos, { ...base, nome: comprado, valorCents: 100 });
  } finally {
    await db.destroy();
  }

  await page.goto(`/pagina/${seededData.slug}`);
  const original = card(page, seededData.nomeContribuicao);
  await expect(
    original.getByRole('button', { name: `Editar ${seededData.nomeContribuicao}` }),
  ).toBeVisible();

  // Edit: same modal as the painel, prefilled with the owner's data.
  await original.getByRole('button', { name: `Editar ${seededData.nomeContribuicao}` }).click();
  const modal = page.getByRole('dialog').filter({ hasText: 'Editar presente' });
  await expect(modal).toBeVisible();
  const novoNome = `${seededData.nomeContribuicao} editado`;
  await modal.getByLabel('nome do presente', { exact: false }).fill(novoNome);
  await modal.getByTestId('edit-save-btn').click();
  await expect(modal).toHaveCount(0);
  await expect(card(page, novoNome)).toBeVisible();
  await expect(card(page, seededData.nomeContribuicao)).toHaveCount(0);

  // Remove an unsold gift.
  await card(page, removivel)
    .getByRole('button', { name: `Remover ${removivel}` })
    .click();
  const confirm = page.getByRole('dialog').filter({ hasText: 'Remover este presente' });
  await confirm.getByRole('button', { name: 'Sim, remover' }).click();
  await expect(card(page, removivel)).toHaveCount(0);

  // A purchased gift: edit allowed, removal disabled with the painel's reason.
  const vendido = card(page, comprado);
  await expect(vendido.getByRole('button', { name: `Editar ${comprado}` })).toBeEnabled();
  const lixeira = vendido.getByRole('button', { name: `Remover ${comprado}` });
  await expect(lixeira).toHaveAttribute('aria-disabled', 'true');
  await expect(lixeira).toHaveAttribute(
    'title',
    'Não é possível remover porque este presente já foi comprado.',
  );
  await lixeira.click({ force: true });
  await expect(page.getByRole('dialog').filter({ hasText: 'Remover este presente' })).toHaveCount(
    0,
  );
  await expect(vendido).toBeVisible();
});

// aperture-11l2x — the buttons sit in the photo's top-right corner (like the
// painel), ≥40px to tap on mobile, never on top of the "Presenteado" tag.
for (const viewport of [
  { width: 375, height: 812 },
  { width: 1280, height: 900 },
]) {
  test(`owner buttons sit top-right of the photo, clear of the tag (${viewport.width}px)`, async ({
    authenticatedPage: page,
    seededData,
  }) => {
    const db = createDatabase(DATABASE_URL);
    const comprado = `Comprado ${randomUUID().slice(0, 6)}`;
    try {
      await seedSoldOutGift(buildSeedGiftRepos(db), {
        idCampanha: seededData.idCampanha,
        idOpcaoPresentes: seededData.idOpcaoPresentes,
        nome: comprado,
        valorCents: 100,
      });
    } finally {
      await db.destroy();
    }

    await page.setViewportSize(viewport);
    await page.goto(`/pagina/${seededData.slug}`);
    const vendido = card(page, comprado);
    const editar = vendido.getByRole('button', { name: `Editar ${comprado}` });
    const remover = vendido.getByRole('button', { name: `Remover ${comprado}` });
    await expect(editar).toBeVisible();

    const foto = await vendido.locator('.pagina-gift-thumb').boundingBox();
    const tag = await vendido.locator('.pagina-gift-tag').boundingBox();
    const boxes = [await editar.boundingBox(), await remover.boundingBox()];
    if (!foto || !tag || boxes.some((b) => !b)) throw new Error('layout boxes missing');
    for (const b of boxes as NonNullable<(typeof boxes)[number]>[]) {
      expect(b.y - foto.y).toBeLessThan(16);
      expect(foto.x + foto.width - (b.x + b.width)).toBeLessThan(foto.width / 2);
      expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(viewport.width < 640 ? 40 : 36);
      const overlaps =
        b.x < tag.x + tag.width &&
        tag.x < b.x + b.width &&
        b.y < tag.y + tag.height &&
        tag.y < b.y + b.height;
      expect(overlaps).toBe(false);
    }
  });
}

test('guests never see the edit/remove buttons', async ({ page, seededData }) => {
  await page.goto(`/pagina/${seededData.slug}`);
  await expect(card(page, seededData.nomeContribuicao)).toBeVisible();
  await expect(
    card(page, seededData.nomeContribuicao).getByRole('button', { name: /\+ Adicionar/i }),
  ).toBeVisible();
  await expect(page.getByTestId('gift-edit-btn')).toHaveCount(0);
  await expect(page.getByTestId('gift-remove-btn')).toHaveCount(0);
});

test('a member sees the buttons only with presentes:gerenciar', async ({
  browser,
  baseURL,
  seededData,
}) => {
  const db = createDatabase(DATABASE_URL);
  const email = `e2e-0vne4-membro-${randomUUID()}@e2e.local`;
  const session = await mintMagicLinkSession(db, { email, name: 'Membro 0vne4', baseURL });
  const { id_conta: idConta } = await db
    .selectFrom('usuarios')
    .select('id_conta')
    .where('email', '=', email)
    .executeTakeFirstOrThrow();
  const context = await browser.newContext();
  try {
    await db
      .insertInto('campanha_administradores')
      .values({ campanha_id: seededData.idCampanha, id_usuario: idConta })
      .execute();
    await sql`
      INSERT INTO campanha_membros_permissoes (campanha_id, id_conta, papel, permissoes)
      VALUES (${seededData.idCampanha}::uuid, ${idConta}::uuid, 'membro', '{}')
    `.execute(db);
    await context.addCookies([browserCookieFor(session, baseURL)]);
    const page = await context.newPage();

    // Wait for the access probe so "absent" is not just "not loaded yet".
    const acesso = page.waitForResponse((r) => r.url().includes('campanhaMembros.meuAcesso'));
    await page.goto(`/pagina/${seededData.slug}`);
    await expect(card(page, seededData.nomeContribuicao)).toBeVisible();
    await acesso;
    await expect(page.getByTestId('gift-edit-btn')).toHaveCount(0);

    await sql`
      UPDATE campanha_membros_permissoes SET permissoes = ARRAY['presentes:gerenciar']::text[]
      WHERE campanha_id = ${seededData.idCampanha}::uuid AND id_conta = ${idConta}::uuid
    `.execute(db);
    await page.reload();
    await expect(
      card(page, seededData.nomeContribuicao).getByRole('button', {
        name: `Editar ${seededData.nomeContribuicao}`,
      }),
    ).toBeVisible();
  } finally {
    await context.close();
    await db
      .deleteFrom('campanha_membros_permissoes')
      .where('campanha_id', '=', seededData.idCampanha)
      .where('id_conta', '=', idConta)
      .execute();
    await db
      .deleteFrom('campanha_administradores')
      .where('campanha_id', '=', seededData.idCampanha)
      .where('id_usuario', '=', idConta)
      .execute();
    await db.destroy();
  }
});
