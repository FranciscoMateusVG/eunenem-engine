import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CampanhaCompartilhamentoPostgres } from '../../src/adapters/arrecadacao/campanha-compartilhamento.postgres.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import {
  type AcaoConcedivel,
  PERMISSOES_PADRAO_MEMBRO,
} from '../../src/domain/arrecadacao/value-objects/permissao-campanha.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
let sharing: CampanhaCompartilhamentoPostgres;
const plataforma = randomUUID();
beforeAll(async () => {
  testDb = await createTestDatabase();
  sharing = new CampanhaCompartilhamentoPostgres(testDb.db);
}, 180000);
afterAll(async () => {
  await testDb?.teardown();
});

async function seedCampaign(tenant = plataforma) {
  const id = randomUUID();
  await testDb.db
    .insertInto('campanhas')
    .values({
      id,
      id_plataforma: tenant,
      titulo: 'Compartilhar',
      slug: null,
      slug_alterado_em: null,
    })
    .execute();
  return id;
}
async function seedUser(email: string, verified = false, tenant = plataforma) {
  const id = randomUUID();
  const conta = randomUUID();
  await testDb.db
    .insertInto('users')
    .values({
      id,
      id_plataforma: tenant,
      email,
      email_verified: verified,
      name: 'Pessoa',
      image: null,
    })
    .execute();
  await testDb.db
    .insertInto('usuarios')
    .values({
      id,
      id_conta: conta,
      id_plataforma: tenant,
      email,
      nome_exibicao: 'Pessoa',
      slug: id.slice(0, 28),
      desativado_em: null,
      onboarding_concluido_em: null,
      tutorial_completado_em: null,
    })
    .execute();
  await testDb.db.insertInto('contas').values({ id: conta, id_usuario: id }).execute();
  return { id, conta };
}
async function invite(campanha: string, email: string, permissoes?: readonly AcaoConcedivel[]) {
  return sharing.convidar({
    campanhaId: campanha,
    plataformaId: plataforma,
    email,
    atorId: randomUUID(),
    origem: 'owner',
    ...(permissoes ? { permissoes } : {}),
  });
}
async function accessOf(campanha: string, conta: string) {
  return testDb.db
    .selectFrom('campanha_membros_permissoes')
    .selectAll()
    .where('campanha_id', '=', campanha)
    .where('id_conta', '=', conta)
    .executeTakeFirstOrThrow();
}
async function members(campanha: string) {
  return testDb.db
    .selectFrom('campanha_administradores')
    .selectAll()
    .where('campanha_id', '=', campanha)
    .execute();
}

it('normalizes email; unverified signup and magic-link send grant nothing; verified sign-in consumes once', async () => {
  const campanha = await seedCampaign();
  const email = `invite-${randomUUID()}@example.com`;
  const user = await seedUser(email);
  await invite(campanha, `  ${email.toUpperCase()}  `);
  await sharing.consumirVerificados(user.id, plataforma);
  expect(await members(campanha)).toHaveLength(0);
  let url = '';
  const auth = criarAuth(testDb.db, {
    secret: 'test-secret-at-least-thirty-two-characters-long',
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:3001'],
    idPlataformaPadrao: plataforma,
    sendMagicLink: async (message) => {
      url = message.url;
    },
  });
  await auth.api.signInMagicLink({
    body: { email, callbackURL: '/' },
    headers: new Headers({ origin: 'http://localhost:3001' }),
  });
  expect(await members(campanha)).toHaveLength(0);
  const response = await auth.handler(new Request(url));
  expect([200, 302, 303, 307]).toContain(response.status);
  await Promise.all(
    Array.from({ length: 8 }, () => sharing.consumirVerificados(user.id, plataforma)),
  );
  expect(await members(campanha)).toEqual([{ campanha_id: campanha, id_usuario: user.conta }]);
  await sharing.consumirVerificados(user.id, plataforma);
  expect(await members(campanha)).toHaveLength(1);
  const replay = await auth.handler(new Request(url));
  expect(replay.headers.get('location')).toContain('error');
});

it('revoked and expired invites never grant access', async () => {
  const campanha = await seedCampaign();
  const user = await seedUser(`revoked-${randomUUID()}@example.com`, true);
  const row = await invite(
    campanha,
    (
      await testDb.db
        .selectFrom('users')
        .select('email')
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow()
    ).email,
  );
  await sharing.revogar(campanha, plataforma, row.id, randomUUID());
  await sharing.consumirVerificados(user.id, plataforma);
  expect(await members(campanha)).toHaveLength(0);
  const expired = await invite(campanha, `expired-${randomUUID()}@example.com`);
  await testDb.db
    .updateTable('campanha_convites')
    .set({ expira_em: new Date(0) })
    .where('id', '=', expired.id)
    .execute();
  const other = await seedUser(expired.email, true);
  await sharing.consumirVerificados(other.id, plataforma);
  expect(await members(campanha)).toHaveLength(0);
});

