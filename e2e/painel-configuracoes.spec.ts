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
test('painel compacto e configurações sem novas dependências de banco', async ({
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
    await expect(page.getByRole('link', { name: /Configurações/ })).toBeVisible();
    await expect(page.locator('.painel-top-strip-line')).toContainText('dias');
    await expect(page.locator('.painel-url-date')).not.toBeEmpty();
    await expect(page.locator('#painel-group-conta').getByRole('link')).toHaveCount(5);
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
    await page.getByRole('link', { name: /Configurações/ }).click();
    await expect(page.getByRole('heading', { name: 'Configurações', exact: true })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Gerenciar acessos', exact: true }),
    ).toHaveAttribute('href', `${base}/compartilhar`);
    for (const name of [
      'Exibir recados publicamente',
      'Presentes recebidos',
      'Novos recados',
      'Confirmações de presença',
    ]) {
      await expect(page.getByRole('switch', { name, exact: true })).toBeDisabled();
    }
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
    await expect(page.getByRole('button', { name: 'Falar com o atendimento' })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Excluir minha conta', exact: true }).click();
    await page.getByRole('checkbox', { name: /Entendo e quero conversar/ }).check();
    await expect(page.getByRole('link', { name: 'Falar com o atendimento' })).toHaveAttribute(
      'href',
      /wa.me/,
    );
    expect(
      (
        await db
          .selectFrom('usuarios')
          .select('desativado_em')
          .where('id', '=', seededData.session.userId)
          .executeTakeFirst()
      )?.desativado_em,
    ).toBeNull();
  } finally {
    await db.destroy();
  }
});
