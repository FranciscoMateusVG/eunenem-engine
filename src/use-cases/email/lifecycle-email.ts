import { createHash } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { EmailTransport } from '../../adapters/email/email-transport.js';
import type {
  LifecycleEmailPreferencesRepository,
  LifecycleEmailType,
} from '../../adapters/email/lifecycle-email-preferences.js';
import {
  type Delivery,
  LIST_READY_DELAY_MS,
  type LifecycleEmailConfig,
  type LifecycleEmailRepository,
  type LifecycleEmailVars,
  type Snapshot,
} from '../../adapters/email/lifecycle-email-repository.js';
import type { LivroFinanceiroRepository } from '../../adapters/pagamentos/financeiro/livro-repository.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import { assertLancamentosConformamPagamento } from '../checkout/finalizar-pagamento-aprovado.js';

export type { LifecycleEmailConfig } from '../../adapters/email/lifecycle-email-repository.js';
export interface LifecycleEmailDeps {
  repository: LifecycleEmailRepository;
  preferences: LifecycleEmailPreferencesRepository;
  transport: EmailTransport;
  pagamentoRepository: PagamentoRepository;
  livroFinanceiroRepository: LivroFinanceiroRepository;
  render: (
    type: LifecycleEmailType,
    vars: LifecycleEmailVars,
  ) => { subject: string; html: string; text: string };
  links: (
    userId: string,
    tenantId: string,
    type: LifecycleEmailType,
    deliveryId: string,
  ) => Pick<LifecycleEmailVars, 'preferencesUrl' | 'unsubscribeUrl' | 'feedbackUrl'>;
  clock: () => Date;
  report: (event: string, data: { deliveryId?: string; reason?: string; count?: number }) => void;
}

export class LifecycleEmailService {
  constructor(
    private readonly deps: LifecycleEmailDeps,
    private readonly config: LifecycleEmailConfig,
  ) {
    if (config.enabled && (!config.launchAt || !Number.isFinite(config.launchAt.getTime())))
      throw new Error('Lifecycle email launch instant required');
  }
  private launchAt(): Date {
    if (!this.config.launchAt) throw new Error('Lifecycle launch missing');
    return this.config.launchAt;
  }
  private active(type?: LifecycleEmailType): boolean {
    return (
      this.config.enabled &&
      this.config.launchAt !== null &&
      (!type || !this.config.enabledTypes || this.config.enabledTypes.includes(type))
    );
  }
  async initialize(): Promise<void> {
    return lifecycleSpan('lifecycleEmail.initialize', async () => {
      if (this.active()) await this.deps.repository.initialize(this.launchAt(), this.deps.clock());
    });
  }
  async provisioningStarted(userId: string, campaignId: string, giftCount: number): Promise<void> {
    return lifecycleSpan('lifecycleEmail.provisioningStarted', async () => {
      await this.deps.repository.provisioningStarted(userId, campaignId, giftCount);
    });
  }
  async provisioningCompleted(
    userId: string,
    campaignId: string,
    giftCount: number,
  ): Promise<void> {
    return lifecycleSpan('lifecycleEmail.provisioningCompleted', async () => {
      await this.deps.repository.provisioningCompleted(
        userId,
        campaignId,
        giftCount,
        this.deps.clock(),
      );
    });
  }
  private recipients(campaignId: string | null, userId?: string, ownerOnly = false) {
    return this.deps.repository.recipients(this.launchAt(), campaignId, userId, ownerOnly);
  }
  private async admit(
    type: LifecycleEmailType,
    subjectId: string,
    campaignId: string | null,
    occurredAt: Date,
    snapshot: Snapshot,
    ownerOnly: boolean,
    userId?: string,
  ): Promise<void> {
    if (!this.active(type) || occurredAt < this.launchAt()) return;
    await this.deps.repository.admit(
      this.launchAt(),
      this.deps.clock(),
      type,
      subjectId,
      campaignId,
      occurredAt,
      snapshot,
      ownerOnly,
      userId,
    );
  }
  async paymentFinalized(payment: Pagamento, recovered = false): Promise<void> {
    return lifecycleSpan('lifecycleEmail.paymentFinalized', async () => {
      if (
        (!this.active('payment_received') && !this.active('new_message')) ||
        payment.status !== 'aprovado' ||
        payment.criadoEm < this.launchAt()
      )
        return;
      // Both hook and recovery validate the authoritative ledger, never just status.
      const ledger = await this.deps.livroFinanceiroRepository.findLancamentosByIdPagamento(
        payment.id,
      );
      assertLancamentosConformamPagamento(payment, ledger);
      const rows = await this.deps.repository.paymentGifts(payment.id);
      await this.admit(
        'payment_received',
        payment.id,
        payment.intencao.idCampanha,
        payment.criadoEm,
        {
          ...guestSnapshot(payment),
          gifts: rows
            .slice(0, 100)
            .map((r) => ({ name: r.name.slice(0, 200), quantity: r.quantity })),
        },
        recovered,
      );
      // A failed recado alert never blocks the gift email; the scanner backfills it.
      try {
        await this.messageReceived(payment);
      } catch {
        this.deps.report('lifecycle_email.message_admission_failed', {});
      }
    });
  }
  /** Owner alert for a recado; the caller already validated status and ledger. */
  private async messageReceived(payment: Pagamento): Promise<void> {
    if (!payment.intencao.contribuinte?.mensagem?.trim()) return;
    await this.admit(
      'new_message',
      payment.id,
      payment.intencao.idCampanha,
      payment.criadoEm,
      guestSnapshot(payment),
      true,
    );
  }
  /** Owner alert for a guest's RSVP "sim"; once per guest, whatever they answer later. */
  async presenceConfirmed(campaignId: string, guestId: string, guestName: string): Promise<void> {
    return lifecycleSpan('lifecycleEmail.presenceConfirmed', async () => {
      await this.admit(
        'presence_confirmed',
        guestId,
        campaignId,
        this.deps.clock(),
        { guestName: guestName.trim().slice(0, 200) || 'Um convidado' },
        true,
      );
    });
  }