it('same email in another tenant cannot consume an invite', async () => {
  const campanha = await seedCampaign();
  const email = `tenant-${randomUUID()}@example.com`;
  await invite(campanha, email);
  const foreignTenant = randomUUID();
  const foreign = await seedUser(email, true, foreignTenant);
  await sharing.consumirVerificados(foreign.id, plataforma);
  await sharing.consumirVerificados(foreign.id, foreignTenant);
  expect(await members(campanha)).toHaveLength(0);
});

it('duplicate concurrent invites have one active row and audit stays durable', async () => {
  const campanha = await seedCampaign();
  const email = `duplicate-${randomUUID()}@example.com`;
  const results = await Promise.all(Array.from({ length: 8 }, () => invite(campanha, email)));
  expect(new Set(results.map((row) => row.id)).size).toBe(1);
  const audit = await testDb.db
    .selectFrom('campanha_compartilhamento_audit')
    .selectAll()
    .where('campanha_id', '=', campanha)
    .execute();
  expect(audit.length).toBeGreaterThan(0);
});

it('acceptance and revocation serialize; removing accepted access cannot be undone by replay', async () => {
  const campanha = await seedCampaign();
  const email = `race-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  const row = await invite(campanha, email);
  await Promise.all([
    sharing.revogar(campanha, plataforma, row.id, randomUUID()),
    sharing.consumirVerificados(user.id, plataforma),
  ]);
  const final = await testDb.db
    .selectFrom('campanha_convites')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();
  expect(Boolean(final.revogado_em) !== Boolean(final.consumido_em)).toBe(true);
  await testDb.db
    .deleteFrom('campanha_administradores')
    .where('campanha_id', '=', campanha)
    .where('id_usuario', '=', user.conta)
    .execute();
  await sharing.consumirVerificados(user.id, plataforma);
  expect(await members(campanha)).toHaveLength(0);
});

it('refuses a fresh invitation to an existing member', async () => {
  const campanha = await seedCampaign();
  const email = `existing-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  await invite(campanha, email);
  await sharing.consumirVerificados(user.id, plataforma);
  await expect(invite(campanha, email.toUpperCase())).rejects.toThrow('já tem acesso');
});

it('member removal revokes every pending invite for that email atomically', async () => {
  const campanha = await seedCampaign();
  const email = `remove-pending-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  const pending = await invite(campanha, email);
  await testDb.db.transaction().execute(async (trx) => {
    await sharing.bloquear(trx, campanha, plataforma);
    await sharing.revogarPendentesDoMembro(campanha, user.conta, randomUUID(), trx);
  });
  await sharing.consumirVerificados(user.id, plataforma);
  expect(await members(campanha)).toHaveLength(0);
  expect(
    (
      await testDb.db
        .selectFrom('campanha_convites')
        .select('revogado_em')
        .where('id', '=', pending.id)
        .executeTakeFirstOrThrow()
    ).revogado_em,
  ).not.toBeNull();
});

it('new invite to a campaign with no members still grants only membro, never owner', async () => {
  const campanha = await seedCampaign();
  const email = `empty-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  await invite(campanha, email);
  await sharing.consumirVerificados(user.id, plataforma);
  const access = await testDb.db
    .selectFrom('campanha_membros_permissoes')
    .selectAll()
    .where('campanha_id', '=', campanha)
    .where('id_conta', '=', user.conta)
    .executeTakeFirstOrThrow();
  expect(access.papel).toBe('membro');
  expect(access.permissoes).toEqual(PERMISSOES_PADRAO_MEMBRO);
});

it('revoke is scoped to the campaign even when given another campaign invite id', async () => {
  const first = await seedCampaign();
  const second = await seedCampaign();
  const invitation = await invite(first, `scope-${randomUUID()}@example.com`);
  await sharing.revogar(second, plataforma, invitation.id, randomUUID());
  const unchanged = await testDb.db
    .selectFrom('campanha_convites')
    .select('revogado_em')
    .where('id', '=', invitation.id)
    .executeTakeFirstOrThrow();
  expect(unchanged.revogado_em).toBeNull();
});

it('revocation and its audit roll back together on a real database write failure', async () => {
  const campanha = await seedCampaign();
  const email = `atomic-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  const invitation = await invite(campanha, email);
  // Invalid actor UUID causes Postgres to reject audit AFTER the pending rows
  // were updated. The transaction must roll the earlier update back as well.
  await expect(
    testDb.db.transaction().execute(async (trx) => {
      await sharing.bloquear(trx, campanha, plataforma);
      await sharing.revogarPendentesDoMembro(campanha, user.conta, 'invalid-uuid', trx);
    }),
  ).rejects.toThrow();
  const unchanged = await testDb.db
    .selectFrom('campanha_convites')
    .select('revogado_em')
    .where('id', '=', invitation.id)
    .executeTakeFirstOrThrow();
  expect(unchanged.revogado_em).toBeNull();
});

it('verified acceptance grants EXACTLY the permissions chosen on the invite', async () => {
  const campanha = await seedCampaign();
  const email = `chosen-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  const chosen: AcaoConcedivel[] = ['mensagens:ver', 'extrato:ver', 'saque:solicitar'];
  const row = await invite(campanha, email, chosen);
  expect(row.permissoes).toEqual(chosen);
  await sharing.consumirVerificados(user.id, plataforma);
  const access = await accessOf(campanha, user.conta);
  expect(access.papel).toBe('membro');
  expect(access.permissoes).toEqual(chosen);
});

