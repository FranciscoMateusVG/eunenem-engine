/**
 * aperture-1z18g — the painel UI hides what a shared-campanha MEMBER can't do,
 * and shows it as soon as the owner grants it (no re-login: the next request
 * reads fresh permissions). Server-side enforcement is covered by
 * tests/integration/campanha-permissoes-router.postgres.test.ts; this spec
 * proves the browser surfaces follow it.
 *
 * Shape: the gate-walker VICTIM owns campanha A; the INTRUDER is added to A as
 * a 'membro' directly in the DB (the invite flow lives in the sharing branch).
 * The membership is removed in afterAll so cross-user-denial keeps seeing the
 * intruder as an outsider (workers: 1, so no overlap).
 *
 * RUN:
 *   E2E_GATE_EMAIL=e2e-gate-walker@e2e.local \
 *   pnpm test:e2e e2e/1z18g-member-permissions-ui.spec.ts
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { sql } from 'kysely';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import {
  type IntruderSeed,
  resolveVictimCampanhaA,
  seedGateWalker,
  seedIntruderWalker,
  type VictimCampanhaA,
} from './gate-fixtures.js';
import { browserCookieFor } from './magic-link-auth.js';

const GATE_EMAIL = process.env.E2E_GATE_EMAIL;
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame';

test.describe('member permissions in the painel UI (aperture-1z18g)', () => {
  test.skip(!GATE_EMAIL, 'E2E_GATE_EMAIL not set — gate-walker creds live in env/mempalace');

  let db: Database;
  let intruder: IntruderSeed;
  let victimA: VictimCampanhaA;
  let idContaIntruder: string;
  let context: BrowserContext;

  async function conceder(permissoes: string[]) {
    await sql`
      UPDATE campanha_membros_permissoes
      SET permissoes = ${permissoes}::text[], atualizado_em = now()
      WHERE campanha_id = ${victimA.idCampanha}::uuid AND id_conta = ${idContaIntruder}::uuid
    `.execute(db);
  }

  async function abrir(secao: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`/painel/${intruder.slug}/c/${victimA.idCampanha}/${secao}`);
    return page;
  }

  test.beforeAll(async ({ browser, baseURL }) => {
    await seedGateWalker(baseURL);
    intruder = (await seedIntruderWalker(baseURL)) as IntruderSeed;
    victimA = (await resolveVictimCampanhaA()) as VictimCampanhaA;
    expect(intruder, 'intruder seed').toBeTruthy();
    expect(victimA, 'victim campanha A').toBeTruthy();

    db = createDatabase(DATABASE_URL);
    const conta = await db
      .selectFrom('usuarios')
      .select(['id_conta', 'id'])
      .where('email', '=', intruder.email)
      .executeTakeFirstOrThrow();
    idContaIntruder = conta.id_conta;
    await db
      .updateTable('usuarios')
      .set({ onboarding_concluido_em: new Date() })
      .where('id', '=', conta.id)
      .where('onboarding_concluido_em', 'is', null)
      .execute();
    await db
      .insertInto('campanha_administradores')
      .values({ campanha_id: victimA.idCampanha, id_usuario: idContaIntruder })
      .onConflict((oc) => oc.columns(['campanha_id', 'id_usuario']).doNothing())
      .execute();
    await sql`
      INSERT INTO campanha_membros_permissoes (campanha_id, id_conta, papel, permissoes)
      VALUES (${victimA.idCampanha}::uuid, ${idContaIntruder}::uuid, 'membro', '{}')
      ON CONFLICT (campanha_id, id_conta) DO UPDATE SET papel = 'membro', permissoes = '{}'
    `.execute(db);

    context = await browser.newContext();
    await context.addCookies([browserCookieFor(intruder.session, baseURL)]);
    await context.addInitScript(
      ([key]) => window.localStorage.setItem(key, '1'),
      [CAMPANHAS_WELCOME_STORAGE_KEY],
    );
  });

  test.afterAll(async () => {
    await context?.close();
    if (db && victimA && idContaIntruder) {
      await db
        .deleteFrom('campanha_membros_permissoes')
        .where('campanha_id', '=', victimA.idCampanha)
        .where('id_conta', '=', idContaIntruder)
        .execute();
      await db
        .deleteFrom('campanha_administradores')
        .where('campanha_id', '=', victimA.idCampanha)
        .where('id_usuario', '=', idContaIntruder)
        .execute();
    }
    await db?.destroy();
  });

  test('without grants: bank data, statement, invite and messages show the no-permission card', async () => {
    await conceder([]);
    for (const secao of [
      'bancarios',
      'presentes',
      'convite',
      'mensagens',
      'convidados',
      'perfil',
    ]) {
      const page = await abrir(secao);
      await expect(page.getByTestId('sem-permissao'), `${secao} must be gated`).toBeVisible();
      await page.close();
    }
  });

  test('gift list is read-only without presentes:gerenciar and editable once granted', async () => {
    await conceder([]);
    let page = await abrir('lista');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Adicionar presente/ })).toHaveCount(0);
    await expect(page.getByTestId('gift-edit-btn')).toHaveCount(0);
    await page.close();

    await conceder(['presentes:gerenciar']);
    page = await abrir('lista');
    await expect(
      page.getByRole('button', { name: /Adicionar presente|Adicionar primeiro item/ }).first(),
    ).toBeVisible();
    await page.close();
  });

  test('statement visible with extrato:ver, but the transfer CTA needs saque:solicitar', async () => {
    await conceder(['extrato:ver']);
    let page = await abrir('presentes');
    await expect(page.getByTestId('sem-permissao')).toHaveCount(0);
    await expect(page.getByText('extrato detalhado')).toBeVisible();
    await expect(page.getByRole('button', { name: /solicitar transferência/ })).toHaveCount(0);
    await page.close();

    await conceder(['extrato:ver', 'saque:solicitar']);
    page = await abrir('presentes');
    await expect(page.getByRole('button', { name: /solicitar transferência/ })).toBeVisible();
    await page.close();
  });

  test('bank data page opens once recebedor:gerenciar is granted', async () => {
    await conceder(['recebedor:gerenciar']);
    const page = await abrir('bancarios');
    await expect(page.getByTestId('sem-permissao')).toHaveCount(0);
    await expect(page.getByText('Dados Bancários').first()).toBeVisible();
    await page.close();
  });
});