  async scan(): Promise<void> {
    return lifecycleSpan('lifecycleEmail.scan', async () => {
      if (!this.active()) return;
      const now = this.deps.clock();
      await this.deps.repository.recoverProvisioning(now);
      const stale = await this.deps.repository.recoverStale(now);
      if (stale > 0) this.deps.report('lifecycle_email.unknown', { count: stale });
      const candidates = await this.deps.repository.candidates(this.launchAt(), now);
      for (const row of candidates.welcomes)
        await this.admit('welcome', row.id, null, row.created_at, {}, true, row.id);
      for (const row of candidates.gifts) {
        // Only ever admitted 24h after the first gift (the scanner is its sole admit path).
        if (now.getTime() - row.occurred_at.getTime() < LIST_READY_DELAY_MS) continue;
        await this.admit('list_ready', row.campaign_id, row.campaign_id, row.occurred_at, {}, true);
      }
      for (const row of candidates.reminders)
        await this.admit(
          'event_reminder',
          row.id_campanha,
          row.id_campanha,
          now,
          { eventDate: row.event_date },
          true,
        );
      for (const row of candidates.payments) {
        const payment = await this.deps.pagamentoRepository.findById(row.id);
        if (!payment) continue;
        try {
          await this.paymentFinalized(payment, true);
        } catch {
          /* Corrupt ledger: no admission; cursor still advances. */
        }
      }
      for (const row of candidates.messages) {
        if (!this.active('new_message')) break;
        const payment = await this.deps.pagamentoRepository.findById(row.id);
        if (!payment || payment.status !== 'aprovado' || payment.criadoEm < this.launchAt())
          continue;
        try {
          assertLancamentosConformamPagamento(
            payment,
            await this.deps.livroFinanceiroRepository.findLancamentosByIdPagamento(payment.id),
          );
          await this.messageReceived(payment);
        } catch {
          /* Corrupt ledger: no admission; cursor still advances. */
        }
      }
    });
  }
  async dispatch(limit = 100): Promise<void> {
    return lifecycleSpan('lifecycleEmail.dispatch', async () => {
      if (!this.active()) return;
      for (let i = 0; i < limit; i++) {
        const delivery = await this.deps.repository.claim(this.deps.clock());
        if (!delivery) return;
        await this.send(delivery);
      }
    });
  }
  private async coveredByPaymentEmail(recipient: { user_id: string; tenant_id: string }) {
    return (
      this.active('payment_received') &&
      (await this.deps.preferences.getPreferences(recipient.user_id, recipient.tenant_id))
        .payment_received
    );
  }
  private finish(id: string, state: string, reason: string): Promise<void> {
    return this.deps.repository.finish(id, state, reason, this.deps.clock());
  }
  private async send(delivery: Delivery): Promise<void> {
    const suppress = (reason: string) => this.finish(delivery.delivery_id, 'suppressed', reason);
    if (!this.active(delivery.type)) {
      await suppress('disabled');
      return;
    }
    const recipient = (
      await this.recipients(
        delivery.campaign_id,
        delivery.user_id,
        delivery.type !== 'payment_received',
      )
    )[0];
    if (
      recipient &&
      this.config.allowAllRecipients !== true &&
      this.config.recipientAllowlist &&
      !this.config.recipientAllowlist.includes(recipient.email.trim().toLowerCase())
    ) {
      await suppress('not_allowlisted');
      return;
    }
    if (!recipient || recipient.tenant_id !== delivery.tenant_id) {
      await suppress('recipient_ineligible');
      return;
    }
    if (
      !(await this.deps.preferences.getPreferences(recipient.user_id, recipient.tenant_id))[
        delivery.type
      ]
    ) {
      await suppress('opt_out');
      return;
    }
    // One email per payment: while this recipient gets "presente recebido" (which
    // already carries the recado), the separate recado alert stays silent.
    if (delivery.type === 'new_message' && (await this.coveredByPaymentEmail(recipient))) {
      await suppress('covered_by_payment_received');
      return;
    }
    if (delivery.type === 'payment_received' || delivery.type === 'new_message') {
      const payment = await this.deps.pagamentoRepository.findById(delivery.subject_id);
      if (!payment || payment.status !== 'aprovado') {
        await suppress('payment_not_approved');
        return;
      }
      try {
        assertLancamentosConformamPagamento(
          payment,
          await this.deps.livroFinanceiroRepository.findLancamentosByIdPagamento(payment.id),
        );
      } catch {
        await suppress('invalid_ledger');
        return;
      }
    }
    if (delivery.type === 'event_reminder') {
      const due = await this.deps.repository.reminderStillDue(
        delivery.campaign_id,
        delivery.snapshot.eventDate ?? '',
        this.deps.clock(),
      );
      if (!due) {
        await suppress('event_date_changed');
        return;
      }
    }
    if (
      delivery.type === 'presence_confirmed' &&
      !(await this.deps.repository.presenceStillConfirmed(
        delivery.campaign_id,
        delivery.subject_id,
      ))
    ) {
      await suppress('presence_changed');
      return;
    }
    const ownerName = await this.deps.repository.ownerName(delivery.campaign_id);
    const origin = new URL(this.config.origin).origin;
    const dashboard = `${origin}/painel/${encodeURIComponent(recipient.slug)}${delivery.campaign_id ? `/c/${delivery.campaign_id}` : ''}`;
    const giftCount = await this.deps.repository.giftCount(delivery.campaign_id);
    const vars: LifecycleEmailVars = {
      recipientName: recipient.name,
      ownerName: ownerName ?? (recipient.owner ? recipient.name : ''),
      dashboardUrl: dashboard,
      startUrl: dashboard,
      shareUrl: `${dashboard}/convite`,
      assetBaseUrl: origin,
      giftCount,
      recipientIsOwner: recipient.owner,
      gifts: delivery.snapshot.gifts ?? [],
      ...delivery.snapshot,
      ...(delivery.snapshot.eventDate
        ? {
            eventDate: new Intl.DateTimeFormat('pt-BR', {
              timeZone: 'America/Sao_Paulo',
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }).format(new Date(`${delivery.snapshot.eventDate}T12:00:00Z`)),
          }
        : {}),
      ...this.deps.links(
        recipient.user_id,
        recipient.tenant_id,
        delivery.type,
        delivery.delivery_id,
      ),
    };
    const message = this.deps.render(delivery.type, vars);
    const emailKey = createHash('sha256')
      .update(`${delivery.id}:${recipient.email.trim().toLowerCase()}`)
      .digest('hex');
    const reserved = await this.deps.repository.reserveEmail(
      delivery.id,
      delivery.delivery_id,
      emailKey,
    );
    if (!reserved) {
      await suppress('duplicate_address');
      return;
    }
    // Revalidate the exact current verified address, permission, opt-out and
    // event state after all rendering/claim work. Network races remain, but a
    // changed address must never authorize sending to the stale address.
    const latestRecipient = (
      await this.recipients(
        delivery.campaign_id,
        recipient.user_id,
        delivery.type !== 'payment_received',
      )
    )[0];
    if (
      !latestRecipient ||
      latestRecipient.email.trim().toLowerCase() !== recipient.email.trim().toLowerCase() ||
      !(await this.deps.preferences.getPreferences(recipient.user_id, recipient.tenant_id))[
        delivery.type
      ]
    ) {
      await suppress('recipient_changed');
      return;
    }
    if (delivery.type === 'new_message' && (await this.coveredByPaymentEmail(recipient))) {
      await suppress('covered_by_payment_received');
      return;
    }
    if (
      (delivery.type === 'payment_received' || delivery.type === 'new_message') &&
      (await this.deps.pagamentoRepository.findById(delivery.subject_id))?.status !== 'aprovado'
    ) {
      await suppress('payment_not_approved');
      return;
    }
    if (
      delivery.type === 'event_reminder' &&
      !(await this.deps.repository.reminderStillDue(
        delivery.campaign_id,
        delivery.snapshot.eventDate ?? '',
        this.deps.clock(),
      ))
    ) {
      await suppress('event_date_changed');
      return;
    }
    if (
      delivery.type === 'presence_confirmed' &&
      !(await this.deps.repository.presenceStillConfirmed(
        delivery.campaign_id,
        delivery.subject_id,
      ))
    ) {
      await suppress('presence_changed');
      return;
    }
    try {
      await this.deps.transport.enviar({
        to: recipient.email,
        ...message,
        disableClickTracking: true,
        disableOpenTracking: true,
      });
    } catch (error) {
      const safe = definitelyRejected(error);
      const permanent =
        typeof error === 'object' &&
        error !== null &&
        (('responseCode' in error &&
          typeof error.responseCode === 'number' &&
          error.responseCode >= 500) ||
          ('code' in error && ['EAUTH', 'ETRACKINGPOLICY'].includes(String(error.code))));
      if (safe && !permanent && delivery.attempts < 3) {
        await this.deps.repository.retry(
          delivery.delivery_id,
          new Date(this.deps.clock().getTime() + 60_000 * 2 ** delivery.attempts),
        );
      } else {
        await this.finish(
          delivery.delivery_id,
          safe ? 'failed' : 'unknown',
          safe ? 'smtp_rejected' : 'smtp_ambiguous',
        );
        if (!safe)
          this.deps.report('lifecycle_email.unknown', {
            deliveryId: delivery.delivery_id,
            reason: 'smtp_ambiguous',
          });
      }
      return;
    }
    // A crash or DB failure here leaves sending -> unknown, NEVER a blind retry.
    await this.finish(delivery.delivery_id, 'sent', 'accepted');
  }
}
function guestSnapshot(payment: Pagamento): Snapshot {
  const mensagem = payment.intencao.contribuinte?.mensagem;
  return {
    guestName: (payment.intencao.contribuinte?.nome || 'Uma pessoa querida').slice(0, 200),
    ...(mensagem ? { guestMessage: mensagem.slice(0, 2000) } : {}),
  };
}
function definitelyRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; responseCode?: unknown; command?: unknown };
  return (
    e.code === 'EAUTH' ||
    e.code === 'EDNS' ||
    e.code === 'ETRACKINGPOLICY' ||
    (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 600)
  );
}

async function lifecycleSpan<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return trace.getTracer('frame').startActiveSpan(name, async (span) => {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(new Error('Lifecycle email operation failed'));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