it('an invite with no permissions chosen grants nothing beyond membership', async () => {
  const campanha = await seedCampaign();
  const email = `none-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  await invite(campanha, email, []);
  await sharing.consumirVerificados(user.id, plataforma);
  expect((await accessOf(campanha, user.conta)).permissoes).toEqual([]);
});

it('invites default to PERMISSOES_PADRAO_MEMBRO when the caller chooses nothing', async () => {
  const campanha = await seedCampaign();
  const row = await invite(campanha, `default-${randomUUID()}@example.com`);
  expect(row.permissoes).toEqual(PERMISSOES_PADRAO_MEMBRO);
});

it('a duplicate invite keeps the pending invite and its current permissions', async () => {
  const campanha = await seedCampaign();
  const email = `dup-perms-${randomUUID()}@example.com`;
  const first = await invite(campanha, email, ['extrato:ver']);
  const again = await invite(campanha, email, ['presentes:gerenciar']);
  expect(again.id).toBe(first.id);
  expect(again.permissoes).toEqual(['extrato:ver']);
});

it('editing a pending invite changes what acceptance grants, and is audited', async () => {
  const campanha = await seedCampaign();
  const email = `edit-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  const row = await invite(campanha, email);
  const ator = randomUUID();
  expect(
    await sharing.definirPermissoesConvite(
      campanha,
      plataforma,
      row.id,
      ['recebedor:gerenciar', 'perfil:editar', 'perfil:editar'],
      ator,
    ),
  ).toBe(true);
  await sharing.consumirVerificados(user.id, plataforma);
  expect((await accessOf(campanha, user.conta)).permissoes).toEqual([
    'recebedor:gerenciar',
    'perfil:editar',
  ]);
  const audit = await testDb.db
    .selectFrom('campanha_compartilhamento_audit')
    .selectAll()
    .where('campanha_id', '=', campanha)
    .where('acao', '=', 'convite:permissoes')
    .executeTakeFirstOrThrow();
  expect(audit).toMatchObject({ ator_id: ator, alvo: row.id });
});

it('only pending invites of the same campaign can be edited', async () => {
  const campanha = await seedCampaign();
  const other = await seedCampaign();
  const email = `edit-closed-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  const accepted = await invite(campanha, email);
  await sharing.consumirVerificados(user.id, plataforma);
  expect(
    await sharing.definirPermissoesConvite(
      campanha,
      plataforma,
      accepted.id,
      ['saque:solicitar'],
      randomUUID(),
    ),
  ).toBe(false);
  expect((await accessOf(campanha, user.conta)).permissoes).toEqual(PERMISSOES_PADRAO_MEMBRO);
  const revoked = await invite(campanha, `revoked-edit-${randomUUID()}@example.com`);
  await sharing.revogar(campanha, plataforma, revoked.id, randomUUID());
  expect(
    await sharing.definirPermissoesConvite(campanha, plataforma, revoked.id, [], randomUUID()),
  ).toBe(false);
  const pending = await invite(campanha, `foreign-edit-${randomUUID()}@example.com`);
  expect(
    await sharing.definirPermissoesConvite(other, plataforma, pending.id, [], randomUUID()),
  ).toBe(false);
  const unchanged = await testDb.db
    .selectFrom('campanha_convites')
    .select('permissoes')
    .where('id', '=', pending.id)
    .executeTakeFirstOrThrow();
  expect(unchanged.permissoes).toEqual(PERMISSOES_PADRAO_MEMBRO);
});

it('acceptance never overwrites the permissions of someone who is already a member', async () => {
  const campanha = await seedCampaign();
  const email = `already-${randomUUID()}@example.com`;
  const user = await seedUser(email, true);
  await invite(campanha, email, ['saque:solicitar']);
  // Legacy/manual grant while the invite is pending: current rules stay.
  await testDb.db
    .insertInto('campanha_membros_permissoes')
    .values({
      campanha_id: campanha,
      id_conta: user.conta,
      papel: 'membro',
      permissoes: ['mensagens:ver'],
    })
    .execute();
  await sharing.consumirVerificados(user.id, plataforma);
  expect((await accessOf(campanha, user.conta)).permissoes).toEqual(['mensagens:ver']);
});
