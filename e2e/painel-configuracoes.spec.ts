import { sql } from 'kysely';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { classifyTarget } from './target-classifier.js';

test.skip(
  !classifyTarget(process.env.E2E_BASE_URL).isLocal,
  'Settings fixtures run only against local test infrastructure.',
);

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';
test('painel compacto e configurações ligadas ao backend', async ({
  authenticatedPage: page,
  seededData,
}) => {
  const base = `/painel/${seededData.slug}/c/${seededData.idCampanha}`;
  const db = createDatabase(databaseUrl);
  try {
    await sql`UPDATE usuarios SET onboarding_concluido_em=now(),tutorial_completado_em=now() WHERE id=${seededData.session.userId}`.execute(
      db,
    );
    await sql`INSERT INTO perfil_campanhas(id,id_campanha,nome_bebe) VALUES(gen_random_uuid(),${seededData.idCampanha},'Helena') ON CONFLICT(id_campanha) DO UPDATE SET nome_bebe='Helena'`.execute(
      db,
    );
    await sql`INSERT INTO eventos(id,id_campanha,tipo_evento,modalidade,data_hora) VALUES(gen_random_uuid(),${seededData.idCampanha},'cha-bebe','online',now()+interval '7 days') ON CONFLICT(id_campanha) DO UPDATE SET data_hora=EXCLUDED.data_hora`.execute(
      db,
    );
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as unknown as { copied: string }).copied = value;
          },
        },
      });
    });
    await page.goto(base);
    await expect(page.getByRole('link', { name: /configurações/i })).toBeVisible();
    await expect(page.locator('.painel-top-strip-line')).toContainText('dias');
    await expect(page.locator('.painel-url-date')).not.toBeEmpty();
    await expect(page.locator('#painel-group-conta').getByRole('link')).toHaveCount(5);
    await expect(page.locator('#painel-group-conta .painel-row-label')).toHaveText([
      'editar meu perfil',
      'personalizar página',
      'configurações',
      'dados bancários',
      'fale com a gente',
    ]);
    await expect(
      page.locator('#painel-group-conta').getByRole('link', { name: /^compartilhar/i }),
    ).toHaveCount(0);
    await expect(
      page.locator('#painel-group-conta').getByRole('link', { name: /^Taxas e prazos/ }),
    ).toHaveCount(0);
    for (const width of [320, 375, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const fontSizes = await page.locator('.painel-menu-compact').evaluate((menu) => {
        const giftLabel = menu.querySelector(
          '[data-tutorial-target="presentes"] .painel-row-label',
        );
        const listLabel = menu.querySelector('[data-tutorial-target="lista"] .painel-row-label');
        return [
          giftLabel && getComputedStyle(giftLabel).fontSize,
          listLabel && getComputedStyle(listLabel).fontSize,
        ];
      });
      expect(fontSizes[0]).toBeTruthy();
      expect(fontSizes[0]).toBe(fontSizes[1]);
      await page.screenshot({
        path: `test-results/configuracoes-width-${width}-${page.url().includes('configuracoes') ? 'settings' : 'dashboard'}.png`,
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Copiar link', exact: true }).click();
    await expect(page.getByText('link copiado ♡', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toContain(
      `/pagina/${seededData.slug}`,
    );
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async ({ url }: { url: string }) => {
          (window as unknown as { shared: string }).shared = url;
        },
      });
    });
    await page.getByRole('button', { name: 'Compartilhar', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { shared: string }).shared))
      .toContain(`/pagina/${seededData.slug}`);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      (window as unknown as { copied: string }).copied = '';
    });
    await page.getByRole('button', { name: 'Compartilhar', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied))
      .toContain(`/pagina/${seededData.slug}`);
    await page.getByRole('link', { name: /configurações/i }).click();
    await expect(page.getByRole('heading', { name: 'Configurações', exact: true })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Gerenciar acessos', exact: true }),
    ).toHaveAttribute('href', `${base}/compartilhar`);
    // aperture-851nu: every e-mail switch and recados privacy are live.
    const novosRecados = page.getByRole('switch', { name: 'Novos recados', exact: true });
    const presencas = page.getByRole('switch', { name: 'Confirmações de presença', exact: true });
    for (const toggle of [novosRecados, presencas]) {
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
    }
    await presencas.click();
    await expect(presencas).not.toBeChecked();
    await expect(presencas).toBeEnabled();
    const presentes = page.getByRole('switch', { name: 'Presentes recebidos', exact: true });
    const recados = page.getByRole('switch', { name: 'Exibir recados publicamente', exact: true });
    await expect(presentes).toBeEnabled();
    await expect(presentes).toBeChecked();
    await presentes.click();
    await expect(presentes).not.toBeChecked();
    await expect(presentes).toBeEnabled();
    await expect(recados).toBeEnabled();
    await expect(recados).toBeChecked();
    await recados.click();
    await expect(recados).not.toBeChecked();
    await expect(recados).toBeEnabled();
    await page.reload();
    await expect(presentes).not.toBeChecked();
    await expect(recados).not.toBeChecked();
    await expect(presencas).not.toBeChecked();
    await expect(novosRecados).toBeChecked();
    expect(
      (
        await sql<{
          type: string;
          enabled: boolean;
        }>`SELECT type,enabled FROM lifecycle_email_preferences WHERE user_id=${seededData.session.userId} ORDER BY type`.execute(
          db,
        )
      ).rows,
    ).toEqual([
      { type: 'payment_received', enabled: false },
      { type: 'presence_confirmed', enabled: false },
    ]);
    expect(
      (
        await sql<{
          exibir_recados: boolean;
        }>`SELECT exibir_recados FROM campanha_privacidade WHERE campanha_id=${seededData.idCampanha}`.execute(
          db,
        )
      ).rows[0]?.exibir_recados,
    ).toBe(false);
    // Public page: the whole mural section and its nav chip disappear.
    const muralCarregado = page.waitForResponse((r) => r.url().includes('pagina.obterMural'));
    await page.goto(`/pagina/${seededData.slug}/c/${seededData.idCampanha}`);
    await muralCarregado;
    await expect(page.locator('#mural')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Mural', exact: true })).toHaveCount(0);
    await page.goto(`${base}/configuracoes`);
    for (const width of [320, 375, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.getByRole('link', { name: 'Gerenciar acessos', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/compartilhar$`));
    await page.goto(`${base}/configuracoes`);
    await page.getByRole('button', { name: 'Excluir minha conta', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('link', { name: 'atendimento' })).toHaveAttribute('href', /wa.me/);
    await expect(page.getByRole('button', { name: 'Desativar minha conta' })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const desativadoEm = async () =>
      (
        await db
          .selectFrom('usuarios')
          .select('desativado_em')
          .where('id', '=', seededData.session.userId)
          .executeTakeFirst()
      )?.desativado_em;
    expect(await desativadoEm()).toBeNull();
    await page.getByRole('button', { name: 'Excluir minha conta', exact: true }).click();
    await page.getByRole('checkbox', { name: /Entendo e quero desativar/ }).check();
    await page.getByRole('button', { name: 'Desativar minha conta' }).click();
    await expect(page.getByText('Sua conta foi desativada')).toBeVisible();
    expect(await desativadoEm()).not.toBeNull();
    await page.waitForURL((url) => url.pathname === '/');
  } finally {
    await db.destroy();
  }
});
