/**
 * aperture-bqvb5 — agradecer quem presenteou, pela composição real do
 * servidor: login por magic link (BetterAuth real) → appRouter → Postgres →
 * EmailTransportNodemailer → sink SMTP local (loopback TLS, sem rede).
 *
 *   - `agradecimentos.destinatarios` agrupa os presentes pagos por pessoa
 *     (e-mail), sem expor o e-mail ao navegador; estornados, pendentes e
 *     pagamentos sem contribuinte ficam de fora.
 *   - `agradecimentos.enviar` manda um e-mail por pessoa com a mensagem
 *     escrita, a padrão configurada ou a sugerida; Reply-To é a titular;
 *     registra `agradecido_em` por presente.
 *   - `configuracoes.mensagemAgradecimento` grava a mensagem padrão.
 *   - Exige `mensagens:gerenciar`; ids de outra lista são recusados; limite
 *     de 200 destinatários/hora por usuário.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildServerDeps,
  loadEnv,
  type ServerDeps,
} from '../../apps/eunenem-server/server/auth/setup.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { createLifecycleSmtpSink } from '../helpers/lifecycle-smtp-sink.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const SECRET = 'test-secret-at-least-thirty-two-characters-long';
const ORIGIN = 'http://localhost:3001';

let testDb: TestDatabase;
let deps: ServerDeps;
let seed: ReceitaLedgerSeed;
let sink: Awaited<ReturnType<typeof createLifecycleSmtpSink>>;
const magicLinks: string[] = [];

beforeAll(async () => {
  // Own container: checkout/thank-you rows and extra public lists would leak
  // into the shared DB other files truncate and count (e.g. the sitemap).
  testDb = await createTestDatabase({ isolated: true });
  sink = await createLifecycleSmtpSink();
  // Real composition: SMTP env → buildServerDeps → EmailTransportNodemailer,
  // pointed at the loopback sink (test endpoint is test-mode only).
  deps = buildServerDeps(
    loadEnv({
      ...baseEnv(),
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: randomUUID(),
      SMTP_PASS: randomUUID(),
      SMTP_FROM: 'EuNeném <synthetic@example.invalid>',
    }),
    { port: sink.port, ca: sink.ca },
  );
  seed = new ReceitaLedgerSeed(deps.db);
}, 180_000);

afterAll(async () => {
  await sink?.close();
  await deps?.db.destroy();
  await testDb?.teardown();
});

beforeEach(() => {
  sink.messages.length = 0;
  sink.setMode('accept');
});

function baseEnv() {
  return {
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: ORIGIN,
    TRUSTED_ORIGINS: ORIGIN,
    DATABASE_URL: testDb.connectionUri,
    NODE_ENV: 'test',
    LEGACY_SITE_ORIGIN: 'https://eunenem.com',
  };
}

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

function caller(cookie: string, comDeps: ServerDeps = deps) {
  return appRouter.createCaller({
    deps: { ...comDeps, auth: authReal() },
    headers: new Headers({ cookie }),
    resHeaders: new Headers(),
  });
}

async function login(email = `agr-${randomUUID()}@example.com`) {
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
  return { caller: c, cookie, user, email, idCampanha };
}

/** A paid gift from `nome <email>` on the campanha (status aprovado by default). */
async function presente(
  idCampanha: string,
  contribuinte: { nome: string; email: string } | null,
  status: 'aprovado' | 'estornado' | 'pendente' = 'aprovado',
): Promise<string> {
  const { idPagamento } = await seed.pagamento({
    campaignId: idCampanha,
    taxaCents: 100,
    criadoEm: new Date(),
    ...(status === 'estornado' ? { canceladoEm: new Date() } : {}),
    ...(status === 'pendente' ? { status: 'pendente', semLancamento: true } : {}),
  });
  if (contribuinte) {
    await sql`UPDATE pagamentos SET intencao_contribuinte_nome=${contribuinte.nome},
      intencao_contribuinte_email=${contribuinte.email} WHERE id=${idPagamento}`.execute(deps.db);
  }
  return idPagamento;
}

/** Decoded body of a raw SMTP DATA payload (quoted-printable aware). */
function corpo(raw: string): string {
  return raw
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => `%${hex}`)
    .split('\r\n')
    .map((line) => {
      try {
        return decodeURIComponent(line);
      } catch {
        return line;
      }
    })
    .join('\n');
}

function para(raw: string): string | undefined {
  return /^To: (.+)$/m.exec(raw)?.[1]?.trim();
}

