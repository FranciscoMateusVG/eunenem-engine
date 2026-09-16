import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, request as pwRequest } from '@playwright/test';
import { createDatabase } from '../src/adapters/database.js';
import { test } from './fixtures.js';
import { mintMagicLinkSession } from './magic-link-auth.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

type RawResult = {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  data?: unknown;
};

async function trpcRawMutation(
  api: APIRequestContext,
  procedure: string,
  input: unknown,
): Promise<RawResult> {
  const response = await api.post(`/api/trpc/${procedure}`, { data: input });
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; data?: { code?: string } };
    result?: { data?: unknown };
  };
  return {
    ok: response.ok(),
    status: response.status(),
    code: body.error?.data?.code,
    message: body.error?.message,
    data: body.result?.data,
  };
}

async function currentCampaignSlug(
  api: APIRequestContext,
  idCampanha: string,
): Promise<string | null> {
  const response = await api.get('/api/trpc/campanhas.list');
  expect(response.ok(), `campanhas.list: ${response.status()} ${await response.text()}`).toBe(true);
  const body = (await response.json()) as {
    result?: { data?: { novas?: Array<{ id: string; campanhaSlug: string | null }> } };
  };
  const campanha = body.result?.data?.novas?.find((candidate) => candidate.id === idCampanha);
  if (!campanha) throw new Error(`campanhas.list omitted ${idCampanha}`);
  return campanha.campanhaSlug;
}

async function finishOnboarding(page: import('@playwright/test').Page, name: string) {
  const wizard = page.getByRole('dialog', { name: 'Vamos montar sua página' });
  await expect(wizard).toBeVisible();
  await page.locator('#ob-name').fill(name);
  await page.locator('#ob-baby').fill('Bebe PR2NN');
  await page.getByRole('button', { name: /próximo/ }).click();
  await page.locator('#ob-date').fill('2030-01-01');
  await page.locator('#ob-type').selectOption('cha-bebe');
  await page.locator('#ob-genero').selectOption('surpresa');
  await page.getByRole('button', { name: /próximo/ }).click();
  await page.getByRole('button', { name: /criar minha página/ }).click();
  await expect(wizard).toBeHidden({ timeout: 20_000 });
}

test.describe('PR2NN campaign public-link UI and isolation', () => {
  test('initial/edit links resolve, limits align, collision and other-owner writes fail', async ({
    authenticatedPage: page,
    seededData,
    baseURL,
  }) => {
    const resolvedBaseURL = baseURL ?? 'http://localhost:3002';
    await page.goto(`/painel/${seededData.slug}`, { waitUntil: 'domcontentloaded' });
    await finishOnboarding(page, seededData.nomeExibicao);

    const api = page.context().request;
    const second = await trpcRawMutation(api, 'campanhas.criar', {
      titulo: `Segunda PR2NN ${randomUUID().slice(0, 8)}`,
    });
    expect(second.ok, second.message).toBe(true);
    const secondId = (second.data as { id?: string } | undefined)?.id;
    expect(secondId).toBeTruthy();

    await page.goto(`/painel/${seededData.slug}/c/${seededData.idCampanha}/perfil`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('#perfil-slug').fill('pr2nn-camp');
    await expect(page.getByText('disponível ♡', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'salvar novo link' }).click();
    await page.getByRole('button', { name: 'sim, trocar o link' }).click();
    await expect.poll(() => currentCampaignSlug(api, seededData.idCampanha)).toBe('pr2nn-camp');

    const longSlug = `a${'b'.repeat(30)}`;
    await page.locator('#perfil-slug').fill(longSlug);
    await expect(page.getByText('disponível ♡', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'salvar novo link' }).click();
    await page.getByRole('button', { name: 'sim, trocar o link' }).click();
    await expect.poll(() => currentCampaignSlug(api, seededData.idCampanha)).toBe(longSlug);

    const publicResponse = await page.goto(`/pagina/${seededData.slug}/${longSlug}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(publicResponse?.status()).toBe(200);
    await expect(page.getByTestId('pagina-baby-name')).toHaveText('Bebe PR2NN');

    const legacyBypass = await trpcRawMutation(api, 'campanhas.definirSlug', {
      idCampanha: seededData.idCampanha,
      slug: `a${'b'.repeat(31)}`,
      origem: 'setup',
    });
    expect(legacyBypass.ok).toBe(false);
    expect(legacyBypass.code).toBe('FORBIDDEN');

    const siblingCollision = await trpcRawMutation(api, 'campanhas.definirSlug', {
      idCampanha: secondId,
      slug: longSlug,
    });
    expect(siblingCollision.ok).toBe(false);
    expect(siblingCollision.code).toBe('BAD_REQUEST');
    expect(siblingCollision.message).toBe('slug_em_uso');

    const sixtyCharSlug = `c${'d'.repeat(59)}`;
    const sixty = await trpcRawMutation(api, 'campanhas.definirSlug', {
      idCampanha: secondId,
      slug: sixtyCharSlug,
    });
    expect(sixty.ok, sixty.message).toBe(true);
    const sixtyResponse = await page.goto(`/pagina/${seededData.slug}/${sixtyCharSlug}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(sixtyResponse?.status()).toBe(200);

    const creator31 = `z${'y'.repeat(30)}`;
    const invalidCreator = await page.goto(`/pagina/${creator31}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(invalidCreator?.status()).toBe(404);

    const db = createDatabase(DATABASE_URL);
    const intruderSession = await mintMagicLinkSession(db, {
      email: `pr2nn-intruder-${randomUUID()}@e2e.local`,
      name: 'Intruso PR2NN',
      baseURL: resolvedBaseURL,
    });
    await db.destroy();
    const intruderApi = await pwRequest.newContext({
      baseURL: resolvedBaseURL,
      extraHTTPHeaders: { cookie: intruderSession.cookie.header },
    });
    try {
      const crossOwner = await trpcRawMutation(intruderApi, 'campanhas.definirSlug', {
        idCampanha: seededData.idCampanha,
        slug: 'intruder-write',
      });
      expect(crossOwner.ok).toBe(false);
      expect(['UNAUTHORIZED', 'NOT_FOUND', 'FORBIDDEN']).toContain(crossOwner.code);

      const creatorCollision = await trpcRawMutation(intruderApi, 'usuario.atualizarSlug', {
        novoSlug: seededData.slug,
      });
      expect(creatorCollision.ok).toBe(false);
      expect(creatorCollision.code).toBe('CONFLICT');
    } finally {
      await intruderApi.dispose();
    }
  });
});
