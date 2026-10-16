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