describe('agradecimentos.destinatarios', () => {
  it('agrupa por pessoa, só presentes pagos com contribuinte, sem expor e-mail', async () => {
    const owner = await login();
    const ana1 = await presente(owner.idCampanha, { nome: 'Ana Souza', email: 'ana@example.com' });
    const ana2 = await presente(owner.idCampanha, { nome: 'Ana Souza', email: 'ANA@example.com' });
    const bia = await presente(owner.idCampanha, { nome: 'Bia Lima', email: 'bia@example.com' });
    await presente(owner.idCampanha, { nome: 'Estorno', email: 'est@example.com' }, 'estornado');
    await presente(owner.idCampanha, { nome: 'Pendente', email: 'pen@example.com' }, 'pendente');
    await presente(owner.idCampanha, null);

    const { pessoas } = await owner.caller.agradecimentos.destinatarios({
      idCampanha: owner.idCampanha,
    });

    expect(pessoas.map((p) => ({ nome: p.nome, ids: [...p.idsPagamento].sort() }))).toEqual(
      expect.arrayContaining([
        { nome: 'Ana Souza', ids: [ana1, ana2].sort() },
        { nome: 'Bia Lima', ids: [bia] },
      ]),
    );
    expect(pessoas).toHaveLength(2);
    expect(pessoas.every((p) => p.agradecidoEm === null)).toBe(true);
    expect(JSON.stringify(pessoas)).not.toContain('@example.com');
  });
});

