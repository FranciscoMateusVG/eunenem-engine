import { sql } from 'kysely';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedMultiItemApprovedPagamento } from './seed-helpers.js';
import { classifyTarget } from './target-classifier.js';

test.skip(
  !classifyTarget(process.env.E2E_BASE_URL).isLocal,
  'Settings fixtures run only against local test infrastructure.',
);

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';
test('painel compacto, navegação, privacidade, e-mail e solicitação segura de exclusão', async ({
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
    for (const name of ['Presentes recebidos', 'Novos recados', 'Confirmações de presença']) {
      const toggle = page.getByRole('switch', { name, exact: true });
      await expect(toggle).toBeEnabled();
      const saved = page.waitForResponse(
        (response) =>
          response.url().includes('configuracoes.emails') && response.request().method() === 'POST',
      );
      await toggle.click();
      await saved;
      await expect(toggle).toBeEnabled();
      await page.reload();
      await expect(toggle).not.toBeChecked();
    }
    await page.route('**/api/trpc/configuracoes.emails*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            error: {
              message: 'Falha simulada de gravação',
              code: -32603,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          },
        ]),
      }),
    );
    await page.getByRole('switch', { name: 'Novos recados', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Falha simulada');
    await expect(
      page.getByRole('switch', { name: 'Novos recados', exact: true }),
    ).not.toBeChecked();
    await page.unroute('**/api/trpc/configuracoes.emails*');
    const privacy = page.getByRole('switch', { name: 'Exibir recados publicamente' });
    const privacySaved = page.waitForResponse(
      (response) =>
        response.url().includes('configuracoes.privacidade') &&
        response.request().method() === 'POST',
    );
    await privacy.click();
    await privacySaved;
    await expect(privacy).toBeEnabled();
    await page.reload();
    await expect(privacy).not.toBeChecked();
    // Synthetic approved payment with an old, UNMODERATED message stays private.
    const seeded = await seedMultiItemApprovedPagamento(buildSeedGiftRepos(db), {
      idCampanha: seededData.idCampanha,
      idOpcaoPresentes: seededData.idOpcaoPresentes,
      items: [{ nome: 'Presente de teste', valorCents: 1000, quantidade: 1 }],
    });
    await sql`UPDATE pagamentos SET intencao_contribuinte_nome='Convidada Teste',intencao_contribuinte_email='guest@example.invalid',intencao_contribuinte_mensagem='Recado aguardando aprovação' WHERE id=${seeded.pagamentoId}`.execute(
      db,
    );
    await privacy.click();
    await expect(privacy).toBeEnabled();
    const publicInput = encodeURIComponent(
      JSON.stringify({ slug: seededData.slug, idCampanha: seededData.idCampanha }),
    );
    const mural = async () =>
      (await (await page.request.get(`/api/trpc/pagina.obterMural?input=${publicInput}`)).json())
        .result.data;
    await expect.poll(mural).toEqual([]);
    await page.goto(`${base}/mensagens`);
    await page.getByRole('button', { name: 'Aprovar para publicar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Ocultar recado', exact: true })).toBeVisible();
    await expect.poll(mural).toHaveLength(1);
    await page.goto(`${base}/configuracoes`);
    await page.getByRole('switch', { name: 'Exibir recados publicamente' }).click();
    await expect(
      page.getByRole('switch', { name: 'Exibir recados publicamente' }),
    ).not.toBeChecked();
    await expect(page.getByRole('switch', { name: 'Exibir recados publicamente' })).toBeEnabled();
    await expect.poll(mural).toEqual([]);
    await page.getByRole('switch', { name: 'Exibir recados publicamente' }).click();
    await expect(page.getByRole('switch', { name: 'Exibir recados publicamente' })).toBeEnabled();
    await expect.poll(mural).toHaveLength(1);
    await page.goto(`${base}/mensagens`);
    await page.getByRole('button', { name: 'Ocultar recado', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Aprovar para publicar', exact: true }),
    ).toBeVisible();
    await expect.poll(mural).toEqual([]);
    await page.goto(`${base}/configuracoes`);
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
    await page.getByRole('button', { name: 'Excluir minha conta', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirmar solicitação' })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect(
      (
        await sql`SELECT 1 FROM solicitacoes_exclusao_conta WHERE usuario_id=${seededData.session.userId}`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(0);
    await page.getByRole('button', { name: 'Excluir minha conta', exact: true }).click();
    await page.getByRole('checkbox', { name: /Entendo as consequências/ }).check();
    await page.getByRole('button', { name: 'Confirmar solicitação' }).click();
    await expect(page.getByText(/Solicitação registrada para análise/)).toBeVisible();
    const requests = await sql<{
      estado: string;
      verificacoes: {
        exclusaoAutomatica: boolean;
        eventosFuturosOuSemData: string;
        requerAnaliseFinanceira: boolean;
      };
    }>`SELECT estado,verificacoes FROM solicitacoes_exclusao_conta WHERE usuario_id=${seededData.session.userId}`.execute(
      db,
    );
    expect(requests.rows[0]?.estado).toBe('em_analise');
    expect(requests.rows[0]?.verificacoes.exclusaoAutomatica).toBe(false);
    expect(Number(requests.rows[0]?.verificacoes.eventosFuturosOuSemData)).toBeGreaterThan(0);
    expect(requests.rows[0]?.verificacoes.requerAnaliseFinanceira).toBe(true);
    await page.reload();
    await expect(page.getByText(/Solicitação registrada para análise/)).toBeVisible();
    const repeat = await page.request.post('/api/trpc/configuracoes.solicitarExclusao', {
      data: { confirmacao: 'SOLICITAR EXCLUSAO' },
    });
    expect(repeat.status()).toBe(200);
    expect(
      (
        await sql`SELECT 1 FROM solicitacoes_exclusao_conta WHERE usuario_id=${seededData.session.userId}`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(1);

    expect(
      (
        await db
          .selectFrom('usuarios')
          .select('desativado_em')
          .where('id', '=', seededData.session.userId)
          .executeTakeFirst()
      )?.desativado_em,
    ).toBeNull();
    // A stale session can neither bypass confirmation nor create a second request.
    await sql`UPDATE sessions SET created_at=now()-interval '1 hour' WHERE user_id=${seededData.session.userId}`.execute(
      db,
    );
    const response = await page.request.post('/api/trpc/configuracoes.solicitarExclusao', {
      data: { confirmacao: 'SOLICITAR EXCLUSAO' },
    });
    expect(response.status()).toBe(401);
  } finally {
    await db.destroy();
  }
});
