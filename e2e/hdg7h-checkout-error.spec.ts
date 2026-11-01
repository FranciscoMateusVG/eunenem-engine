import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { classifyTarget } from './target-classifier.js';

test.skip(
  !classifyTarget(process.env.E2E_BASE_URL).isLocal,
  'Isolated local fake-provider stack only',
);

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

// Local fake PIX + real HTTP/PG: old browser capabilities cannot strand a new payment.
test('9hkc1: browser evicts expired capabilities and preserves a live QR', async ({
  page,
  seededData,
}) => {
  const origin = 'http://localhost:3004';
  await page.goto(`${origin}/pagina/${seededData.slug}`);
  const db = createDatabase(
    process.env.E2E_DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame',
  );
  const ids: string[] = [];
  const pay = async (operationId: string) =>
    page.evaluate(
      async ({ operationId, slug, idContribuicao }) => {
        const input = {
          operationId,
          slug,
          metodo: 'pix',
          itens: [{ idContribuicao, quantidade: 1 }],
          contribuinte: { nome: 'Synthetic Guest', email: 'guest@example.test' },
        };
        const post = async () => {
          const response = await fetch('/api/trpc/pagina.iniciarPagamentoCarrinho', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          });
          return { status: response.status, body: await response.json() };
        };
        const prepared = await post();
        if (prepared.body.result?.data?.tipo !== 'prepared') return prepared;
        return post();
      },
      { operationId, slug: seededData.slug, idContribuicao: seededData.idContribuicao },
    );
  try {
    for (let i = 0; i < 8; i++) {
      const id = randomUUID();
      ids.push(id);
      expect((await pay(id)).body).toMatchObject({ result: { data: { tipo: 'pix_qr' } } });
    }
    const liveId = ids[7];
    if (!liveId) throw new Error('fixture live id');
    await db
      .updateTable('payment_provider_operations')
      .set({ provider_expires_at: new Date(Date.now() - 60_000) })
      .where('operation_id', 'in', ids.slice(0, 7))
      .execute();
    // More than eight capability cookies, as left by earlier browser sessions.
    await page.context().addCookies([
      {
        name: `__Host-eunenem_checkout_${randomUUID()}`,
        value: 'A'.repeat(43),
        domain: 'localhost',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const nextId = randomUUID();
    const result = await pay(nextId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ result: { data: { tipo: 'pix_qr' } } });
    const cookies = (await page.context().cookies()).filter((cookie) =>
      cookie.name.startsWith('__Host-eunenem_checkout_'),
    );
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual(
      [liveId, nextId].map((id) => `__Host-eunenem_checkout_${id}`).sort(),
    );
    expect(
      await db
        .selectFrom('payment_provider_operations')
        .select(['state', 'local_committed_at'])
        .where('operation_id', '=', nextId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: 'local_committed' });
    // Resuming the valid QR still returns the same payment, not a fresh charge.
    expect((await pay(liveId)).body).toMatchObject({
      result: { data: { tipo: 'pix_qr', txid: liveId.replaceAll('-', '') } },
    });
  } finally {
    await db.destroy();
  }
});
