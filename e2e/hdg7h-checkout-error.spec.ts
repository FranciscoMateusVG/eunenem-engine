import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';

for (const surface of ['cart', 'gift'] as const) {
  test(`${surface}: local storage replaces old banner; cooldown disables and retry calls HTTP`, async ({
    page,
    seededData,
  }) => {
    await page.route('**/api/trpc/*obterConfigCheckout*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const paths = new URL(route.request().url()).pathname.split('/').pop()?.split(',') ?? [];
      const index = paths.indexOf('pagina.obterConfigCheckout');
      if (index >= 0 && Array.isArray(body)) body[index] = { result: { data: { pixViaQr: true } } };
      await route.fulfill({ response, json: body });
    });
    const procedure =
      surface === 'cart' ? 'iniciarPagamentoCarrinho' : 'iniciarPagamentoContribuicao';
    const storageKey = `eunenem:checkout:pending:${surface === 'cart' ? 'cart' : 'contribution'}`;
    let requests = 0;
    await page.route(`**/api/trpc/*${procedure}*`, async (route) => {
      requests++;
      if (requests === 1)
        return route.fulfill({
          status: 409,
          json: [
            {
              error: {
                message: 'Operação indisponível',
                code: -32009,
                data: {
                  code: 'CONFLICT',
                  httpStatus: 409,
                  path: 'pagina.iniciarPagamentoCarrinho',
                },
              },
            },
          ],
        });
      return route.fulfill({ json: [{ result: { data: { tipo: 'retry_new_operation' } } }] });
    });
    await page.goto(`/pagina/${seededData.slug}`);
    await page
      .locator('article')
      .filter({ hasText: seededData.nomeContribuicao })
      .getByRole('button', { name: /\+ Adicionar/i })
      .click();
    const dialog = page.getByRole('dialog');
    if (surface === 'cart') {
      await dialog.getByRole('button', { name: /Finalizar compra/i }).click();
    } else {
      await dialog.getByRole('button', { name: 'Fechar carrinho' }).click();
      await page
        .locator('article')
        .filter({ hasText: seededData.nomeContribuicao })
        .getByRole('button', { name: /ou comprar agora/ })
        .click();
      await dialog.getByRole('radio', { name: /^Pix/ }).click();
      await dialog.getByRole('button', { name: 'Continuar →' }).click();
    }
    await dialog.getByLabel(/nome/i).fill('Visitante sintético');
    await dialog.getByLabel(/email/i).fill('visitor@example.test');
    const submit = dialog.locator('button[type=submit]');
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText('Operação indisponível');
    await page.evaluate((key) => sessionStorage.setItem(key, 'invalid-id'), storageKey);
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText('armazenamento');
    expect(requests).toBe(1);
    await page.evaluate((key) => sessionStorage.removeItem(key), storageKey);
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText(/Aguarde [1-5] s/);
    await expect(submit).toBeDisabled();
    expect(requests).toBe(2);
    await expect(submit).toBeEnabled({ timeout: 7000 });
    await submit.click();
    await expect.poll(() => requests).toBe(3);
  });
}

// This reproduces one possible pre-claim failure, NOT the historical incident.
test('oversized cookie rejects before operation creation in real HTTP + PG', async ({
  request,
  seededData,
  baseURL,
}) => {
  const operationId = randomUUID();
  const response = await request.post('/api/trpc/pagina.iniciarPagamentoCarrinho', {
    headers: {
      origin: baseURL ?? 'http://localhost:3002',
      cookie: `unrelated=${'x'.repeat(8192)}`,
    },
    data: {
      operationId,
      slug: seededData.slug,
      metodo: 'pix',
      itens: [{ idContribuicao: seededData.idContribuicao, quantidade: 1 }],
      contribuinte: { nome: 'Visitante', email: 'visitor@example.test' },
    },
  });
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { message: 'Operação indisponível', data: { code: 'CONFLICT' } },
  });
  const db = createDatabase(
    process.env.E2E_DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame',
  );
  try {
    expect(
      await db
        .selectFrom('payment_provider_operations')
        .select('operation_id')
        .where('operation_id', '=', operationId)
        .execute(),
    ).toEqual([]);
  } finally {
    await db.destroy();
  }
});
