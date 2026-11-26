/**
 * aperture-bqvb5 — arquivar/desarquivar uma lista, pela composição real do
 * servidor: login por magic link (BetterAuth real) → appRouter → Postgres.
 *
 *   - Só a titular (owner) arquiva e desarquiva; membro recebe FORBIDDEN.
 *   - Arquivada: a página pública fica indisponível para todo mundo (lista,
 *     mural, carrinho, perfil/SEO, convite, slug da lista) e sai do sitemap.
 *   - Telas internas continuam funcionando (Minhas Listas, configurações,
 *     extrato/resgate) e nenhum pagamento é apagado.
 *   - URL sem lista (/pagina/<slug>) cai na lista mais antiga NÃO arquivada;
 *     com todas arquivadas, fica indisponível.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildServerDeps,
  loadEnv,
  type ServerDeps,
} from '../../apps/eunenem-server/server/auth/setup.js';
import { createSeoDiscoveryRoutes } from '../../apps/eunenem-server/server/seo-discovery.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
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

function caller(cookie: string) {
  return appRouter.createCaller({
    deps: { ...deps, auth: authReal() },
    headers: new Headers({ cookie }),
    resHeaders: new Headers(),
  });
}

/** Anonymous visitor on the checkout boundary (same-origin, cookie jar). */
function visitante() {
  const ctx = {
    deps: { ...deps, auth: authReal() },
    headers: new Headers({ origin: deps.publicOrigin }),
    resHeaders: new Headers(),
  };
  return { ctx, caller: appRouter.createCaller(ctx) };
}

/** First checkout hop: sets the capability cookie, creates no payment yet. */
async function prepararCheckout(
  v: ReturnType<typeof visitante>,
  invoke: (operationId: string) => Promise<{ tipo: string }>,
): Promise<string> {
  const operationId = randomUUID();
  expect(await invoke(operationId)).toMatchObject({ tipo: 'prepared' });
  const pair = v.ctx.resHeaders.get('set-cookie')?.split(';', 1)[0];
  if (!pair) throw new Error('checkout prepare did not set its capability cookie');
  v.ctx.headers.set('cookie', pair);
  return operationId;
}

async function pagamentosDaCampanha(idCampanha: string): Promise<number> {
  const rows = await deps.db
    .selectFrom('pagamentos')
    .select('id')
    .where('intencao_id_campanha', '=', idCampanha)
    .execute();
  return rows.length;
}

async function login(email = `arq-${randomUUID()}@example.com`) {
  const before = magicLinks.length;
  await authReal().api.signInMagicLink({
    body: { email, callbackURL: '/' },
    headers: new Headers({ origin: ORIGIN }),
  });
  const url = magicLinks[before];
  if (!url) throw new Error('magic link não enviado');
  const response = await authReal().handler(new Request(url));
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
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
  return { caller: c, user, idCampanha };
}

const anon = () => caller('');

async function sitemap(): Promise<string> {
  const res = await createSeoDiscoveryRoutes(deps.db, ORIGIN).request('/sitemap.xml');
  return res.text();
}

