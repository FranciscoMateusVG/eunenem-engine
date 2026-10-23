/**
 * aperture-851nu — Configurações do painel, pela composição real do servidor:
 * login por magic link (BetterAuth real) → appRouter → Postgres.
 *
 *   1. `configuracoes.get/emails` — toggle "Presentes recebidos" grava a
 *      preferência `payment_received` que o envio já respeita.
 *   2. `configuracoes.privacidade` — "Exibir recados publicamente": exige
 *      `mensagens:gerenciar`; desligado, o mural público fica vazio e o painel
 *      continua mostrando as mensagens.
 *   4. `usuario.desativarConta` — soft delete com sessão recente, bloqueio por
 *      saldo/repasse pendente, revogação de sessões, login bloqueado e
 *      campanhas sem owner ativo fora do ar.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildServerDeps,
  loadEnv,
  type ServerDeps,
} from '../../apps/eunenem-server/server/auth/setup.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { LifecycleEmailPreferencesPostgres } from '../../src/adapters/email/lifecycle-email-preferences.postgres.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const SECRET = 'test-secret-at-least-thirty-two-characters-long';
const ORIGIN = 'http://localhost:3001';

let testDb: TestDatabase;
let deps: ServerDeps;
let seed: ReceitaLedgerSeed;
const magicLinks: string[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  deps = buildServerDeps(
    loadEnv({
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: ORIGIN,
      TRUSTED_ORIGINS: ORIGIN,
      DATABASE_URL: testDb.connectionUri,
      NODE_ENV: 'test',
      LEGACY_SITE_ORIGIN: 'https://eunenem.com',
    }),
  );
  seed = new ReceitaLedgerSeed(deps.db);
}, 180_000);

afterAll(async () => {
  await deps?.db.destroy();
  await testDb?.teardown();
});

function authReal() {
  return criarAuth(deps.db, {
    secret: SECRET,
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
    sendMagicLink: async (message) => {
      magicLinks.push(message.url);
    },
  });
}

async function pedirLink(email: string): Promise<string | undefined> {
  const before = magicLinks.length;
  await authReal().api.signInMagicLink({
    body: { email, callbackURL: '/' },
    headers: new Headers({ origin: ORIGIN }),
  });
  return magicLinks.length > before ? magicLinks[magicLinks.length - 1] : undefined;
}

async function cookieDoLink(url: string): Promise<string> {
  const response = await authReal().handler(new Request(url));
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

function caller(cookie: string) {
  return appRouter.createCaller({
    deps: { ...deps, auth: authReal() },
    headers: new Headers({ cookie }),
    resHeaders: new Headers(),
  });
}

async function login(email = `cfg-${randomUUID()}@example.com`) {
  const url = await pedirLink(email);
  if (!url) throw new Error('magic link não enviado');
  const cookie = await cookieDoLink(url);
  expect(cookie).toContain('session_token');
  const c = caller(cookie);
  expect(await c.auth.me()).not.toBeNull();
  const user = await deps.db
    .selectFrom('usuarios')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirstOrThrow();
  const { campanha_id: idCampanha } = await deps.db
    .selectFrom('campanha_membros_permissoes')
    .select('campanha_id')
    .where('id_conta', '=', user.id_conta)
    .where('papel', '=', 'owner')
    .executeTakeFirstOrThrow();
  return { caller: c, cookie, user, email, idCampanha };
}

async function recado(idCampanha: string, mensagem = 'Felicidades!') {
  const { idPagamento } = await seed.pagamento({
    campaignId: idCampanha,
    taxaCents: 100,
    criadoEm: new Date(),
  });
  await sql`UPDATE pagamentos SET intencao_contribuinte_nome='Tia Ana',
    intencao_contribuinte_email='tia@example.com', intencao_contribuinte_mensagem=${mensagem}
    WHERE id=${idPagamento}`.execute(deps.db);
  return idPagamento;
}

/** Marca todo o saldo da campanha como já sacado (sem pendência financeira). */
async function quitarSaldo(idCampanha: string) {
  await sql`UPDATE lancamentos_financeiros SET transferido_em=now()
    WHERE id_campanha=${idCampanha} AND transferido_em IS NULL`.execute(deps.db);
}

async function adicionarCoOwner(idCampanha: string, idConta: string) {
  await deps.campanhaRepository.adicionarAdministrador(idCampanha as never, idConta as never);
  await sql`UPDATE campanha_membros_permissoes SET papel='owner'
    WHERE campanha_id=${idCampanha} AND id_conta=${idConta}`.execute(deps.db);
}

