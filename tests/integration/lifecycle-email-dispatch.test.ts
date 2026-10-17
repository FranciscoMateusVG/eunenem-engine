import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderLifecycleEmail } from '../../apps/eunenem-server/server/auth/lifecycle-email.js';
import { createLifecycleEmailTokens } from '../../apps/eunenem-server/server/auth/lifecycle-email-tokens.js';
import { buildServerDeps, loadEnv } from '../../apps/eunenem-server/server/auth/setup.js';
import {
  LIFECYCLE_EMAIL_QUEUE,
  registerLifecycleEmailJob,
} from '../../apps/eunenem-server/server/jobs/lifecycle-email.pgboss.js';
import { resolverUsuarioAutenticado } from '../../apps/eunenem-server/server/trpc/session-resolver.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { EmailTransportNodemailer } from '../../src/adapters/email/email-transport.nodemailer.js';
import { LifecycleEmailRepositoryPostgres } from '../../src/adapters/email/lifecycle-email.postgres.js';
import { LifecycleEmailPreferencesPostgres } from '../../src/adapters/email/lifecycle-email-preferences.postgres.js';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { finalizarPagamentoAprovado } from '../../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import {
  type LifecycleEmailConfig,
  LifecycleEmailService,
} from '../../src/use-cases/email/lifecycle-email.js';
import { registrarEfeitosFinanceirosPagamentoAprovado } from '../../src/use-cases/pagamentos/financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
import { provisionarContaUsuarioDominio } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import {
  makeCatalogoCategoria,
  makeCatalogoLista,
  makeCatalogoListaItem,
  makeCatalogoProduto,
} from '../helpers/catalogo-repository.conformance.js';
import { createLifecycleSmtpSink } from '../helpers/lifecycle-smtp-sink.js';
import { createTestObservability } from '../helpers/observability.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

