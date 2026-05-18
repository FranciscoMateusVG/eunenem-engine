import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { MoneyCents } from '../domain/money.js';
import {
  type IdTransacaoExterna,
  IdTransacaoExternaSchema,
  type NomeProvedorPagamento,
  type StatusTransacaoExterna,
  type TransacaoExterna,
  TransacaoExternaSchema,
} from '../domain/pagamentos.js';
import type { PagamentoProvider, SolicitarPagamentoInput } from './pagamento-provider.js';

const tracer = trace.getTracer('frame');

export interface PagamentoProviderFakeOptions {
  readonly nomeProvedor?: NomeProvedorPagamento;
  readonly statusResultado?: StatusTransacaoExterna;
  readonly idTransacaoFactory?: () => string;
  readonly clock?: () => Date;
  readonly amountCentsTransacao?: MoneyCents;
}

/**
 * Provedor fake determinístico para testes e aprendizagem, sem rede e sem SDK externo.
 */
export class PagamentoProviderFake implements PagamentoProvider {
  private readonly nomeProvedor: NomeProvedorPagamento;
  private readonly statusResultado: StatusTransacaoExterna;
  private readonly idTransacaoFactory: () => string;
  private readonly clock: () => Date;
  private readonly amountCentsTransacao: MoneyCents | undefined;

  constructor(options: PagamentoProviderFakeOptions = {}) {
    this.nomeProvedor = options.nomeProvedor ?? 'fake-provider';
    this.statusResultado = options.statusResultado ?? 'aprovado';
    this.idTransacaoFactory = options.idTransacaoFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
    this.amountCentsTransacao = options.amountCentsTransacao;
  }

  async solicitarPagamento(input: SolicitarPagamentoInput): Promise<TransacaoExterna> {
    return tracer.startActiveSpan('payment_provider.fake.solicitarPagamento', async (span) => {
      span.setAttribute('payment.id', input.idPagamento);
      span.setAttribute('payment.intent.id', input.idIntencaoPagamento);
      span.setAttribute('payment.amount_cents', input.amountCents);
      span.setAttribute('payment.method', input.metodo);

      try {
        const idTransacao = IdTransacaoExternaSchema.parse(
          this.idTransacaoFactory(),
        ) as IdTransacaoExterna;
        const transacao = TransacaoExternaSchema.parse({
          id: idTransacao,
          provedor: this.nomeProvedor,
          status: this.statusResultado,
          amountCents: this.amountCentsTransacao ?? input.amountCents,
          criadaEm: this.clock(),
          statusBruto: this.statusResultado,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return transacao;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