describe('campanhas.arquivar / campanhas.desarquivar', () => {
  it('arquivada: página pública indisponível; desarquivada: volta ao ar', async () => {
    const owner = await login();
    const slug = owner.user.slug;
    const lista = await owner.caller.campanhas.criar({ titulo: 'Chá da Helena' });
    await owner.caller.campanhas.definirSlug({
      idCampanha: lista.id,
      slug: `cha-${randomUUID().slice(0, 6)}`,
      origem: 'setup',
    });
    const campanhaSlug = (await owner.caller.campanhas.list()).novas.find((c) => c.id === lista.id)
      ?.campanhaSlug as string;
    await expect(
      anon().pagina.obterListaPresentes({ slug, idCampanha: lista.id }),
    ).resolves.toBeTruthy();
    expect(await sitemap()).toContain(`/${campanhaSlug}<`);

    await owner.caller.campanhas.arquivar({ idCampanha: lista.id });

    const card = (await owner.caller.campanhas.list()).novas.find((c) => c.id === lista.id);
    expect(card?.arquivadaEm).toEqual(expect.any(String));
    const notFound = { code: 'NOT_FOUND' };
    await expect(
      anon().pagina.obterListaPresentes({ slug, idCampanha: lista.id }),
    ).rejects.toMatchObject(notFound);
    await expect(anon().pagina.obterMural({ slug, idCampanha: lista.id })).rejects.toMatchObject(
      notFound,
    );
    await expect(
      anon().pagina.revalidarCarrinho({
        slug,
        idCampanha: lista.id,
        itens: [{ idContribuicao: randomUUID(), quantidade: 1 }],
      }),
    ).rejects.toMatchObject(notFound);
    await expect(anon().pagina.resolverCampanhaSlug({ slug, campanhaSlug })).rejects.toMatchObject(
      notFound,
    );
    await expect(
      anon().perfil.getPerfilPublicoBySlug({ slug, idCampanha: lista.id }),
    ).rejects.toMatchObject(notFound);
    // Nem a própria titular vê a página pública de uma lista arquivada.
    await expect(
      owner.caller.pagina.obterListaPresentes({ slug, idCampanha: lista.id }),
    ).rejects.toMatchObject(notFound);
    expect(await sitemap()).not.toContain(`/${campanhaSlug}<`);

    await owner.caller.campanhas.desarquivar({ idCampanha: lista.id });

    expect(
      (await owner.caller.campanhas.list()).novas.find((c) => c.id === lista.id)?.arquivadaEm,
    ).toBeNull();
    await expect(
      anon().pagina.obterListaPresentes({ slug, idCampanha: lista.id }),
    ).resolves.toBeTruthy();
    await expect(anon().pagina.resolverCampanhaSlug({ slug, campanhaSlug })).resolves.toEqual({
      idCampanha: lista.id,
    });
    expect(await sitemap()).toContain(`/${campanhaSlug}<`);
  });

  it('arquivada: ninguém compra — nem checkout novo nem carrinho já preparado', async () => {
    const owner = await login();
    const slug = owner.user.slug;
    const [idContribuicao] = (
      await owner.caller.contribuicao.create({
        idCampanha: owner.idCampanha,
        nome: 'Banheira',
        valor: 5000,
        quantidade: 3,
      })
    ).ids;
    if (!idContribuicao) throw new Error('setup: create não retornou id');
    const contribuicao = (v: ReturnType<typeof visitante>) => (operationId: string) =>
      v.caller.pagina.iniciarPagamentoContribuicao({
        operationId,
        slug,
        idCampanha: owner.idCampanha,
        idContribuicao,
        metodo: 'pix',
      });
    const carrinho = (v: ReturnType<typeof visitante>) => (operationId: string) =>
      v.caller.pagina.iniciarPagamentoCarrinho({
        operationId,
        slug,
        idCampanha: owner.idCampanha,
        itens: [{ idContribuicao, quantidade: 1 }],
        metodo: 'pix',
      });

    // Controle: antes de arquivar, o checkout real cria o pagamento.
    const controle = visitante();
    const opControle = await prepararCheckout(controle, contribuicao(controle));
    await expect(contribuicao(controle)(opControle)).resolves.not.toMatchObject({
      tipo: 'prepared',
    });
    expect(await pagamentosDaCampanha(owner.idCampanha)).toBeGreaterThan(0);

    // Visitantes com o carrinho já preparado (cookie emitido) antes do arquivamento.
    const comContribuicao = visitante();
    const opContribuicao = await prepararCheckout(comContribuicao, contribuicao(comContribuicao));
    const comCarrinho = visitante();
    const opCarrinho = await prepararCheckout(comCarrinho, carrinho(comCarrinho));

    const antes = await pagamentosDaCampanha(owner.idCampanha);

    await owner.caller.campanhas.arquivar({ idCampanha: owner.idCampanha });

    const notFound = { code: 'NOT_FOUND' };
    await expect(contribuicao(comContribuicao)(opContribuicao)).rejects.toMatchObject(notFound);
    await expect(carrinho(comCarrinho)(opCarrinho)).rejects.toMatchObject(notFound);
    const novo = visitante();
    await expect(contribuicao(novo)(randomUUID())).rejects.toMatchObject(notFound);
    await expect(carrinho(novo)(randomUUID())).rejects.toMatchObject(notFound);
    expect(await pagamentosDaCampanha(owner.idCampanha)).toBe(antes);
  });

  it('telas internas continuam funcionando e pagamentos não são apagados', async () => {
    const owner = await login();
    const { idPagamento } = await seed.pagamento({
      campaignId: owner.idCampanha,
      taxaCents: 100,
      criadoEm: new Date(),
    });
    const antes = await owner.caller.recebedor.extrato.summary({ idCampanha: owner.idCampanha });

    await owner.caller.campanhas.arquivar({ idCampanha: owner.idCampanha });

    expect((await owner.caller.campanhas.list()).novas.map((c) => c.id)).toContain(
      owner.idCampanha,
    );
    await expect(
      owner.caller.configuracoes.get({ idCampanha: owner.idCampanha }),
    ).resolves.toBeTruthy();
    expect(await owner.caller.recebedor.extrato.summary({ idCampanha: owner.idCampanha })).toEqual(
      antes,
    );
    const pagamento = await deps.db
      .selectFrom('pagamentos')
      .select('id')
      .where('id', '=', idPagamento)
      .executeTakeFirst();
    expect(pagamento?.id).toBe(idPagamento);
  });

  it('só a titular arquiva/desarquiva; membro FORBIDDEN, estranho e anônimo UNAUTHORIZED', async () => {
    const owner = await login();
    const membro = await login();
    const estranho = await login();
    await deps.campanhaRepository.adicionarAdministrador(
      owner.idCampanha as never,
      membro.user.id_conta as never,
    );

    await expect(
      membro.caller.campanhas.arquivar({ idCampanha: owner.idCampanha }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      estranho.caller.campanhas.arquivar({ idCampanha: owner.idCampanha }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon().campanhas.arquivar({ idCampanha: owner.idCampanha })).rejects.toMatchObject(
      { code: 'UNAUTHORIZED' },
    );

    await owner.caller.campanhas.arquivar({ idCampanha: owner.idCampanha });
    await expect(
      membro.caller.campanhas.desarquivar({ idCampanha: owner.idCampanha }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await owner.caller.campanhas.list()).novas.find((c) => c.id === owner.idCampanha)
        ?.arquivadaEm,
    ).toEqual(expect.any(String));
  });

  it('URL sem lista cai na lista mais antiga não arquivada; todas arquivadas → indisponível', async () => {
    const owner = await login();
    const slug = owner.user.slug;
    const segunda = await owner.caller.campanhas.criar({ titulo: 'Segunda lista' });

    await owner.caller.campanhas.arquivar({ idCampanha: owner.idCampanha });

    const perfil = await anon().perfil.getPerfilPublicoBySlug({ slug });
    expect(perfil.idCampanha).toBe(segunda.id);
    await expect(anon().pagina.obterMural({ slug })).resolves.toBeTruthy();
    await expect(anon().eventoConvite.getPreview({ slug })).resolves.toBeDefined();
    const xml = await sitemap();
    expect(xml).toContain(`/pagina/${slug}<`);
    expect(xml).not.toContain(`/pagina/${slug}/c/${segunda.id}`);

    await owner.caller.campanhas.arquivar({ idCampanha: segunda.id });

    await expect(anon().perfil.getPerfilPublicoBySlug({ slug })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(anon().pagina.obterMural({ slug })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(anon().eventoConvite.getPreview({ slug })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await sitemap()).not.toContain(`/pagina/${slug}<`);
  });
});