describe('configuracoes.get / emails (Presentes recebidos)', () => {
  it('lê o padrão ligado e grava payment_received na preferência real', async () => {
    const owner = await login();
    const atual = await owner.caller.configuracoes.get({ idCampanha: owner.idCampanha });
    expect(atual.emails.presentes).toBe(true);
    expect(atual.exibirRecados).toBe(true);

    const salvo = await owner.caller.configuracoes.emails({
      idCampanha: owner.idCampanha,
      presentes: false,
    });
    expect(salvo.presentes).toBe(false);
    expect(
      (
        await new LifecycleEmailPreferencesPostgres(deps.db).getPreferences(
          owner.user.id,
          owner.user.id_plataforma,
        )
      ).payment_received,
    ).toBe(false);
    expect(
      (await owner.caller.configuracoes.get({ idCampanha: owner.idCampanha })).emails.presentes,
    ).toBe(false);
  });

  it('Novos recados e Confirmações de presença: ligados por padrão, gravados por usuário', async () => {
    const owner = await login();
    const coOwner = await login();
    await adicionarCoOwner(owner.idCampanha, coOwner.user.id_conta);
    const atual = await owner.caller.configuracoes.get({ idCampanha: owner.idCampanha });
    expect(atual.emails).toEqual({ presentes: true, recados: true, presencas: true });

    const salvo = await owner.caller.configuracoes.emails({
      idCampanha: owner.idCampanha,
      recados: false,
      presencas: false,
    });
    expect(salvo).toEqual({ presentes: true, recados: false, presencas: false });
    expect(
      await new LifecycleEmailPreferencesPostgres(deps.db).getPreferences(
        owner.user.id,
        owner.user.id_plataforma,
      ),
    ).toMatchObject({ payment_received: true, new_message: false, presence_confirmed: false });
    // The co-owner's own preference is untouched.
    expect(
      (await coOwner.caller.configuracoes.get({ idCampanha: owner.idCampanha })).emails,
    ).toEqual({ presentes: true, recados: true, presencas: true });
  });

  it('nega anônimo e campanha alheia', async () => {
    const owner = await login();
    const estranho = await login();
    await expect(
      caller('').configuracoes.get({ idCampanha: owner.idCampanha }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      estranho.caller.configuracoes.emails({ idCampanha: owner.idCampanha, presentes: false }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('configuracoes.privacidade (Exibir recados publicamente)', () => {
  it('desligado esconde os recados do mural público; painel continua vendo', async () => {
    const owner = await login();
    await recado(owner.idCampanha);
    const publico = () =>
      caller('').pagina.obterMural({ slug: owner.user.slug, idCampanha: owner.idCampanha });
    const ligado = await publico();
    expect(ligado.exibir).toBe(true);
    expect(ligado.recados.map((r) => r.mensagem)).toEqual(['Felicidades!']);

    await owner.caller.configuracoes.privacidade({
      idCampanha: owner.idCampanha,
      exibirRecados: false,
    });
    // Desligado: a página pública esconde a seção inteira, sem recados.
    expect(await publico()).toEqual({ exibir: false, recados: [] });
    // URL sem idCampanha (campanha padrão do slug) também respeita.
    expect(await caller('').pagina.obterMural({ slug: owner.user.slug })).toEqual({
      exibir: false,
      recados: [],
    });
    expect(
      (await owner.caller.configuracoes.get({ idCampanha: owner.idCampanha })).exibirRecados,
    ).toBe(false);
    const painel = await owner.caller.painelMensagens.list({
      slug: owner.user.slug,
      idCampanha: owner.idCampanha,
    });
    expect(JSON.stringify(painel)).toContain('Felicidades!');

    await owner.caller.configuracoes.privacidade({
      idCampanha: owner.idCampanha,
      exibirRecados: true,
    });
    expect((await publico()).recados).toHaveLength(1);
  });

  it('a preferência não impede excluir a campanha (cascade)', async () => {
    const owner = await login();
    const extra = await owner.caller.campanhas.criar({ titulo: 'Campanha extra' });
    await owner.caller.configuracoes.privacidade({ idCampanha: extra.id, exibirRecados: false });
    await deps.campanhaRepository.delete(extra.id as never);
    expect(
      await deps.db
        .selectFrom('campanha_privacidade')
        .select('campanha_id')
        .where('campanha_id', '=', extra.id)
        .execute(),
    ).toHaveLength(0);
  });

  it('exige mensagens:gerenciar; membro sem a permissão recebe FORBIDDEN', async () => {
    const owner = await login();
    const membro = await login();
    await deps.campanhaRepository.adicionarAdministrador(
      owner.idCampanha as never,
      membro.user.id_conta as never,
    );
    const definir = (permissoes: string[]) =>
      owner.caller.campanhaMembros.definirPermissoes({
        idCampanha: owner.idCampanha,
        idConta: membro.user.id_conta,
        permissoes: permissoes as never,
      });
    await definir(['mensagens:ver']);
    await expect(
      membro.caller.configuracoes.privacidade({
        idCampanha: owner.idCampanha,
        exibirRecados: false,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await owner.caller.configuracoes.get({ idCampanha: owner.idCampanha })).exibirRecados,
    ).toBe(true);

    await definir(['mensagens:ver', 'mensagens:gerenciar']);
    await membro.caller.configuracoes.privacidade({
      idCampanha: owner.idCampanha,
      exibirRecados: false,
    });
    expect(
      (await owner.caller.configuracoes.get({ idCampanha: owner.idCampanha })).exibirRecados,
    ).toBe(false);
  });
});

describe('usuario.desativarConta (soft delete)', () => {
  it('exige sessão recente do próprio usuário', async () => {
    const owner = await login();
    await sql`UPDATE sessions SET created_at = now() - interval '20 minutes'
      WHERE user_id=${owner.user.id}`.execute(deps.db);
    await expect(owner.caller.usuario.desativarConta()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: expect.stringContaining('entre novamente'),
    });
    const row = await deps.db
      .selectFrom('usuarios')
      .select('desativado_em')
      .where('id', '=', owner.user.id)
      .executeTakeFirstOrThrow();
    expect(row.desativado_em).toBeNull();
  });

  it('bloqueia com saldo a sacar e com repasse pendente, mostrando o motivo', async () => {
    const owner = await login();
    await recado(owner.idCampanha);
    await expect(owner.caller.usuario.desativarConta()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('saldo'),
    });

    await quitarSaldo(owner.idCampanha);
    const idRepasse = randomUUID();
    await sql`INSERT INTO repasses_recebedor(id,id_campanha,amount_cents,status,solicitado_em)
      VALUES(${idRepasse},${owner.idCampanha},1000,'solicitado',now())`.execute(deps.db);
    await expect(owner.caller.usuario.desativarConta()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('resgate'),
    });
    const row = await deps.db
      .selectFrom('usuarios')
      .select('desativado_em')
      .where('id', '=', owner.user.id)
      .executeTakeFirstOrThrow();
    expect(row.desativado_em).toBeNull();
  });

  it('desativa sem apagar dados, revoga todas as sessões e bloqueia novo login', async () => {
    const owner = await login();
    const outroDispositivo = await cookieDoLink((await pedirLink(owner.email)) as string);
    await recado(owner.idCampanha);
    await quitarSaldo(owner.idCampanha);

    const result = await owner.caller.usuario.desativarConta();
    expect(result.desativadoEm).toEqual(expect.any(String));

    const sessoes = await deps.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', owner.user.id)
      .execute();
    expect(sessoes).toHaveLength(0);
    expect(await caller(outroDispositivo).auth.me()).toBeNull();

    // Nada apagado: usuário, campanha e pagamentos continuam no banco.
    expect(
      await deps.db.selectFrom('usuarios').select('id').where('id', '=', owner.user.id).execute(),
    ).toHaveLength(1);
    expect(
      await deps.db
        .selectFrom('pagamentos')
        .select('id')
        .where('intencao_id_campanha', '=', owner.idCampanha)
        .execute(),
    ).toHaveLength(1);

    // Magic link novo não é enviado para conta desativada…
    expect(await pedirLink(owner.email)).toBeUndefined();
  });

  it('link emitido antes da desativação não cria sessão depois dela', async () => {
    const owner = await login();
    const linkAntigo = (await pedirLink(owner.email)) as string;
    await owner.caller.usuario.desativarConta();
    const cookie = await cookieDoLink(linkAntigo);
    expect(cookie).not.toContain('session_token=');
    const sessoes = await deps.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', owner.user.id)
      .execute();
    expect(sessoes).toHaveLength(0);
  });

  it('campanha de owner único sai do ar; com co-owner ativo continua pública', async () => {
    const sozinho = await login();
    await sozinho.caller.usuario.desativarConta();
    await expect(
      caller('').pagina.obterListaPresentes({ slug: sozinho.user.slug }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller('').pagina.obterMural({ slug: sozinho.user.slug, idCampanha: sozinho.idCampanha }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller('').perfil.getPerfilPublicoBySlug({ slug: sozinho.user.slug }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller('').eventoConvite.getPreview({ slug: sozinho.user.slug }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const titular = await login();
    const coOwner = await login();
    await adicionarCoOwner(titular.idCampanha, coOwner.user.id_conta);
    await titular.caller.usuario.desativarConta();
    // O link antigo (slug do titular) continua funcionando…
    await expect(
      caller('').pagina.obterListaPresentes({
        slug: titular.user.slug,
        idCampanha: titular.idCampanha,
      }),
    ).resolves.toBeTruthy();
    // …e o co-owner ativo também endereça a campanha.
    await expect(
      caller('').pagina.obterListaPresentes({
        slug: coOwner.user.slug,
        idCampanha: titular.idCampanha,
      }),
    ).resolves.toBeTruthy();
  });
});