describe('lifecycle real Postgres and loopback TLS SMTP', () => {
  let test: TestDatabase;
  let sink: Awaited<ReturnType<typeof createLifecycleSmtpSink>>;
  let transport: EmailTransportNodemailer;
  let service: LifecycleEmailService;
  let now: Date;
  const launch = new Date('2026-10-17T00:00:00Z');
  const logs: unknown[] = [];
  const telemetry = createTestObservability();
  let payments: PagamentoRepositoryPostgres;
  let ledger: LivroFinanceiroRepositoryPostgres;
  function build(config: Partial<LifecycleEmailConfig> = {}) {
    const tokens = createLifecycleEmailTokens(
      'synthetic-lifecycle-secret-not-a-credential',
      () => now,
    );
    return new LifecycleEmailService(
      {
        repository: new LifecycleEmailRepositoryPostgres(test.db),
        preferences: new LifecycleEmailPreferencesPostgres(test.db),
        transport,
        pagamentoRepository: payments,
        livroFinanceiroRepository: ledger,
        render: renderLifecycleEmail,
        clock: () => now,
        report: (event, data) => logs.push({ event, data }),
        links: (userId, tenantId, type, deliveryId) => ({
          preferencesUrl: `https://staging.example.invalid/email/preferencias?token=${tokens.signPreferenceToken({ userId, tenantId })}`,
          unsubscribeUrl: `https://staging.example.invalid/email/descadastrar?token=${tokens.signPreferenceToken({ userId, tenantId, type })}`,
          feedbackUrl: `https://staging.example.invalid/avaliar-email?token=${tokens.signFeedbackToken(deliveryId)}`,
        }),
      },
      { enabled: true, launchAt: launch, origin: 'https://staging.example.invalid', ...config },
    );
  }
  beforeAll(async () => {
    test = await createTestDatabase();
    sink = await createLifecycleSmtpSink();
    transport = new EmailTransportNodemailer(
      {
        host: 'smtp.sendgrid.net',
        port: 465,
        secure: true,
        user: 'synthetic',
        pass: 'synthetic',
        from: 'synthetic@example.invalid',
      },
      { port: sink.port, ca: sink.ca },
    );
    payments = new PagamentoRepositoryPostgres(test.db);
    ledger = new LivroFinanceiroRepositoryPostgres(
      test.db,
      new RecebedorRepositoryPostgres(test.db),
    );
  });
  beforeEach(async () => {
    await sql`TRUNCATE lifecycle_email_deliveries,lifecycle_email_events,lifecycle_email_preferences,lifecycle_email_rollout,lifecycle_email_scan_cursors,lifecycle_email_first_gifts,lifecycle_email_provisioned,usuarios,users,campanhas CASCADE`.execute(
      test.db,
    );
    now = new Date('2026-10-17T12:00:00Z');
    sink.messages.length = 0;
    sink.setMode('accept');
    logs.length = 0;
    telemetry.reset();
    service = build();
    await new LifecycleEmailRepositoryPostgres(test.db).initialize(launch, launch);
    await service.initialize();
  });
  afterAll(async () => {
    transport?.close();
    await sink?.close();
    await test?.teardown();
    await telemetry.shutdown();
  });
  async function seed(
    options: {
      verified?: boolean;
      oldAccount?: boolean;
      oldCampaign?: boolean;
      complete?: boolean;
      tenant?: string;
      campaign?: string;
      role?: string;
      permissions?: string[];
    } = {},
  ) {
    const userId = randomUUID(),
      accountId = randomUUID(),
      tenant = options.tenant ?? randomUUID(),
      campaign = options.campaign ?? randomUUID(),
      option = randomUUID();
    const created = options.oldAccount ? new Date('2026-01-01T00:00:00Z') : now;
    const email = `${userId}@example.invalid`;
    await test.db
      .insertInto('users')
      .values({
        id: userId,
        id_plataforma: tenant,
        name: 'Synthetic',
        email,
        email_verified: options.verified ?? true,
        created_at: created,
        updated_at: created,
      })
      .execute();
    await test.db
      .insertInto('usuarios')
      .values({
        id: userId,
        id_conta: accountId,
        id_plataforma: tenant,
        nome_exibicao: 'Synthetic',
        email,
        slug: `test-${userId.slice(0, 20)}`,
        criado_em: created,
      })
      .execute();
    if (!options.campaign) {
      await test.db
        .insertInto('campanhas')
        .values({
          id: campaign,
          id_plataforma: tenant,
          titulo: 'Synthetic',
          criada_em: options.oldCampaign ? new Date('2026-01-01T00:00:00Z') : now,
        })
        .execute();
      await test.db
        .insertInto('opcoes_contribuicao')
        .values({ id: option, campanha_id: campaign, tipo: 'presente' })
        .execute();
    }
    await test.db
      .insertInto('campanha_administradores')
      .values({ campanha_id: campaign, id_usuario: accountId })
      .execute();
    await test.db
      .insertInto('campanha_membros_permissoes')
      .values({
        campanha_id: campaign,
        id_conta: accountId,
        papel: options.role ?? 'owner',
        permissoes: options.permissions ?? [],
      })
      .execute();
    await service.provisioningStarted(userId, campaign, options.complete === false ? 2 : 0);
    if (options.complete !== false) await service.provisioningCompleted(userId, campaign, 0);
    return { userId, accountId, tenant, campaign, option, email };
  }
  async function gift(s: Awaited<ReturnType<typeof seed>>) {
    const id = randomUUID();
    await test.db
      .insertInto('contribuicoes')
      .values({
        id,
        campanha_id: s.campaign,
        id_opcao_contribuicao: s.option,
        nome: 'Synthetic gift',
        valor: 8000,
        criada_em: now,
      })
      .execute();
    return id;
  }
  async function states(type: string) {
    return (
      await sql<{
        state: string;
      }>`SELECT state FROM lifecycle_email_deliveries WHERE type=${type} ORDER BY id`.execute(
        test.db,
      )
    ).rows.map((r) => r.state);
  }
  it('sends welcome only once across concurrent scans/dispatchers, with both tracking filters OFF', async () => {
    const s = await seed();
    await Promise.all([service.scan(), service.scan()]);
    await Promise.all([service.dispatch(), service.dispatch()]);
    expect(await states('welcome')).toEqual(['sent']);
    expect(sink.messages).toHaveLength(1);
    const mime = sink.messages[0] ?? '';
    expect(mime).toContain(s.email);
    expect(mime).toMatch(/clicktrack/);
    expect(mime).toMatch(/opentrack/);
    const headers = mime.split('\r\n\r\n')[0]?.replace(/\r\n[ \t]+/g, ' ') ?? '';
    const tracking = headers.match(/^X-Smtpapi: (.*)$/im)?.[1] ?? '{}';
    expect(JSON.parse(tracking)).toEqual({
      filters: {
        clicktrack: { settings: { enable: 0, enable_text: false } },
        opentrack: { settings: { enable: 0 } },
      },
    });
    await build().scan();
    await build().dispatch();
    expect(sink.messages).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(s.email);
  });
  it('does not backfill old accounts/campaigns or send to unverified accounts', async () => {
    const old = await seed({ oldAccount: true });
    await gift(old);
    const oldCampaign = await seed({ oldCampaign: true });
    await gift(oldCampaign);
    const unverified = await seed({ verified: false });
    await gift(unverified);
    await service.scan();
    await service.dispatch();
    expect(await states('list_ready')).toEqual([]);
    expect(await states('welcome')).toEqual(['sent']);
  });
  it('captures first gifts atomically in any insertion route, waits for provisioning and survives deletion/reinsertion', async () => {
    const s = await seed({ complete: false });
    await gift(s);
    await service.scan();
    expect(await states('list_ready')).toEqual([]);
    await gift(s);
    await Promise.all([service.scan(), service.scan()]);
    await service.dispatch();
    expect(await states('list_ready')).toEqual(['sent']);
    await test.db.deleteFrom('contribuicoes').where('campanha_id', '=', s.campaign).execute();
    await gift(s);
    await service.scan();
    await service.dispatch();
    expect(await states('list_ready')).toEqual(['sent']);
  });
  it('rolls back first-gift facts with the source transaction', async () => {
    const s = await seed();
    await expect(
      test.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('contribuicoes')
          .values({
            id: randomUUID(),
            campanha_id: s.campaign,
            id_opcao_contribuicao: s.option,
            nome: 'rollback',
            valor: 1,
          })
          .execute();
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(
      (
        await sql`SELECT 1 FROM lifecycle_email_first_gifts WHERE campaign_id=${s.campaign}`.execute(
          test.db,
        )
      ).rows,
    ).toEqual([]);
  });
  it('revalidates opt-out after queue admission, and OFF never sends', async () => {
    const s = await seed();
    await service.scan();
    await new LifecycleEmailPreferencesPostgres(test.db).setPreferences(s.userId, s.tenant, {
      welcome: false,
    });
    await build({ enabled: false }).dispatch();
    expect(sink.messages).toHaveLength(0);
    await service.dispatch();
    expect(await states('welcome')).toEqual(['suppressed']);
  });
  it('quarantines a possible SMTP accept without blindly retrying or leaking message data', async () => {
    const s = await seed();
    sink.setMode('ambiguous');
    await service.scan();
    await service.dispatch();
    expect(await states('welcome')).toEqual(['unknown']);
    now = new Date(now.getTime() + 3600_000);
    sink.setMode('accept');
    await build().scan();
    await build().dispatch();
    expect(sink.messages).toHaveLength(1);
    const diagnostics = JSON.stringify({
      logs,
      spans: telemetry.getSpans().map((s) => ({ attributes: s.attributes, events: s.events })),
    });
    expect(diagnostics).not.toContain(s.email);
    expect(diagnostics).not.toContain('token=');
  });
  it('retries only a proven SMTP rejection with backoff', async () => {
    await seed();
    sink.setMode('reject');
    await service.scan();
    await service.dispatch();
    expect(await states('welcome')).toEqual(['pending']);
    expect(sink.messages).toHaveLength(0);
    now = new Date(now.getTime() + 121_000);
    sink.setMode('accept');
    await service.dispatch();
    expect(await states('welcome')).toEqual(['sent']);
    expect(sink.messages).toHaveLength(1);
  });
  it('reminds D−5 at 09h São Paulo, revalidates a changed date and permits its later unsent occurrence', async () => {
    const s = await seed();
    const id = randomUUID();
    await test.db
      .insertInto('eventos')
      .values({ id, id_campanha: s.campaign, data_hora: new Date('2026-10-22T03:00:00Z') })
      .execute();
    now = new Date('2026-10-17T11:59:00Z');
    await service.scan();
    expect(await states('event_reminder')).toEqual([]);
    now = new Date('2026-10-17T12:00:00Z');
    await service.scan();
    await test.db
      .updateTable('eventos')
      .set({ data_hora: new Date('2026-10-23T03:00:00Z') })
      .where('id', '=', id)
      .execute();
    await service.dispatch();
    expect(await states('event_reminder')).toEqual(['suppressed']);
    now = new Date('2026-10-18T12:00:00Z');
    await service.scan();
    await service.dispatch();
    expect(await states('event_reminder')).toEqual(['sent']);
    await test.db
      .updateTable('eventos')
      .set({ data_hora: new Date('2026-10-24T03:00:00Z') })
      .where('id', '=', id)
      .execute();
    now = new Date('2026-10-19T12:00:00Z');
    await service.scan();
    await service.dispatch();
    expect(await states('event_reminder')).toEqual(['sent']);
  });
  it('sends every finalized payment to owner and permitted snapshot members, revalidating revocation', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    const member = await seed({
      campaign: owner.campaign,
      tenant: owner.tenant,
      role: 'membro',
      permissions: ['extrato:ver'],
    });
    await seed({ campaign: owner.campaign, tenant: owner.tenant, role: 'membro' });
    await seed({ campaign: owner.campaign, role: 'membro', permissions: ['extrato:ver'] }); // wrong tenant
    for (const method of ['pix', 'credit_card'] as const) {
      const payment = makePagamento({
        idCampanha: owner.campaign,
        idContribuicao: contribution,
        status: 'aprovado',
        metodo: method,
        criadoEm: now,
      });
      await payments.save(payment);
      await registrarEfeitosFinanceirosPagamentoAprovado(
        {
          livroFinanceiroRepository: ledger,
          clock: () => now,
          observability: telemetry.observability,
        },
        {
          idPagamento: payment.id,
          idCampanha: owner.campaign,
          idContribuicaoAnchor: contribution,
          statusPagamento: 'aprovado',
          items: payment.intencao.items.map((i) => ({
            idItemPagamento: i.id,
            composicaoValoresItem: i.composicaoValoresItem as never,
          })),
        },
      );
      await Promise.all([service.paymentFinalized(payment), service.paymentFinalized(payment)]);
    }
    await test.db
      .updateTable('campanha_membros_permissoes')
      .set({ permissoes: [] })
      .where('id_conta', '=', member.accountId)
      .execute();
    await service.dispatch();
    const result = await states('payment_received');
    expect(result.filter((s) => s === 'sent')).toHaveLength(2);
    expect(result.filter((s) => s === 'suppressed')).toHaveLength(2);
  });
  async function approved(
    owner: Awaited<ReturnType<typeof seed>>,
    contribution: string,
    valid = true,
  ) {
    const payment = makePagamento({
      idCampanha: owner.campaign,
      idContribuicao: contribution,
      status: 'aprovado',
      criadoEm: now,
    });
    await payments.save(payment);
    if (valid)
      await registrarEfeitosFinanceirosPagamentoAprovado(
        {
          livroFinanceiroRepository: ledger,
          clock: () => now,
          observability: telemetry.observability,
        },
        {
          idPagamento: payment.id,
          idCampanha: owner.campaign,
          idContribuicaoAnchor: contribution,
          statusPagamento: 'aprovado',
          items: payment.intencao.items.map((i) => ({
            idItemPagamento: i.id,
            composicaoValoresItem: i.composicaoValoresItem as never,
          })),
        },
      );
    return payment;
  }
  it('quarantines abandoned sending claims on restart', async () => {
    await seed();
    await service.scan();
    await new LifecycleEmailRepositoryPostgres(test.db).claim(now);
    now = new Date(now.getTime() + 16 * 60_000);
    await build().scan();
    await build().dispatch();
    expect(await states('welcome')).toEqual(['unknown']);
    expect(sink.messages).toHaveLength(0);
  });
  it('does not admit corrupt ledger or pending payments, and suppresses refunded pending deliveries', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    const corrupt = await approved(owner, contribution, false);
    await expect(service.paymentFinalized(corrupt)).rejects.toThrow();
    const valid = await approved(owner, contribution);
    await service.paymentFinalized(valid);
    await test.db
      .updateTable('pagamentos')
      .set({ status: 'estornado' })
      .where('id', '=', valid.id)
      .execute();
    await service.dispatch();
    expect(await states('payment_received')).toEqual(['suppressed']);
  });
  it('recovers missed finalization after a grace period with owner only, never newly-added historical members', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    await approved(owner, contribution);
    await seed({
      campaign: owner.campaign,
      tenant: owner.tenant,
      role: 'membro',
      permissions: ['extrato:ver'],
    });
    await service.scan();
    expect(await states('payment_received')).toEqual([]);
    now = new Date(now.getTime() + 11 * 60_000);
    await service.scan();
    await service.dispatch();
    expect(await states('payment_received')).toEqual(['sent']);
  });
  it('builds member payment CTA with the recipient slug and never their name as the mother', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    const member = await seed({
      campaign: owner.campaign,
      tenant: owner.tenant,
      role: 'membro',
      permissions: ['extrato:ver'],
    });
    await test.db
      .updateTable('usuarios')
      .set({ nome_exibicao: 'OwnerOnlyName' })
      .where('id', '=', owner.userId)
      .execute();
    const payment = await approved(owner, contribution);
    await service.paymentFinalized(payment);
    await service.dispatch();
    const message = (sink.messages.find((m) => m.includes(member.email)) ?? '').replace(
      /=\r\n/g,
      '',
    );
    expect(message.includes(`/painel/test-${member.userId.slice(0, 20)}/c/`)).toBe(true);
    expect(message.includes(`/painel/test-${owner.userId.slice(0, 20)}/c/`)).toBe(false);
  });
  it('advances durable cursors beyond a full page of ineligible new-campaign/old-account rows', async () => {
    const bad = await seed({ oldAccount: true });
    for (let i = 0; i < 101; i++) {
      const campaign = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      await test.db
        .insertInto('campanhas')
        .values({ id: campaign, id_plataforma: bad.tenant, titulo: 'old owner', criada_em: now })
        .execute();
      await sql`INSERT INTO lifecycle_email_first_gifts(campaign_id,occurred_at) VALUES(${campaign},${now})`.execute(
        test.db,
      );
    }
    const good = await seed();
    await gift(good);
    await service.scan();
    expect(await states('list_ready')).toEqual([]);
    await build().scan();
    await build().dispatch();
    expect(await states('list_ready')).toEqual(['sent']);
  });
  it('rejects backdated initial enable and changing the immutable persisted launch instant', async () => {
    await expect(
      build({ launchAt: new Date('2026-10-18T00:00:00Z') }).initialize(),
    ).rejects.toThrow('immutable');
    await sql`DELETE FROM lifecycle_email_rollout`.execute(test.db);
    await expect(service.initialize()).rejects.toThrow('past');
    await expect(build({ launchAt: now }).initialize()).resolves.toBeUndefined();
  });
  it('boots real production composition and pg-boss worker through a real TLS mail sink', async () => {
    const owner = await seed();
    const deps = buildServerDeps(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: test.connectionUri,
        BETTER_AUTH_SECRET: 'synthetic-long-test-secret-32-characters',
        BETTER_AUTH_URL: 'https://staging.example.invalid',
        TRUSTED_ORIGINS: 'https://staging.example.invalid',
        LIFECYCLE_EMAIL_ENABLED: 'true',
        LIFECYCLE_EMAIL_LAUNCH_AT: launch.toISOString(),
        LIFECYCLE_EMAIL_ALLOWED_RECIPIENTS: owner.email,
        SMTP_HOST: 'smtp.sendgrid.net',
        SMTP_PORT: String(sink.port),
        SMTP_SECURE: 'true',
        SMTP_USER: 'synthetic',
        SMTP_PASS: 'synthetic',
      }),
      { port: sink.port, ca: sink.ca },
    );
    try {
      await deps.boss.start();
      await registerLifecycleEmailJob(deps.boss, deps.lifecycleEmail, {
        assertAdmissionOpen: () => {},
        runJob: (operation) => operation(),
      });
      await deps.boss.send(LIFECYCLE_EMAIL_QUEUE, { schemaVersion: 1 });
      const until = Date.now() + 15_000;
      while ((await states('welcome'))[0] !== 'sent' && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await states('welcome')).toEqual(['sent']);
      expect(sink.messages).toHaveLength(1);
      const schedule = await deps.boss.getSchedules();
      expect(schedule.some((s) => s.name === LIFECYCLE_EMAIL_QUEUE)).toBe(true);
    } finally {
      await deps.boss.stop({ graceful: true });
      await deps.db.destroy();
    }
  });
  it('real magic-link account creation and default template produce one welcome and one ready email', async () => {
    const email = `signup-${randomUUID()}@example.invalid`;
    const origin = 'https://staging.example.invalid';
    const deps = buildServerDeps(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: test.connectionUri,
        BETTER_AUTH_SECRET: 'synthetic-long-test-secret-32-characters',
        BETTER_AUTH_URL: origin,
        TRUSTED_ORIGINS: origin,
        LIFECYCLE_EMAIL_ENABLED: 'true',
        LIFECYCLE_EMAIL_LAUNCH_AT: launch.toISOString(),
        LIFECYCLE_EMAIL_ALLOWED_RECIPIENTS: email,
        SMTP_HOST: 'smtp.sendgrid.net',
        SMTP_PORT: String(sink.port),
        SMTP_SECURE: 'true',
        SMTP_USER: 'synthetic',
        SMTP_PASS: 'synthetic',
      }),
      { port: sink.port, ca: sink.ca },
    );
    try {
      const categoria = makeCatalogoCategoria();
      const produto = makeCatalogoProduto(categoria.id, {
        imageUrl: '/catalogo/produtos/carrinho.webp',
      });
      const lista = makeCatalogoLista({ slug: `test-${randomUUID().slice(0, 12)}` });
      await deps.catalogoRepository.createCategoria(categoria);
      await deps.catalogoRepository.createProduto(produto);
      await deps.catalogoRepository.createLista(lista);
      await deps.catalogoRepository.replaceListaItens(lista.id, [
        makeCatalogoListaItem(lista.id, produto.id, { quantidade: 2 }),
      ]);
      await deps.catalogoRepository.setInitialCampaignDefault(lista.id, () => undefined);
      await deps.auth.api.signInMagicLink({
        body: { email, name: 'Synthetic Signup', callbackURL: '/' },
        headers: new Headers({ origin }),
      });
      const mime = (sink.messages[0] ?? '')
        .replace(/=\r\n/g, '')
        .replace(/=([0-9a-f]{2})/gi, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
      const url = mime.match(
        /https:\/\/staging\.example\.invalid\/api\/auth\/magic-link\/verify\?[^\s<"]+/,
      )?.[0];
      if (!url) throw new Error('Synthetic magic-link missing');
      const verified = await deps.auth.handler(
        new Request(url, { method: 'GET', redirect: 'manual' }),
      );
      const cookie = verified.headers
        .getSetCookie()
        .find((value) => value.includes('session_token='))
        ?.split(';')[0];
      if (!cookie) throw new Error('Synthetic session cookie missing');
      await resolverUsuarioAutenticado(deps, new Headers({ cookie }));
      await deps.lifecycleEmail.initialize();
      await deps.lifecycleEmail.scan();
      await deps.lifecycleEmail.dispatch();
      expect(await states('welcome')).toEqual(['sent']);
      expect(await states('list_ready')).toEqual(['sent']);
      expect(sink.messages).toHaveLength(3);
      await resolverUsuarioAutenticado(deps, new Headers({ cookie }));
      await deps.lifecycleEmail.scan();
      await deps.lifecycleEmail.dispatch();
      expect(sink.messages).toHaveLength(3);
    } finally {
      await deps.catalogoRepository.setInitialCampaignDefault(null, () => undefined);
      await deps.db.destroy();
    }
  });
  it('production finalizer admits only after the authoritative ledger and converges on replay', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    const payment = await approved(owner, contribution, false);
    const origin = 'https://staging.example.invalid';
    const deps = buildServerDeps(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: test.connectionUri,
        BETTER_AUTH_SECRET: 'synthetic-long-test-secret-32-characters',
        BETTER_AUTH_URL: origin,
        TRUSTED_ORIGINS: origin,
        LIFECYCLE_EMAIL_ENABLED: 'true',
        LIFECYCLE_EMAIL_LAUNCH_AT: launch.toISOString(),
        LIFECYCLE_EMAIL_ALLOWED_RECIPIENTS: owner.email,
        SMTP_HOST: 'smtp.sendgrid.net',
        SMTP_PORT: String(sink.port),
        SMTP_SECURE: 'true',
        SMTP_USER: 'synthetic',
        SMTP_PASS: 'synthetic',
      }),
      { port: sink.port, ca: sink.ca },
    );
    try {
      await finalizarPagamentoAprovado(deps, { idPagamento: payment.id });
      await finalizarPagamentoAprovado(deps, { idPagamento: payment.id });
      expect(await states('payment_received')).toEqual(['pending']);
      await deps.lifecycleEmail.dispatch();
      expect(await states('payment_received')).toEqual(['sent']);
      expect(sink.messages).toHaveLength(1);
    } finally {
      await deps.db.destroy();
    }
  });
  it('a real database outbox failure never compensates a successfully provisioned account', async () => {
    const origin = 'https://staging.example.invalid';
    const deps = buildServerDeps(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: test.connectionUri,
        BETTER_AUTH_SECRET: 'synthetic-long-test-secret-32-characters',
        BETTER_AUTH_URL: origin,
        TRUSTED_ORIGINS: origin,
      }),
    );
    const id = randomUUID();
    await sql`CREATE FUNCTION lifecycle_test_reject_plan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox unavailable'; END $$;
      CREATE TRIGGER lifecycle_test_reject_plan BEFORE INSERT OR UPDATE ON lifecycle_email_provisioned FOR EACH ROW EXECUTE FUNCTION lifecycle_test_reject_plan()`.execute(
      test.db,
    );
    try {
      const result = await provisionarContaUsuarioDominio(
        {
          ...deps,
          lifecycleProvisioningStarted: (user, campaign, count) =>
            deps.lifecycleEmail.provisioningStarted(user, campaign, count),
          lifecycleProvisioningCompleted: (user, campaign, count) =>
            deps.lifecycleEmail.provisioningCompleted(user, campaign, count),
        },
        {
          idUsuario: id,
          idPlataforma: '11111111-1111-4111-8111-111111111111',
          email: `${id}@example.invalid`,
          nome: 'Synthetic account',
        },
      );
      expect(await deps.usuarioRepository.findUsuarioById(result.usuario.id)).toBeDefined();
      expect(await deps.campanhaRepository.findById(result.campanha.id)).toBeDefined();
    } finally {
      await sql`DROP TRIGGER lifecycle_test_reject_plan ON lifecycle_email_provisioned; DROP FUNCTION lifecycle_test_reject_plan()`.execute(
        test.db,
      );
      await deps.db.destroy();
    }
  });
});
