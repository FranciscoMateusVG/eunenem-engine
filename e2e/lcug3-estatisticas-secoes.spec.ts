/**
 * aperture-lcug3 — Estatísticas em sub-seções (Funil / Vendas / Listas /
 * Financeiro / Tráfego / Saúde & erros). Navegação entre abas, período 3/6/12 preservado na URL e
 * renderização de cada seção, em desktop e em celular.
 *
 * Read-only: só lê telas de admin. O banco de CI pode ter qualquer volume de
 * usuários, então o spec confere estrutura (abas, barras, período), não
 * contagens; os números são cobertos pelo pxmdy, pelos testes de unidade e
 * pelos testes de integração de admin.analytics.
 */
import { expect, test } from './fixtures.js';

const SECOES = [
  { tab: 'Funil', path: '/admin/estatisticas' },
  { tab: 'Vendas', path: '/admin/estatisticas/vendas' },
  { tab: 'Listas', path: '/admin/estatisticas/listas' },
  { tab: 'Financeiro', path: '/admin/estatisticas/financeiro' },
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
    await expect(page.getByTestId('funil-etapa')).toHaveCount(4);
    await expect(page.getByTestId('funil-mes')).toHaveCount(3);
    await expect(page.getByTestId('funil-origem')).toHaveCount(5);
    await select.selectOption('6');
    await expect(page).toHaveURL(/\/admin\/estatisticas\?meses=6$/);
    await expect(page.getByTestId('estatisticas-mes')).toHaveCount(6);
    await expect(page.getByTestId('funil-mes')).toHaveCount(6);
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
      if (secao.tab === 'Listas') {
        await expect(page.getByTestId('listas-kpi').first()).toBeVisible();
        await expect(page.getByTestId('listas-janela')).toHaveCount(3);
        await expect(page.getByTestId('listas-risco')).toHaveCount(3);
        await expect(page.getByTestId('listas-curva')).toHaveCount(38);
        // Cada bloco com dado parcial mostra a nota de cobertura do servidor.
        expect(await page.getByTestId('cobertura-nota').count()).toBeGreaterThanOrEqual(6);
        await page.screenshot({
          path: testInfo.outputPath(`lcug3-listas-${width}.png`),
          fullPage: true,
        });
      }
      if (secao.tab === 'Financeiro') {
        await expect(page.getByTestId('financeiro-kpi').first()).toBeVisible();
        await expect(page.getByTestId('financeiro-exposicao')).toHaveCount(7);
        await expect(page.getByText('não medido').first()).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`lcug3-financeiro-${width}.png`),
          fullPage: true,
        });
      }
      if (secao.tab === 'Saúde & erros') {
        await expect(page.getByTestId('saude-categoria')).toHaveCount(4);
        await expect(page.getByTestId('saude-mes')).toHaveCount(6);
        await expect(
          page.getByTestId('saude-recente').or(page.getByTestId('saude-sem-erros')).first(),
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`lcug3-saude-${width}.png`),
          fullPage: true,
        });
      }
      if (secao.tab === 'Tráfego') {
        // Sem credencial de Mixpanel (CI/local) a seção explica o motivo em vez de zeros.
        await expect(
          page.getByTestId('trafego-indisponivel').or(page.getByTestId('trafego-mes').first()),
        ).toBeVisible();
        await expect(page.getByTestId('trafego-aviso')).toBeVisible();
      }
      if (secao.tab === 'Vendas') {
        await expect(page.getByTestId('vendas-kpi')).toHaveCount(7);
        await expect(page.getByTestId('vendas-mes')).toHaveCount(6);
        await expect(page.getByTestId('vendas-pix-mes')).toHaveCount(6);
        await page.screenshot({
          path: testInfo.outputPath(`lcug3-vendas-${width}.png`),
          fullPage: true,
        });
      }
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
