/**
 * aperture-lcug3 — Estatísticas em sub-seções (Funil / Vendas / Tráfego /
 * Saúde & erros). Navegação entre abas, período 3/6/12 preservado na URL e
 * renderização de cada seção, em desktop e em celular.
 *
 * Read-only: só lê telas de admin. O banco de CI pode ter qualquer volume de
 * usuários, então o spec confere estrutura (abas, barras, período), não
 * contagens; os números são cobertos pelo pxmdy e pelos testes de unidade.
 */
import { expect, test } from './fixtures.js';

const SECOES = [
  { tab: 'Funil', path: '/admin/estatisticas' },
  { tab: 'Vendas', path: '/admin/estatisticas/vendas' },
  { tab: 'Tráfego', path: '/admin/estatisticas/trafego' },
  { tab: 'Saúde & erros', path: '/admin/estatisticas/saude' },
] as const;

for (const width of [1280, 375]) {
  test(`lcug3: abas de estatísticas navegam e preservam o período (${width}px)`, async ({
    adminAuthenticatedPage: page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/admin/estatisticas');
    await expect(page.getByRole('heading', { name: 'Estatísticas', exact: true })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Seções de estatísticas' });
    await expect(nav.getByRole('link')).toHaveText(SECOES.map((s) => s.tab));
    await expect(nav.getByRole('link', { name: 'Funil' })).toHaveAttribute('aria-current', 'page');

    // Funil: total + gráfico mensal controlado pelo seletor.
    await expect(page.getByTestId('estatisticas-total')).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Período mensal' });
    await expect(select).toHaveValue('3');
    await expect(page.getByTestId('estatisticas-mes')).toHaveCount(3);
    await select.selectOption('6');
    await expect(page).toHaveURL(/\/admin\/estatisticas\?meses=6$/);
    await expect(page.getByTestId('estatisticas-mes')).toHaveCount(6);
    await page.screenshot({
      path: testInfo.outputPath(`lcug3-funil-${width}.png`),
      fullPage: true,
    });

    // As demais abas recebem o período escolhido.
    for (const secao of SECOES.slice(1)) {
      await nav.getByRole('link', { name: secao.tab }).click();
      await expect(page).toHaveURL(new RegExp(`${secao.path}\\?meses=6$`));
      await expect(nav.getByRole('link', { name: secao.tab })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.getByRole('heading', { name: secao.tab, exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Período mensal' })).toHaveValue('6');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }

    // Voltar ao Funil pela aba mantém 6 meses.
    await nav.getByRole('link', { name: 'Funil' }).click();
    await expect(page).toHaveURL(/\/admin\/estatisticas\?meses=6$/);
    await expect(page.getByTestId('estatisticas-mes')).toHaveCount(6);
  });
}
