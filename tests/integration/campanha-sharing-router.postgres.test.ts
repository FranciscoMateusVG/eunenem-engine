import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  buildServerDeps,
  loadEnv,
  type ServerDeps,
} from '../../apps/eunenem-server/server/auth/setup.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { makeCampanha } from '../helpers/campanha-repository.conformance.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
let deps: ServerDeps;
const sent: string[] = [];
beforeAll(async () => {
  testDb = await createTestDatabase();
  deps = buildServerDeps(
    loadEnv({
      BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters-long',
      BETTER_AUTH_URL: 'http://localhost:3001',
      TRUSTED_ORIGINS: 'http://localhost:3001',
      DATABASE_URL: testDb.connectionUri,
      NODE_ENV: 'test',
      LEGACY_SITE_ORIGIN: 'https://eunenem.com',
    }),
  );
  // Only transport is substituted: all persistence/auth/router composition is real.
  deps = {
    ...deps,
    enviarConviteCampanha: async (email) => {
      sent.push(email);
    },
  };
}, 180000);
afterAll(async () => {
  await deps?.db.destroy();
  await testDb?.teardown();
});

async function login(email = `person-${randomUUID()}@example.com`) {
  let url = '';
  const auth = criarAuth(deps.db, {
    secret: 'test-secret-at-least-thirty-two-characters-long',
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:3001'],
    idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
    sendMagicLink: async (message) => {
      url = message.url;
    },
  });
  await auth.api.signInMagicLink({
    body: { email, callbackURL: '/' },
    headers: new Headers({ origin: 'http://localhost:3001' }),
  });
  const response = await auth.handler(new Request(url));
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(cookie).toContain('session_token');
  const caller = appRouter.createCaller({
    deps: { ...deps, auth },
    headers: new Headers({ cookie }),
    resHeaders: new Headers(),
  });
  const me = await caller.auth.me();
  expect(me).not.toBeNull();
  const user = await deps.db
    .selectFrom('usuarios')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirstOrThrow();
  return { caller, user, email, auth, headers: new Headers({ cookie }) };
}

