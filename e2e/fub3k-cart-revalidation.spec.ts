import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';

// Isolated runner only; fake PIX provider, never external money movement.
test.beforeEach(() => test.skip(!process.env.E2E_9BPRE_CONTAINER, 'Requires ephemeral runner'));

test('cart revalidates changed price on reopen and before PIX; displayed total equals charge', async ({
  page,
  seededData,
}) => {
  const uri = process.env.E2E_DATABASE_URL;
  if (!uri) throw new Error('Missing isolated database');
  const db = createDatabase(uri);
  const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
  try {
    await page.goto(`http://localhost:3004/pagina/${seededData.slug}`);
    await page
      .locator('article')
      .filter({ hasText: seededData.nomeContribuicao })
      .getByRole('button', { name: /\+ Adicionar/ })
      .click();
    await expect(drawer.getByRole('button', { name: /Finalizar compra/ })).toBeEnabled();
    await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
    await db
      .updateTable('contribuicoes')
      .set({ valor: 1000 })
      .where('id', '=', seededData.idContribuicao)
      .execute();
    await page.getByRole('button', { name: /Abrir carrinho/ }).click();
    await expect(drawer.getByRole('status')).toContainText('preço');
    await expect(drawer.getByTestId('cart-server-total')).toHaveText(/10,90/);
    await drawer.getByRole('button', { name: /Finalizar compra/ }).click();
    await drawer.getByPlaceholder('Ana & João').fill('Teste Preço');
    await drawer.getByPlaceholder('ana@email.com').fill('preco@example.test');
    // Change once more while the identity form is open. Do not charge silently.
    await db
      .updateTable('contribuicoes')
      .set({ valor: 2000 })
      .where('id', '=', seededData.idContribuicao)
      .execute();
    await drawer.getByRole('button', { name: 'continuar para o pix ♡' }).click();
    await expect(drawer.getByText('Seu carrinho')).toBeVisible();
    await expect(drawer.getByTestId('cart-server-total')).toHaveText(/21,80/);
    await drawer.getByRole('button', { name: /Finalizar compra/ }).click();
    const response = page.waitForResponse(
      async (res) =>
        res.url().includes('iniciarPagamentoCarrinho') &&
        !(await res.text()).includes('"tipo":"prepared"'),
    );
    await drawer.getByRole('button', { name: 'continuar para o pix ♡' }).click();
    const data = (await (await response).json())[0].result.data;
    expect(data.valorCents).toBe(2180);
    await expect(drawer.getByRole('heading', { name: /paga com pix.*21,80/ })).toBeVisible();
    await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
    await db
      .updateTable('contribuicoes')
      .set({ valor: 3000 })
      .where('id', '=', seededData.idContribuicao)
      .execute();
    await page.getByRole('button', { name: /Abrir carrinho/ }).click();
    await expect(drawer.getByText('Seu carrinho')).toBeVisible();
    await expect(drawer.getByRole('heading', { name: /paga com pix/ })).toHaveCount(0);
    await expect(drawer.getByTestId('cart-server-total')).toHaveText(/32,70/);
  } finally {
    await db.destroy();
  }
});

test('removed gift leaves the cart with a notice instead of starting checkout', async ({
  page,
  seededData,
}) => {
  const uri = process.env.E2E_DATABASE_URL;
  if (!uri) throw new Error('Missing isolated database');
  const db = createDatabase(uri);
  const drawer = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
  try {
    await page.goto(`http://localhost:3004/pagina/${seededData.slug}`);
    await page
      .locator('article')
      .filter({ hasText: seededData.nomeContribuicao })
      .getByRole('button', { name: /\+ Adicionar/ })
      .click();
    await expect(drawer.getByRole('button', { name: /Finalizar compra/ })).toBeEnabled();
    await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
    await new ContribuicaoRepositoryPostgres(db).deleteById(seededData.idContribuicao);
    const archived = await db
      .selectFrom('contribuicoes')
      .select('arquivada_em')
      .where('id', '=', seededData.idContribuicao)
      .executeTakeFirstOrThrow();
    expect(archived.arquivada_em).not.toBeNull();
    await page.getByRole('button', { name: /Abrir carrinho/ }).click();
    await expect(drawer.getByRole('status')).toContainText('saiu do carrinho');
    await expect(drawer.getByRole('button', { name: /Finalizar compra/ })).toHaveCount(0);
  } finally {
    await db.destroy();
  }
});
