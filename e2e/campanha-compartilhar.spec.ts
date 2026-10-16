import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './fixtures.js';
import { classifyTarget } from './target-classifier.js';

test.skip(
  !classifyTarget(process.env.E2E_BASE_URL).isLocal,
  'Sharing mutations run only against local test infrastructure.',
);

test('owner shares by email and revokes through the real campaign screen', async ({
  authenticatedPage: page,
  seededData,
}) => {
  const response = await page.goto(
    `/painel/${seededData.slug}/c/${seededData.idCampanha}/compartilhar`,
  );
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Compartilhar', exact: true })).toBeVisible();
  const email = `sharing-${randomUUID()}@example.com`;
  await page.getByLabel('E-mail da pessoa').fill(email);
  await page.getByRole('button', { name: 'Convidar', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Convite enviado');
  const invitation = page.getByRole('listitem').filter({ hasText: email });
  await expect(invitation).toContainText('Pendente');
  await invitation.getByRole('button', { name: 'Revogar convite' }).click();
  await expect(invitation).toContainText('Revogado');
});

test('verified invitee sees the shared campaign and loses it immediately after owner removal', async ({
  authenticatedPage: ownerPage,
  seededData,
  browser,
}, testInfo) => {
  const { createDatabase } = await import('../src/adapters/database.js');
  const { mintMagicLinkSession, browserCookieFor } = await import('./magic-link-auth.js');
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error('This test requires an explicit local E2E_DATABASE_URL');
  const db = createDatabase(databaseUrl);
  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';
  const recipientContext = await browser.newContext({ baseURL });
  try {
    await ownerPage.goto(`/painel/${seededData.slug}/c/${seededData.idCampanha}/compartilhar`);
    const email = `shared-member-${randomUUID()}@example.com`;
    await ownerPage.getByLabel('E-mail da pessoa').fill(email);
    await ownerPage.getByRole('button', { name: 'Convidar', exact: true }).click();
    await expect(ownerPage.getByRole('status')).toContainText('Convite enviado');
    const session = await mintMagicLinkSession(db, { email, name: 'Shared Member', baseURL });
    await recipientContext.addCookies([browserCookieFor(session, baseURL)]);
    const recipient = await recipientContext.newPage();
    await recipient.goto('/campanhas');
    await expect(recipient.locator(`a[href$="/c/${seededData.idCampanha}"]`)).toBeVisible();
    await recipient.locator(`a[href$="/c/${seededData.idCampanha}"]`).click();
    await expect(recipient.getByRole('dialog', { name: 'Vamos montar sua página' })).toHaveCount(0);
    await expect(recipient.getByRole('link', { name: 'Criar minha própria lista' })).toBeVisible();
    await expect(recipient.locator('.painel-tutorial-overlay')).toBeVisible();
    await recipient.keyboard.press('Escape');
    await expect(recipient.locator('.painel-tutorial-overlay')).toHaveCount(0);
    await recipient.getByRole('link', { name: 'Criar minha própria lista' }).click();
    await expect(recipient.getByRole('dialog', { name: 'Vamos montar sua página' })).toBeVisible();
    const ownOnboarding = await db
      .selectFrom('usuarios')
      .select('onboarding_concluido_em')
      .where('id', '=', session.userId)
      .executeTakeFirstOrThrow();
    expect(ownOnboarding.onboarding_concluido_em).toBeNull();
    await recipient.goto('/campanhas');
    await ownerPage.reload();
    const member = ownerPage
      .getByRole('listitem')
      .filter({ hasText: email })
      .filter({ has: ownerPage.getByRole('button', { name: 'Remover acesso' }) });
    await expect(member).toBeVisible();
    await ownerPage.screenshot({ path: testInfo.outputPath('compartilhar.png'), fullPage: true });
    ownerPage.once('dialog', (dialog) => dialog.accept());
    await member.getByRole('button', { name: 'Remover acesso' }).click();
    await expect(member).toHaveCount(0);
    await recipient.reload();
    await expect(recipient.locator(`a[href$="/c/${seededData.idCampanha}"]`)).toHaveCount(0);
  } finally {
    await recipientContext.close();
    await db.destroy();
  }
});

test('member-only dashboard has an empty own profile and public links use the campaign owner', async ({
  authenticatedPage: ownerPage,
  seededData,
  browser,
}) => {
  const { createDatabase } = await import('../src/adapters/database.js');
  const { mintMagicLinkSession, browserCookieFor } = await import('./magic-link-auth.js');
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error('Explicit local test database required');
  const db = createDatabase(databaseUrl);
  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';
  const context = await browser.newContext({ baseURL });
  try {
    const campanhaSlug = `shared-${randomUUID().slice(0, 8)}`;
    await db
      .updateTable('campanhas')
      .set({ slug: campanhaSlug })
      .where('id', '=', seededData.idCampanha)
      .execute();
    await ownerPage.goto(`/painel/${seededData.slug}/c/${seededData.idCampanha}/compartilhar`);
    const email = `member-only-${randomUUID()}@example.com`;
    await ownerPage.getByLabel('E-mail da pessoa').fill(email);
    await ownerPage.getByRole('button', { name: 'Convidar', exact: true }).click();
    await expect(ownerPage.getByRole('status')).toContainText('Convite enviado');
    const session = await mintMagicLinkSession(db, { email, name: 'Member Only', baseURL });
    const user = await db
      .selectFrom('usuarios')
      .select(['slug', 'id_conta'])
      .where('id', '=', session.userId)
      .executeTakeFirstOrThrow();
    await db
      .deleteFrom('campanha_administradores')
      .where('id_usuario', '=', user.id_conta)
      .where('campanha_id', '!=', seededData.idCampanha)
      .execute();
    await db
      .deleteFrom('campanha_membros_permissoes')
      .where('id_conta', '=', user.id_conta)
      .where('campanha_id', '!=', seededData.idCampanha)
      .execute();
    await context.addCookies([browserCookieFor(session, baseURL)]);
    const page = await context.newPage();
    const profileResponse = page.waitForResponse((response) =>
      response.url().includes('perfil.getPerfil'),
    );
    await page.goto(`/painel/${user.slug}/c/${seededData.idCampanha}`);
    expect((await profileResponse).status()).toBe(200);
    const canonicalPath = `/pagina/${seededData.slug}/${campanhaSlug}`;
    await expect(page.locator('.painel-url-slug')).toHaveAttribute(
      'href',
      `${baseURL}${canonicalPath}`,
    );
    await expect(page.getByRole('dialog', { name: 'Vamos montar sua página' })).toHaveCount(0);
    await expect(page.locator(`a[href="${canonicalPath}"]`)).toBeVisible();
    await page.goto(canonicalPath);
    await expect(page.locator('body')).not.toContainText('Página não encontrada');
    await expect(page.locator('body')).toContainText(seededData.nomeContribuicao);
  } finally {
    await context.close();
    await db.destroy();
  }
});
