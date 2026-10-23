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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('lifecycle real Postgres and loopback TLS SMTP', () => {
  let test: TestDatabase;
  let sink: Awaited<ReturnType<typeof createLifecycleSmtpSink>>;
  let transport: EmailTransportNodemailer;
  let service: LifecycleEmailService;
  let now: Date;
  const launch = new Date('2026-10-17T00:00:00Z');
  const logs: unknown[] = [];
  // Runtime-only synthetic SMTP auth accepted solely by the closed loopback sink.
  const smtpAuth = { user: randomUUID(), pass: randomUUID() };
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
        user: smtpAuth.user,
        pass: smtpAuth.pass,
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
  // The first-gift fact is stamped by the database clock; move the service
  // clock relative to it so the 24h list_ready delay is tested exactly.
  async function firstGiftAt(campaign: string) {
    const { rows } = await sql<{
      occurred_at: Date;
    }>`SELECT occurred_at FROM lifecycle_email_first_gifts WHERE campaign_id=${campaign}`.execute(
      test.db,
    );
    const occurred = rows[0]?.occurred_at;
    if (!occurred) throw new Error('first gift fact missing');
    return occurred;
  }
  async function elapseSinceFirstGift(campaign: string, ms: number) {
    now = new Date((await firstGiftAt(campaign)).getTime() + ms);
  }
  it('sends list_ready only 24h after the first gift, anchored to the first gift, once', async () => {
    const s = await seed();
    await gift(s);
    await elapseSinceFirstGift(s.campaign, 0);
    await service.scan();
    await service.dispatch();
    expect(await states('welcome')).toEqual(['sent']);
    expect(await states('list_ready')).toEqual([]);
    // A later gift through a raw insert does not restart nor advance the delay.
    await elapseSinceFirstGift(s.campaign, 23 * HOUR);
    await sql`INSERT INTO contribuicoes(id,campanha_id,id_opcao_contribuicao,nome,valor,criada_em)
      VALUES(${randomUUID()},${s.campaign},${s.option},'Another gift',5000,${now})`.execute(
      test.db,
    );
    await elapseSinceFirstGift(s.campaign, DAY - MINUTE);
    await Promise.all([service.scan(), service.scan()]);
    await service.dispatch();
    expect(await states('list_ready')).toEqual([]);
    await elapseSinceFirstGift(s.campaign, DAY - 1);
    await service.scan();
    expect(await states('list_ready')).toEqual([]);
    await elapseSinceFirstGift(s.campaign, DAY);
    await Promise.all([service.scan(), service.scan()]);
    expect(await states('list_ready')).toEqual(['pending']);
    await Promise.all([service.dispatch(), service.dispatch()]);
    expect(await states('list_ready')).toEqual(['sent']);
    const invites = sink.messages
      .map((m) => m.replace(/=\r\n/g, ''))
      .filter((m) => m.includes(`/c/${s.campaign}/convite`));
    expect(invites).toHaveLength(1);
    expect(sink.messages).toHaveLength(2);
    await elapseSinceFirstGift(s.campaign, 3 * DAY);
    await build().scan();
    await build().dispatch();
    expect(await states('list_ready')).toEqual(['sent']);
    expect(sink.messages).toHaveLength(2);
  });
  it('a due list_ready still waits for provisioning and the eligible owner cohort', async () => {
    const pending = await seed({ complete: false });
    await gift(pending);
    const old = await seed({ oldAccount: true });
    await gift(old);
    await elapseSinceFirstGift(pending.campaign, 2 * DAY);
    await service.scan();
    expect(await states('list_ready')).toEqual([]);
    await gift(pending);
    await service.scan();
    await service.dispatch();
    expect(await states('list_ready')).toEqual(['sent']);
  });
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
    await elapseSinceFirstGift(s.campaign, DAY);
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
    expect(sink.messages.join('\n').replace(/=\r\n/g, '')).toContain('23 de outubro');
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
    message?: string,
  ) {
    const payment = makePagamento({
      idCampanha: owner.campaign,
      idContribuicao: contribution,
      status: 'aprovado',
      criadoEm: now,
      ...(message !== undefined
        ? {
            contribuinte: {
              nome: 'Tia Synthetic',
              email: 'guest@example.invalid',
              mensagem: message,
            },
          }
        : {}),
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
  async function recipientsOf(type: string) {
    return (
      await sql<{
        user_id: string;
        state: string;
        reason: string | null;
      }>`SELECT user_id,state,reason FROM lifecycle_email_deliveries WHERE type=${type} ORDER BY user_id`.execute(
        test.db,
      )
    ).rows;
  }
  function decoded() {
    return sink.messages.map((m) => m.replace(/=\r\n/g, '').replace(/=3D/g, '='));
  }
  async function giftEmailsOff(...users: Awaited<ReturnType<typeof seed>>[]) {
    const prefs = new LifecycleEmailPreferencesPostgres(test.db);
    for (const u of users)
      await prefs.setPreferences(u.userId, u.tenant, { payment_received: false });
  }
  /** A deferred recado alert waits a minute for its payment email; drain both rounds. */
  async function dispatchUntilSettled(target: { dispatch(): Promise<void> } = service) {
    await target.dispatch();
    now = new Date(now.getTime() + 2 * MINUTE);
    await target.dispatch();
  }
  const guestLists = new Map<string, string>();
  async function guest(owner: Awaited<ReturnType<typeof seed>>, presenca = 'sim') {
    let lista = guestLists.get(owner.campaign);
    if (!lista) {
      const evento = randomUUID();
      lista = randomUUID();
      await sql`INSERT INTO eventos(id,id_campanha,data_hora)
        VALUES(${evento},${owner.campaign},${new Date('2026-12-01T15:00:00Z')})`.execute(test.db);
      await sql`INSERT INTO listas_de_convidados(id,id_evento,formato_mensagem_convite)
        VALUES(${lista},${evento},'texto')`.execute(test.db);
      guestLists.set(owner.campaign, lista);
    }
    const convidado = randomUUID();
    await sql`INSERT INTO convidados(id,lista_id,nome,numero_celular,presenca)
      VALUES(${convidado},${lista},'Vovó Synthetic','+55 11 90000-0000',${presenca})`.execute(
      test.db,
    );
    return convidado;
  }
  it('new_message goes to every owner and co-owner (never plain members), once per recipient, with the recado', async () => {
    const owner = await seed();
    const coOwner = await seed({ campaign: owner.campaign, tenant: owner.tenant, role: 'owner' });
    await seed({
      campaign: owner.campaign,
      tenant: owner.tenant,
      role: 'membro',
      permissions: ['extrato:ver'],
    });
    await giftEmailsOff(owner, coOwner);
    const contribution = await gift(owner);
    const payment = await approved(owner, contribution, true, 'Que venha com saúde <3');
    await Promise.all([service.paymentFinalized(payment), service.paymentFinalized(payment)]);
    await service.paymentFinalized(payment);
    await Promise.all([service.dispatch(), service.dispatch()]);
    await dispatchUntilSettled();
    const rows = await recipientsOf('new_message');
    expect(rows.map((r) => r.user_id).sort()).toEqual([owner.userId, coOwner.userId].sort());
    expect(rows.map((r) => r.state)).toEqual(['sent', 'sent']);
    const messages = decoded().filter((m) => m.includes('/mensagens'));
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.includes(owner.email))).toBe(true);
    expect(messages.some((m) => m.includes(coOwner.email))).toBe(true);
    expect(messages[0]).toContain('Tia Synthetic');
    expect(messages[0]).toContain('Que venha com sa');
    expect(messages[0]).toContain('&lt;3');
  });
  it('one email per payment: with Presentes recebidos on, the recado rides in it and new_message is suppressed', async () => {
    const owner = await seed();
    const coOwner = await seed({ campaign: owner.campaign, tenant: owner.tenant, role: 'owner' });
    await giftEmailsOff(coOwner);
    const contribution = await gift(owner);
    await service.paymentFinalized(await approved(owner, contribution, true, 'Recado único'));
    await dispatchUntilSettled();
    const alerts = await recipientsOf('new_message');
    expect(alerts.find((r) => r.user_id === owner.userId)).toMatchObject({
      state: 'suppressed',
      reason: 'covered_by_payment_received',
    });
    expect(alerts.find((r) => r.user_id === coOwner.userId)?.state).toBe('sent');
    const gifts = await recipientsOf('payment_received');
    expect(gifts.find((r) => r.user_id === owner.userId)?.state).toBe('sent');
    expect(gifts.find((r) => r.user_id === coOwner.userId)?.reason).toBe('opt_out');
    // Each owner got exactly one email for this payment, and both carry the recado.
    const mails = decoded();
    expect(mails).toHaveLength(2);
    expect(mails.filter((m) => m.includes(owner.email))).toHaveLength(1);
    expect(mails.filter((m) => m.includes(coOwner.email))).toHaveLength(1);
    expect(mails.every((m) => m.includes('Recado ') && m.includes('nico'))).toBe(true);
  });
  it('a suppressed payment email never silences the recado alert, even if Presentes recebidos is turned back on', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    const payment = await approved(owner, contribution, true, 'Não pode sumir');
    await giftEmailsOff(owner);
    await build({ enabledTypes: ['payment_received'] }).paymentFinalized(payment);
    await service.dispatch();
    expect(await recipientsOf('payment_received')).toMatchObject([
      { state: 'suppressed', reason: 'opt_out' },
    ]);
    // Turned back on before the recado alert goes out: the payment email is
    // already gone, so the alert is the only email left for this payment.
    await new LifecycleEmailPreferencesPostgres(test.db).setPreferences(
      owner.userId,
      owner.tenant,
      {
        payment_received: true,
      },
    );
    now = new Date(now.getTime() + 11 * MINUTE);
    await service.scan();
    await service.dispatch();
    expect(await recipientsOf('new_message')).toMatchObject([{ state: 'sent' }]);
    expect(decoded().filter((m) => m.includes('/mensagens'))).toHaveLength(1);
  });
  it('a recado alert claimed before its pending payment email waits for it instead of guessing', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    await service.paymentFinalized(await approved(owner, contribution, true, 'Ordem'));
    await sql`UPDATE lifecycle_email_deliveries SET next_attempt_at=${new Date(now.getTime() + MINUTE)}
      WHERE type='payment_received'`.execute(test.db);
    await service.dispatch();
    expect(await recipientsOf('new_message')).toMatchObject([{ state: 'pending' }]);
    expect(sink.messages).toHaveLength(0);
    now = new Date(now.getTime() + 2 * MINUTE);
    await service.dispatch();
    expect(await states('payment_received')).toEqual(['sent']);
    now = new Date(now.getTime() + 2 * MINUTE);
    await service.dispatch();
    expect(await recipientsOf('new_message')).toMatchObject([
      { state: 'suppressed', reason: 'covered_by_payment_received' },
    ]);
    expect(sink.messages).toHaveLength(1);
  });
  it('new_message is not admitted for a payment without a recado or a blank one', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    await service.paymentFinalized(await approved(owner, contribution));
    await service.paymentFinalized(await approved(owner, contribution, true, '   '));
    expect(await states('new_message')).toEqual([]);
    expect(await states('payment_received')).toEqual(['pending', 'pending']);
  });
  it('new_message respects each recipient preference independently of payment_received', async () => {
    const owner = await seed();
    const coOwner = await seed({ campaign: owner.campaign, tenant: owner.tenant, role: 'owner' });
    const prefs = new LifecycleEmailPreferencesPostgres(test.db);
    await prefs.setPreferences(coOwner.userId, coOwner.tenant, { new_message: false });
    await prefs.setPreferences(owner.userId, owner.tenant, { payment_received: false });
    const contribution = await gift(owner);
    await service.paymentFinalized(await approved(owner, contribution, true, 'Um beijo'));
    await dispatchUntilSettled();
    const rows = await recipientsOf('new_message');
    expect(rows.find((r) => r.user_id === owner.userId)?.state).toBe('sent');
    expect(rows.find((r) => r.user_id === coOwner.userId)).toMatchObject({
      state: 'suppressed',
      reason: 'opt_out',
    });
    const gifts = await recipientsOf('payment_received');
    expect(gifts.find((r) => r.user_id === owner.userId)?.reason).toBe('opt_out');
    expect(gifts.find((r) => r.user_id === coOwner.userId)?.state).toBe('sent');
  });
  it('new_message honours the master switch, launch cohort and allowlist gates', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    const payment = await approved(owner, contribution, true, 'Oi');
    await build({ enabled: false, launchAt: null }).paymentFinalized(payment);
    expect(await states('new_message')).toEqual([]);
    await build({ recipientAllowlist: ['someone-else@example.invalid'] }).paymentFinalized(payment);
    await build({ recipientAllowlist: ['someone-else@example.invalid'] }).dispatch();
    expect(await recipientsOf('new_message')).toMatchObject([
      { state: 'suppressed', reason: 'not_allowlisted' },
    ]);
    const old = await seed({ oldCampaign: true });
    const oldContribution = await gift(old);
    await service.paymentFinalized(await approved(old, oldContribution, true, 'Oi'));
    expect(await recipientsOf('new_message')).toHaveLength(1);
    expect(sink.messages).toHaveLength(0);
  });
  it('the scanner recovers a missed new_message after the grace period, owners only', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    await approved(owner, contribution, true, 'Chegou atrasado');
    await service.scan();
    expect(await states('new_message')).toEqual([]);
    now = new Date(now.getTime() + 11 * MINUTE);
    const coOwner = await seed({ campaign: owner.campaign, tenant: owner.tenant, role: 'owner' });
    await giftEmailsOff(owner, coOwner);
    await service.scan();
    await service.scan();
    await dispatchUntilSettled();
    const rows = await recipientsOf('new_message');
    expect(rows.map((r) => r.user_id).sort()).toEqual([owner.userId, coOwner.userId].sort());
    expect(rows.every((r) => r.state === 'sent')).toBe(true);
  });
  it('the scanner backfills new_message when only payment_received was admitted', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    const payment = await approved(owner, contribution, true, 'Só o recado faltou');
    await build({ enabledTypes: ['payment_received'] }).paymentFinalized(payment);
    expect(await states('payment_received')).toEqual(['pending']);
    expect(await states('new_message')).toEqual([]);
    now = new Date(now.getTime() + 11 * MINUTE);
    await service.scan();
    expect(await states('new_message')).toEqual(['pending']);
    expect(await states('payment_received')).toEqual(['pending']);
  });
  it('new_message is suppressed when the payment is no longer approved at send time', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    await giftEmailsOff(owner);
    const payment = await approved(owner, contribution, true, 'Oi');
    await service.paymentFinalized(payment);
    await test.db
      .updateTable('pagamentos')
      .set({ status: 'estornado' })
      .where('id', '=', payment.id)
      .execute();
    await dispatchUntilSettled();
    expect(await recipientsOf('new_message')).toMatchObject([
      { state: 'suppressed', reason: 'payment_not_approved' },
    ]);
  });
  it('presence_confirmed goes to owners and co-owners once per guest, even across sim→nao→sim', async () => {
    const owner = await seed();
    const coOwner = await seed({ campaign: owner.campaign, tenant: owner.tenant, role: 'owner' });
    await seed({
      campaign: owner.campaign,
      tenant: owner.tenant,
      role: 'membro',
      permissions: ['convidados:ver', 'extrato:ver'],
    });
    const convidado = await guest(owner);
    await Promise.all([
      service.presenceConfirmed(owner.campaign, convidado, 'Vovó Synthetic'),
      service.presenceConfirmed(owner.campaign, convidado, 'Vovó Synthetic'),
    ]);
    await service.dispatch();
    await service.presenceConfirmed(owner.campaign, convidado, 'Vovó Synthetic');
    await service.dispatch();
    const rows = await recipientsOf('presence_confirmed');
    expect(rows.map((r) => r.user_id).sort()).toEqual([owner.userId, coOwner.userId].sort());
    expect(rows.map((r) => r.state)).toEqual(['sent', 'sent']);
    const messages = decoded().filter((m) => m.includes('/convidados'));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('Vov');
    expect(sink.messages).toHaveLength(2);
  });
  it('presence_confirmed respects per-recipient opt-out and a guest who changed their answer', async () => {
    const owner = await seed();
    const coOwner = await seed({ campaign: owner.campaign, tenant: owner.tenant, role: 'owner' });
    await new LifecycleEmailPreferencesPostgres(test.db).setPreferences(
      coOwner.userId,
      coOwner.tenant,
      { presence_confirmed: false },
    );
    const convidado = await guest(owner);
    await service.presenceConfirmed(owner.campaign, convidado, 'Vovó Synthetic');
    await service.dispatch();
    let rows = await recipientsOf('presence_confirmed');
    expect(rows.find((r) => r.user_id === owner.userId)?.state).toBe('sent');
    expect(rows.find((r) => r.user_id === coOwner.userId)?.reason).toBe('opt_out');
    const changed = await guest(owner);
    await service.presenceConfirmed(owner.campaign, changed, 'Vovó Synthetic');
    await sql`UPDATE convidados SET presenca='nao' WHERE id=${changed}`.execute(test.db);
    await service.dispatch();
    rows = await recipientsOf('presence_confirmed');
    expect(rows.filter((r) => r.reason === 'presence_changed')).toHaveLength(1);
    expect(sink.messages).toHaveLength(1);
  });
  it('presence_confirmed ignores a guest of another campaign and pre-launch campaigns', async () => {
    const owner = await seed();
    const other = await seed();
    const foreign = await guest(other);
    await service.presenceConfirmed(owner.campaign, foreign, 'Intrusa');
    await service.dispatch();
    expect(await recipientsOf('presence_confirmed')).toMatchObject([
      { state: 'suppressed', reason: 'presence_changed' },
    ]);
    const old = await seed({ oldCampaign: true });
    await service.presenceConfirmed(old.campaign, await guest(old), 'Vovó');
    expect(await recipientsOf('presence_confirmed')).toHaveLength(1);
    expect(sink.messages).toHaveLength(0);
  });
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
  it('filters a full page of ineligible old-owner campaigns before limiting eligible candidates', async () => {
    const bad = await seed({ oldAccount: true });
    for (let i = 0; i < 101; i++) {
      const campaign = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      await test.db
        .insertInto('campanhas')
        .values({ id: campaign, id_plataforma: bad.tenant, titulo: 'old owner', criada_em: now })
        .execute();
      await test.db
        .insertInto('campanha_administradores')
        .values({ campanha_id: campaign, id_usuario: bad.accountId })
        .execute();
      await test.db
        .insertInto('campanha_membros_permissoes')
        .values({ campanha_id: campaign, id_conta: bad.accountId, papel: 'owner', permissoes: [] })
        .execute();
      await sql`INSERT INTO lifecycle_email_first_gifts(campaign_id,occurred_at) VALUES(${campaign},${now})`.execute(
        test.db,
      );
    }
    const good = await seed();
    await gift(good);
    await elapseSinceFirstGift(good.campaign, DAY);
    await service.scan();
    expect(await states('list_ready')).toEqual(['pending']);
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
  it.each([undefined, 'false'] as const)('keeps staging boot closed with opt-in %s', (flag) => {
    expect(() =>
      buildServerDeps(
        loadEnv({
          NODE_ENV: 'test',
          DATABASE_URL: test.connectionUri,
          BETTER_AUTH_SECRET: 'synthetic-long-test-secret-32-characters',
          BETTER_AUTH_URL: 'https://staging.example.invalid',
          LIFECYCLE_EMAIL_ENABLED: 'true',
          LIFECYCLE_EMAIL_LAUNCH_AT: launch.toISOString(),
          LIFECYCLE_EMAIL_ALLOW_ALL_RECIPIENTS: flag,
          TRUSTED_ORIGINS: 'https://staging.example.invalid',
          SMTP_HOST: 'smtp.sendgrid.net',
          SMTP_USER: smtpAuth.user,
          SMTP_PASS: smtpAuth.pass,
        }),
      ),
    ).toThrow('explicit recipient allowlist');
  });
  it.each([
    false,
    true,
  ])('empty allowlist dispatch with explicit allowAllRecipients=%s', async (allowAllRecipients) => {
    await seed();
    const configured = build({ recipientAllowlist: [], allowAllRecipients });
    await configured.scan();
    await configured.dispatch();
    expect(await states('welcome')).toEqual([allowAllRecipients ? 'sent' : 'suppressed']);
    expect(sink.messages).toHaveLength(allowAllRecipients ? 1 : 0);
  });
  it.each([
    'allowlist',
    'allow-all',
  ] as const)('boots real composition and TLS SMTP with %s', async (mode) => {
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
        ...(mode === 'allowlist'
          ? { LIFECYCLE_EMAIL_ALLOWED_RECIPIENTS: owner.email }
          : {
              LIFECYCLE_EMAIL_ALLOWED_RECIPIENTS: '',
              LIFECYCLE_EMAIL_ALLOW_ALL_RECIPIENTS: 'true',
            }),
        SMTP_HOST: 'smtp.sendgrid.net',
        SMTP_PORT: String(sink.port),
        SMTP_SECURE: 'true',
        SMTP_USER: smtpAuth.user,
        SMTP_PASS: smtpAuth.pass,
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
        SMTP_USER: smtpAuth.user,
        SMTP_PASS: smtpAuth.pass,
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
      // The production clock holds "seu chá já está pronto" for 24h after the first gift.
      expect(await states('list_ready')).toEqual([]);
      expect(sink.messages).toHaveLength(2);
      const { rows: firstGifts } = await sql<{
        campaign_id: string;
      }>`SELECT campaign_id FROM lifecycle_email_first_gifts`.execute(test.db);
      expect(firstGifts).toHaveLength(1);
      await elapseSinceFirstGift(firstGifts[0]?.campaign_id ?? '', DAY);
      await service.scan();
      await service.dispatch();
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
        SMTP_USER: smtpAuth.user,
        SMTP_PASS: smtpAuth.pass,
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
  it('production wiring admits owner alerts for a recado and an RSVP through the composition root', async () => {
    const owner = await seed();
    const contribution = await gift(owner);
    const payment = await approved(owner, contribution, true, 'Pelo composition root');
    const convidado = await guest(owner);
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
        SMTP_USER: smtpAuth.user,
        SMTP_PASS: smtpAuth.pass,
      }),
      { port: sink.port, ca: sink.ca },
    );
    try {
      await finalizarPagamentoAprovado(deps, { idPagamento: payment.id });
      await deps.lifecyclePresenceConfirmed?.(owner.campaign, convidado, 'Vovó Synthetic');
      expect(await states('new_message')).toEqual(['pending']);
      expect(await states('presence_confirmed')).toEqual(['pending']);
      await dispatchUntilSettled(deps.lifecycleEmail);
      // Presentes recebidos is on by default, so the recado rides in that email.
      expect(await recipientsOf('new_message')).toMatchObject([
        { state: 'suppressed', reason: 'covered_by_payment_received' },
      ]);
      expect(await states('payment_received')).toEqual(['sent']);
      expect(await states('presence_confirmed')).toEqual(['sent']);
      expect(sink.messages).toHaveLength(2);
      expect(decoded().some((m) => m.includes('Pelo composition root'))).toBe(true);
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
  it('rearms an unsent reminder when a removed date is restored on the same D−5 day', async () => {
    const owner = await seed();
    const id = randomUUID();
    const date = new Date('2026-10-22T03:00:00Z');
    await test.db
      .insertInto('eventos')
      .values({ id, id_campanha: owner.campaign, data_hora: date })
      .execute();
    await service.scan();
    await test.db.updateTable('eventos').set({ data_hora: null }).where('id', '=', id).execute();
    await service.dispatch();
    expect(await states('event_reminder')).toEqual(['suppressed']);
    await test.db.updateTable('eventos').set({ data_hora: date }).where('id', '=', id).execute();
    await service.scan();
    await service.dispatch();
    expect(await states('event_reminder')).toEqual(['sent']);
  });
  it('requires the same eligible campaign owner for hook admission and recovery, including members', async () => {
    const owner = await seed({ oldAccount: true });
    const contribution = await gift(owner);
    await seed({
      campaign: owner.campaign,
      tenant: owner.tenant,
      role: 'membro',
      permissions: ['extrato:ver'],
    });
    const payment = await approved(owner, contribution);
    await service.paymentFinalized(payment);
    expect(await states('payment_received')).toEqual([]);
    now = new Date(now.getTime() + 11 * 60_000);
    await service.scan();
    expect(await states('payment_received')).toEqual([]);
    const repository = new LifecycleEmailRepositoryPostgres(test.db);
    expect(await repository.recipients(launch, owner.campaign)).toEqual([]);
  });
  it('does not reset a new owner failed reminder because the former owner has a restorable row', async () => {
    const owner = await seed();
    const id = randomUUID();
    const date = new Date('2026-10-22T03:00:00Z');
    await test.db
      .insertInto('eventos')
      .values({ id, id_campanha: owner.campaign, data_hora: date })
      .execute();
    await service.scan();
    await test.db.updateTable('eventos').set({ data_hora: null }).where('id', '=', id).execute();
    await service.dispatch();
    expect(await states('event_reminder')).toEqual(['suppressed']);
    await test.db
      .updateTable('campanha_membros_permissoes')
      .set({ papel: 'membro', permissoes: [] })
      .where('campanha_id', '=', owner.campaign)
      .execute();
    const current = await seed({ campaign: owner.campaign, tenant: owner.tenant });
    // A genuinely different unsent date can admit the new owner.
    await test.db
      .updateTable('eventos')
      .set({ data_hora: new Date('2026-10-23T03:00:00Z') })
      .where('id', '=', id)
      .execute();
    now = new Date('2026-10-18T12:00:00Z');
    await service.scan();
    sink.setMode('reject');
    for (let i = 0; i < 3; i++) {
      await service.dispatch();
      now = new Date(now.getTime() + 10 * 60_000);
    }
    const currentDelivery = () =>
      test.db
        .selectFrom('lifecycle_email_deliveries')
        .select(['state', 'attempts'])
        .where('type', '=', 'event_reminder')
        .where('user_id', '=', current.userId)
        .executeTakeFirstOrThrow();
    expect(await currentDelivery()).toEqual({ state: 'failed', attempts: 3 });
    await service.scan();
    expect(await currentDelivery()).toEqual({ state: 'failed', attempts: 3 });
  });
});