describe('agradecimentos.enviar', () => {
  it('mensagem sugerida: um e-mail por pessoa, Reply-To da titular, registra agradecido_em', async () => {
    const owner = await login();
    const ana1 = await presente(owner.idCampanha, { nome: 'Ana Souza', email: 'ana@example.com' });
    const ana2 = await presente(owner.idCampanha, { nome: 'Ana Souza', email: 'ana@example.com' });
    const bia = await presente(owner.idCampanha, { nome: 'Bia Lima', email: 'bia@example.com' });

    const result = await owner.caller.agradecimentos.enviar({
      idCampanha: owner.idCampanha,
      idsPagamento: [ana1, ana2, bia],
    });

    expect(result).toEqual({ enviados: 2, falhas: 0 });
    expect(sink.messages.map(para).sort()).toEqual(['ana@example.com', 'bia@example.com']);
    const paraAna = sink.messages.find((m) => para(m) === 'ana@example.com') as string;
    expect(paraAna).toMatch(new RegExp(`^Reply-To: ${owner.email}`, 'm'));
    expect(corpo(paraAna)).toContain('Oi, Ana!');

    const { pessoas } = await owner.caller.agradecimentos.destinatarios({
      idCampanha: owner.idCampanha,
    });
    expect(pessoas.every((p) => p.agradecidoEm !== null)).toBe(true);
  });

  it('usa a mensagem padrão configurada; mensagem escrita tem precedência e é escapada', async () => {
    const owner = await login();
    const ana = await presente(owner.idCampanha, { nome: 'Ana Souza', email: 'ana@example.com' });

    await owner.caller.configuracoes.mensagemAgradecimento({
      idCampanha: owner.idCampanha,
      mensagem: 'Querida {nome}, obrigada pelo mimo!',
    });
    expect(
      (await owner.caller.configuracoes.get({ idCampanha: owner.idCampanha }))
        .mensagemAgradecimento,
    ).toBe('Querida {nome}, obrigada pelo mimo!');

    await owner.caller.agradecimentos.enviar({ idCampanha: owner.idCampanha, idsPagamento: [ana] });
    expect(corpo(sink.messages[0] as string)).toContain('Querida Ana, obrigada pelo mimo!');

    sink.messages.length = 0;
    await owner.caller.agradecimentos.enviar({
      idCampanha: owner.idCampanha,
      idsPagamento: [ana],
      mensagem: 'Valeu, {nome}! <script>x</script>',
    });
    // The text/plain alternative is not HTML; only the HTML part must escape.
    const html = corpo(sink.messages[0] as string).split('Content-Type: text/html')[1] ?? '';
    expect(html).toContain('Valeu, Ana! &lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');

    await owner.caller.configuracoes.mensagemAgradecimento({
      idCampanha: owner.idCampanha,
      mensagem: null,
    });
    expect(
      (await owner.caller.configuracoes.get({ idCampanha: owner.idCampanha }))
        .mensagemAgradecimento,
    ).toBeNull();
  });

  it('recusa ids de outra lista, estornados ou sem contribuinte — nada é enviado', async () => {
    const owner = await login();
    const outra = await login();
    const alheio = await presente(outra.idCampanha, { nome: 'Caio', email: 'caio@example.com' });
    const estornado = await presente(
      owner.idCampanha,
      { nome: 'Duda', email: 'duda@example.com' },
      'estornado',
    );
    const anonimo = await presente(owner.idCampanha, null);

    for (const id of [alheio, estornado, anonimo]) {
      await expect(
        owner.caller.agradecimentos.enviar({ idCampanha: owner.idCampanha, idsPagamento: [id] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(sink.messages).toHaveLength(0);
  });

  it('exige mensagens:gerenciar; anônimo UNAUTHORIZED', async () => {
    const owner = await login();
    const membro = await login();
    const ana = await presente(owner.idCampanha, { nome: 'Ana', email: 'ana@example.com' });
    await deps.campanhaRepository.adicionarAdministrador(
      owner.idCampanha as never,
      membro.user.id_conta as never,
    );
    await deps.campanhaMembrosRepository.definirPermissoes(
      owner.idCampanha as never,
      membro.user.id_conta as never,
      ['mensagens:ver'],
    );

    await expect(
      membro.caller.agradecimentos.enviar({ idCampanha: owner.idCampanha, idsPagamento: [ana] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      membro.caller.configuracoes.mensagemAgradecimento({
        idCampanha: owner.idCampanha,
        mensagem: 'x',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller('').agradecimentos.enviar({ idCampanha: owner.idCampanha, idsPagamento: [ana] }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(sink.messages).toHaveLength(0);
  });

  it('limite de 200 destinatários por hora por usuário', async () => {
    const owner = await login();
    const ana = await presente(owner.idCampanha, { nome: 'Ana', email: 'ana@example.com' });
    const bia = await presente(owner.idCampanha, { nome: 'Bia', email: 'bia@example.com' });
    await sql`INSERT INTO rate_limit (id, key, count, last_request)
      VALUES (${randomUUID()}, ${`agradecer:${owner.user.id}`}, 199, ${Date.now()})`.execute(
      deps.db,
    );

    await expect(
      owner.caller.agradecimentos.enviar({
        idCampanha: owner.idCampanha,
        idsPagamento: [ana, bia],
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(sink.messages).toHaveLength(0);

    await expect(
      owner.caller.agradecimentos.enviar({ idCampanha: owner.idCampanha, idsPagamento: [ana] }),
    ).resolves.toEqual({ enviados: 1, falhas: 0 });
  });
});

describe('agradecimentos.enviar — falhas de entrega', () => {
  it('SMTP recusa: conta como falha e o presente NÃO fica agradecido', async () => {
    const owner = await login();
    const ana = await presente(owner.idCampanha, { nome: 'Ana', email: 'ana@example.com' });
    sink.setMode('reject');

    await expect(
      owner.caller.agradecimentos.enviar({ idCampanha: owner.idCampanha, idsPagamento: [ana] }),
    ).resolves.toEqual({ enviados: 0, falhas: 1 });

    const { pessoas } = await owner.caller.agradecimentos.destinatarios({
      idCampanha: owner.idCampanha,
    });
    expect(pessoas[0]?.agradecidoEm).toBeNull();
  });

  it('sem SMTP configurado (fora do modo e2e explícito): recusa sem marcar nem consumir limite', async () => {
    const semSmtp = buildServerDeps(loadEnv(baseEnv()));
    try {
      expect(semSmtp.enviarEmailAgradecimento).toBeNull();
      const owner = await login();
      const ana = await presente(owner.idCampanha, { nome: 'Ana', email: 'ana@example.com' });
      const comSemSmtp = caller(owner.cookie, semSmtp);

      await expect(
        comSemSmtp.agradecimentos.enviar({ idCampanha: owner.idCampanha, idsPagamento: [ana] }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      const registro = await deps.db
        .selectFrom('agradecimentos_presentes')
        .select('id_pagamento')
        .where('id_pagamento', '=', ana)
        .executeTakeFirst();
      expect(registro).toBeUndefined();
      const limite = await deps.db
        .selectFrom('rate_limit')
        .select('count')
        .where('key', '=', `agradecer:${owner.user.id}`)
        .executeTakeFirst();
      expect(limite).toBeUndefined();
      expect(sink.messages).toHaveLength(0);
    } finally {
      await semSmtp.db.destroy();
    }
  });

  it('modo e2e explícito (E2E_EMAIL_NOOP=1, nunca em produção) habilita o envio sem SMTP', () => {
    const e2e = buildServerDeps(loadEnv({ ...baseEnv(), E2E_EMAIL_NOOP: '1' }));
    try {
      expect(e2e.enviarEmailAgradecimento).toBeTypeOf('function');
    } finally {
      void e2e.db.destroy();
    }
  });
});