it('production composition supports owner invite, verified login, listing, removal and no replay', async () => {
  const owner = await login();
  const campaign = makeCampanha({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [owner.user.id_conta],
  });
  await deps.campanhaRepository.save(campaign);
  const email = `recipient-${randomUUID()}@example.com`;
  await owner.caller.compartilhamento.convidar({ idCampanha: campaign.id, email });
  expect(sent).toContain(email);
  const recipient = await login(email); // auth.me -> real shared resolver -> consumption
  const list = await owner.caller.campanhaMembros.listar({ idCampanha: campaign.id });
  expect(list.some((m) => m.idConta === recipient.user.id_conta && m.papel === 'membro')).toBe(
    true,
  );
  expect(
    (await owner.caller.compartilhamento.listarConvites({ idCampanha: campaign.id }))[0]
      ?.consumido_em,
  ).not.toBeNull();
  await expect(
    recipient.caller.compartilhamento.convidar({
      idCampanha: campaign.id,
      email: 'escalation@example.com',
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    recipient.caller.campanhaMembros.listar({ idCampanha: campaign.id }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await owner.caller.campanhaMembros.remover({
    idCampanha: campaign.id,
    idConta: recipient.user.id_conta,
  });
  await recipient.caller.auth.me();
  const after = await owner.caller.campanhaMembros.listar({ idCampanha: campaign.id });
  expect(after.some((m) => m.idConta === recipient.user.id_conta)).toBe(false);
  await expect(
    owner.caller.campanhaMembros.remover({
      idCampanha: campaign.id,
      idConta: owner.user.id_conta,
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

it('cross-campaign revoke/removal and non-owner privilege escalation are denied', async () => {
  const owner = await login();
  const outsider = await login();
  const campaign = makeCampanha({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [owner.user.id_conta],
  });
  await deps.campanhaRepository.save(campaign);
  const idCampanha = campaign.id;
  await expect(
    outsider.caller.compartilhamento.revogar({ idCampanha, idConvite: randomUUID() }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    outsider.caller.campanhaMembros.remover({ idCampanha, idConta: owner.user.id_conta }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(
    outsider.caller.admin.campanhas.adicionarEmail({
      idCampanha,
      email: outsider.email,
      confirmarApenasAcesso: true,
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('admin email action is audited and only grants member access after verified sign-in', async () => {
  expect(deps.consumirConvitesVerificados).toBeTypeOf('function');
  expect(deps.revogarConvitesPendentesDoMembro).toBeTypeOf('function');
  const owner = await login();
  const operator = await login();
  const campaign = makeCampanha({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [owner.user.id_conta],
  });
  await deps.campanhaRepository.save(campaign);
  const admin = appRouter.createCaller({
    deps: { ...deps, auth: operator.auth, adminAllowedEmails: new Set([operator.email]) },
    headers: operator.headers,
    resHeaders: new Headers(),
  });
  const email = `recovery-${randomUUID()}@example.com`;
  const before = await deps.db
    .selectFrom('recebedores')
    .selectAll()
    .where('campanha_id', '=', campaign.id)
    .execute();
  await admin.admin.campanhas.adicionarEmail({
    idCampanha: campaign.id,
    email,
    confirmarApenasAcesso: true,
  });
  expect(
    await deps.db
      .selectFrom('campanha_administradores')
      .selectAll()
      .where('campanha_id', '=', campaign.id)
      .execute(),
  ).toHaveLength(1);
  const recipient = await login(email);
  const members = await owner.caller.campanhaMembros.listar({ idCampanha: campaign.id });
  expect(members.find((m) => m.idConta === recipient.user.id_conta)?.papel).toBe('membro');
  expect(members.find((m) => m.idConta === owner.user.id_conta)?.papel).toBe('owner');
  expect(
    await deps.db
      .selectFrom('recebedores')
      .selectAll()
      .where('campanha_id', '=', campaign.id)
      .execute(),
  ).toEqual(before);
  const audit = await deps.db
    .selectFrom('campanha_compartilhamento_audit')
    .selectAll()
    .where('campanha_id', '=', campaign.id)
    .where('acao', '=', 'admin:convidar')
    .executeTakeFirstOrThrow();
  expect(audit.ator_id).toBe(operator.user.id);
  expect(audit.alvo).toBe(email);
});

it('sole member-removal route revokes a pre-existing pending invitation in the same transaction', async () => {
  const owner = await login();
  const member = await login();
  const campaign = makeCampanha({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [owner.user.id_conta],
  });
  await deps.campanhaRepository.save(campaign);
  await owner.caller.compartilhamento.convidar({ idCampanha: campaign.id, email: member.email });
  // Reproduce a legacy/manual member grant while the invite is still pending.
  await deps.campanhaRepository.adicionarAdministrador(campaign.id, member.user.id_conta);
  await owner.caller.campanhaMembros.remover({
    idCampanha: campaign.id,
    idConta: member.user.id_conta,
  });
  await member.caller.auth.me();
  const members = await owner.caller.campanhaMembros.listar({ idCampanha: campaign.id });
  expect(members.some((m) => m.idConta === member.user.id_conta)).toBe(false);
  const invites = await owner.caller.compartilhamento.listarConvites({ idCampanha: campaign.id });
  expect(invites[0]?.revogado_em).not.toBeNull();
  expect(invites[0]?.consumido_em).toBeNull();
});

it('Google verified callback consumes the invite only after invalidating the pre-hijacker session', async () => {
  const owner = await login();
  const campaign = makeCampanha({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [owner.user.id_conta],
  });
  await deps.campanhaRepository.save(campaign);
  const email = `google-${randomUUID()}@example.com`;
  await owner.caller.compartilhamento.convidar({ idCampanha: campaign.id, email });
  const idUsuario = randomUUID();
  await deps.authService.criarConta({
    idUsuario,
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    email,
    senha: 'test-prehijack-password',
    nome: 'Google recipient',
  });
  const oldSession = await deps.authService.iniciarSessao({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    email,
    senha: 'test-prehijack-password',
  });
  const oldCaller = appRouter.createCaller({
    deps,
    headers: new Headers({ cookie: `${deps.sessionCookieName}=${oldSession.token}` }),
    resHeaders: new Headers(),
  });
  await oldCaller.auth.me();
  expect((await owner.caller.campanhaMembros.listar({ idCampanha: campaign.id })).length).toBe(1);
  const secret = 'test-secret-at-least-thirty-two-characters-long';
  const auth = criarAuth(deps.db, {
    secret,
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:3001'],
    idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
    socialProviders: {
      google: { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret' },
    },
  });
  const state = randomUUID().replace(/-/g, '');
  await deps.db
    .insertInto('verifications')
    .values({
      id: randomUUID(),
      identifier: state,
      value: JSON.stringify({
        callbackURL: 'http://localhost:3001/',
        codeVerifier: 'a'.repeat(43),
        errorURL: 'http://localhost:3001/error',
        expiresAt: Date.now() + 600_000,
        oauthState: state,
      }),
      expires_at: new Date(Date.now() + 600_000),
    })
    .execute();
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${b64({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })}.${b64({ iss: 'https://accounts.google.com', aud: 'test-google-client-id', sub: randomUUID(), email, email_verified: true, name: 'Google recipient', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const originalFetch = globalThis.fetch;
  // Only the external provider's token transport is replaced; callback,
  // credentials/session invalidation, cookies and all database writes are real.
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://oauth2.googleapis.com/token'))
      throw new Error(`Unexpected network request: ${url}`);
    return new Response(
      JSON.stringify({
        access_token: 'test-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'email profile openid',
        id_token: token,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  let response: Response;
  try {
    const signature = createHmac('sha256', secret).update(state).digest('base64');
    response = await auth.handler(
      new Request(`http://localhost:3001/api/auth/callback/google?code=test-code&state=${state}`, {
        headers: { cookie: `better-auth.state=${encodeURIComponent(`${state}.${signature}`)}` },
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(cookie).toContain('session_token');
  expect(await oldCaller.auth.me()).toBeNull();
  const newCaller = appRouter.createCaller({
    deps: { ...deps, auth },
    headers: new Headers({ cookie }),
    resHeaders: new Headers(),
  });
  await newCaller.auth.me();
  const members = await owner.caller.campanhaMembros.listar({ idCampanha: campaign.id });
  expect(members.some((member) => member.email === email && member.papel === 'membro')).toBe(true);
  await expect(
    deps.authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: 'test-prehijack-password',
    }),
  ).rejects.toThrow();
});

it('owner cannot re-invite an existing member and gets an actionable BAD_REQUEST', async () => {
  const owner = await login();
  const campaign = makeCampanha({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [owner.user.id_conta],
  });
  await deps.campanhaRepository.save(campaign);
  await expect(
    owner.caller.compartilhamento.convidar({ idCampanha: campaign.id, email: owner.email }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

it('accepted verified sharing bypasses own onboarding without latching it; non-invitees still onboard', async () => {
  const owner = await login();
  const campaign = makeCampanha({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [owner.user.id_conta],
  });
  await deps.campanhaRepository.save(campaign);
  await deps.db
    .insertInto('perfil_campanhas')
    .values({ id: randomUUID(), id_campanha: campaign.id, nome_bebe: 'Bebê do proprietário' })
    .execute();
  const email = `onboarding-invite-${randomUUID()}@example.com`;
  await owner.caller.compartilhamento.convidar({ idCampanha: campaign.id, email });
  const member = await login(email);
  const me = await member.caller.auth.me();
  expect(me?.needsOnboarding).toBe(false);
  expect(me?.onboardingProprioPendente).toBe(true);
  expect(me?.idCampanhaCompartilhada).toBe(campaign.id);
  expect(me?.idCampanha).not.toBe(campaign.id);
  expect(
    (
      await deps.db
        .selectFrom('usuarios')
        .select('onboarding_concluido_em')
        .where('id', '=', member.user.id)
        .executeTakeFirstOrThrow()
    ).onboarding_concluido_em,
  ).toBeNull();
  const fresh = await login();
  expect((await fresh.caller.auth.me())?.needsOnboarding).toBe(true);
  await owner.caller.campanhaMembros.remover({
    idCampanha: campaign.id,
    idConta: member.user.id_conta,
  });
  expect((await member.caller.auth.me())?.needsOnboarding).toBe(true);
});

async function sharedOnlyFixture() {
  const owner = await login();
  const campaign = makeCampanha({
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [owner.user.id_conta],
  });
  await deps.campanhaRepository.save(campaign);
  await deps.db
    .updateTable('campanhas')
    .set({ slug: 'shared-baby' })
    .where('id', '=', campaign.id)
    .execute();
  await deps.db
    .insertInto('perfil_campanhas')
    .values({ id: randomUUID(), id_campanha: campaign.id, nome_bebe: 'Owner Baby' })
    .execute();
  const email = `only-member-${randomUUID()}@example.com`;
  await owner.caller.compartilhamento.convidar({ idCampanha: campaign.id, email });
  const member = await login(email);
  // Model the reported member-only account, not the signup saga's own blank list.
  await deps.db
    .deleteFrom('campanha_administradores')
    .where('id_usuario', '=', member.user.id_conta)
    .where('campanha_id', '!=', campaign.id)
    .execute();
  await deps.db
    .deleteFrom('campanha_membros_permissoes')
    .where('id_conta', '=', member.user.id_conta)
    .where('campanha_id', '!=', campaign.id)
    .execute();
  return { owner, member, campaign };
}

it('member-only profile returns empty own content or explicit shared content, never 500', async () => {
  const { member, campaign } = await sharedOnlyFixture();
  expect((await member.caller.auth.me())?.idCampanha).toBeNull();
  expect(await member.caller.perfil.getPerfil()).toMatchObject({
    slug: member.user.slug,
    nomeBebe: null,
  });
  expect(await member.caller.perfil.getPerfil({ idCampanha: campaign.id })).toMatchObject({
    slug: member.user.slug,
    nomeBebe: 'Owner Baby',
  });
  await expect(member.caller.perfil.getPerfil({ idCampanha: randomUUID() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  expect(await member.caller.perfil.atualizar({ nomeExibicao: 'New name' })).toMatchObject({
    creatorName: 'New name',
    nomeBebe: null,
  });
});

it('member-only bare campaign routes return a controlled missing-context response, not 500', async () => {
  const { member } = await sharedOnlyFixture();
  await expect(member.caller.contribuicao.list()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(member.caller.eventoConvite.get()).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('shared campaign public addresses belong only to its owner, not an invited member', async () => {
  const { owner, member, campaign } = await sharedOnlyFixture();
  await expect(
    member.caller.pagina.resolverCampanhaSlug({
      slug: member.user.slug,
      campanhaSlug: 'shared-baby',
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(
    await member.caller.pagina.resolverCampanhaSlug({
      slug: owner.user.slug,
      campanhaSlug: 'shared-baby',
    }),
  ).toEqual({ idCampanha: campaign.id });
  await expect(
    member.caller.perfil.getPerfilPublicoBySlug({
      slug: member.user.slug,
      idCampanha: campaign.id,
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    member.caller.pagina.obterListaPresentes({ slug: member.user.slug, idCampanha: campaign.id }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    member.caller.eventoConvite.getPreview({ slug: member.user.slug, idCampanha: campaign.id }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(
    await member.caller.perfil.getPerfilPublicoBySlug({
      slug: owner.user.slug,
      idCampanha: campaign.id,
    }),
  ).toMatchObject({ nomeBebe: 'Owner Baby' });
});

it('shared campaign cards keep private routing separate from the canonical public owner', async () => {
  const { owner, member, campaign } = await sharedOnlyFixture();
  const cards = await member.caller.campanhas.list();
  expect(cards.novas.find((c) => c.id === campaign.id)).toMatchObject({
    slug: member.user.slug,
    publicOwnerSlug: owner.user.slug,
  });
});
