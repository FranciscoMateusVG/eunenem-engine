/**
 * Shared visitor-page seed helpers (aperture-8ro9v, E2E Phase 1.2).
 *
 * The engine has NO `status`/`sold` column on `contribuicoes` (migration 019
 * collapsed the state machines). A gift's visitor status is DERIVED at query
 * time: it reads "sold" iff approved Pagamento rows whose intencao_items
 * (tipo='contribuicao') point at the contribuição sum to >= the contribuição's
 * `quantidade` (quantidadeRestante = quantidade - sum-of-approved-items).
 *
 * So to seed a SOLD-OUT gift we insert the contribuição AND one approved
 * Pagamento covering the full quantidade. Recipe mirrors the proven
 * `makeAprovadoPagamento` in tests/unit/arrecadacao/quantidade-restante.test.ts,
 * with the two Postgres-FK corrections that the memory-repo unit test ignores:
 *   - composicaoValoresAggregate.idCampanha MUST be the real seeded campanha id
 *     (pagamentos.intencao_id_campanha → campanhas.id, NOT NULL).
 *   - item.idContribuicao MUST be the real saved contribuição id
 *     (intencao_items.id_contribuicao → contribuicoes.id).
 *
 * Cents values are arbitrary but must satisfy line = unit * quantidade and the
 * aggregate totals; we copy the unit test's unit=100 / fee=10 / receiver=100.
 */
import { randomUUID } from 'node:crypto';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import type { Database } from '../src/adapters/database.js';
import { PagamentoRepositoryPostgres } from '../src/adapters/pagamentos/repository.postgres.js';
import { criarContribuicao } from '../src/domain/arrecadacao/entities/contribuicao.js';
import { criarItemContribuicao } from '../src/domain/pagamentos/entities/item-do-pagamento.js';
import { criarPagamentoPendente } from '../src/domain/pagamentos/entities/pagamento.js';

export interface SeedGiftRepos {
  readonly contribuicaoRepository: ContribuicaoRepositoryPostgres;
  readonly pagamentoRepository: PagamentoRepositoryPostgres;
}

/** Build the repos a seed helper needs from a raw db handle. */
export function buildSeedGiftRepos(db: Database): SeedGiftRepos {
  return {
    contribuicaoRepository: new ContribuicaoRepositoryPostgres(db),
    pagamentoRepository: new PagamentoRepositoryPostgres(db),
  };
}

export interface SeedGiftOptions {
  /** The real seeded campanha id (FK target). */
  readonly idCampanha: string;
  /** The 'presente' opção id so the gift surfaces on /pagina/:slug. */
  readonly idOpcaoPresentes: string;
  /** Gift display name — visitor cards key on this. */
  readonly nome: string;
  /** Gift cents value. */
  readonly valorCents: number;
  /** Slot quantity. Default 1. Keep 1 for legacy-multi-row rows. */
  readonly quantidade?: number;
}

/**
 * Seed an AVAILABLE (unsold) gift: just the contribuição, no pagamento.
 * Returns the contribuição id.
 */
export async function seedAvailableGift(
  repos: SeedGiftRepos,
  opts: SeedGiftOptions,
): Promise<string> {
  const id = randomUUID();
  const quantidade = opts.quantidade ?? 1;
  const contribuicao = criarContribuicao({
    id: id as never,
    idCampanha: opts.idCampanha as never,
    idOpcaoContribuicao: opts.idOpcaoPresentes as never,
    nome: opts.nome,
    valor: opts.valorCents as never,
    quantidade,
    criadaEm: new Date(),
  });
  await repos.contribuicaoRepository.save(contribuicao);
  return id;
}

/**
 * Seed a FULLY SOLD-OUT gift: the contribuição PLUS one approved Pagamento
 * whose contribuicao-item covers the full quantidade (so quantidadeRestante
 * = 0 → visitor status 'presenteado'). Returns the contribuição id.
 */
export async function seedSoldOutGift(
  repos: SeedGiftRepos,
  opts: SeedGiftOptions,
): Promise<string> {
  const idContribuicao = await seedAvailableGift(repos, opts);
  const q = opts.quantidade ?? 1;

  const item = criarItemContribuicao({
    id: randomUUID() as never,
    composicaoValoresItem: {
      tipo: 'contribuicao',
      idContribuicao: idContribuicao as never,
      quantidade: q,
      contributionUnitAmountCents: 100 as never,
      feeUnitAmountCents: 10 as never,
      receiverUnitAmountCents: 100 as never,
      lineContributionAmountCents: (100 * q) as never,
      lineFeeAmountCents: (10 * q) as never,
      lineReceiverAmountCents: (100 * q) as never,
    },
    criadoEm: new Date(),
  });

  const base = criarPagamentoPendente({
    idPagamento: randomUUID() as never,
    idIntencaoPagamento: randomUUID() as never,
    items: [item],
    composicaoValoresAggregate: {
      // REAL campanha id — pagamentos.intencao_id_campanha FK is NOT NULL.
      idCampanha: opts.idCampanha as never,
      totalContributionCents: (100 * q) as never,
      totalFeeCents: (10 * q) as never,
      totalReceiverCents: (100 * q) as never,
      totalSurchargeCents: 0,
      totalPaidCents: (110 * q) as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: (110 * q) as never,
    metodo: 'pix',
    criadoEm: new Date(),
  });

  // Shortcut to approved (bypasses aprovarPagamentoPendente — no
  // transacaoExterna needed; rowFromPagamento writes null when absent).
  const pagamento = { ...base, status: 'aprovado' as const };
  await repos.pagamentoRepository.save(pagamento);
  return idContribuicao;
}

export interface SeedPagamentoItemSpec {
  readonly nome: string;
  readonly valorCents: number;
  readonly quantidade?: number;
}

export interface SeedMultiItemResult {
  /** The approved pagamento's id — route /admin/pagamento/:id reads this. */
  readonly pagamentoId: string;
  /** The seeded contribuição ids, in the order their items were added. */
  readonly contribuicaoIds: string[];
}

/**
 * Seed ONE approved Pagamento carrying MULTIPLE contribuicao items (the
 * Phase-4 multi-item shape the admin PagamentoCard renders). Seeds a fresh
 * contribuição per item, builds one approved pagamento over all of them, and
 * returns the pagamento id + the contribuição ids.
 */
export async function seedMultiItemApprovedPagamento(
  repos: SeedGiftRepos,
  opts: {
    readonly idCampanha: string;
    readonly idOpcaoPresentes: string;
    readonly items: readonly SeedPagamentoItemSpec[];
  },
): Promise<SeedMultiItemResult> {
  const contribuicaoIds: string[] = [];
  const items: unknown[] = [];
  let totalContribution = 0;
  let totalFee = 0;
  let totalReceiver = 0;

  for (const spec of opts.items) {
    const q = spec.quantidade ?? 1;
    const idContribuicao = await seedAvailableGift(repos, {
      idCampanha: opts.idCampanha,
      idOpcaoPresentes: opts.idOpcaoPresentes,
      nome: spec.nome,
      valorCents: spec.valorCents,
      quantidade: q,
    });
    contribuicaoIds.push(idContribuicao);

    items.push(
      criarItemContribuicao({
        id: randomUUID() as never,
        composicaoValoresItem: {
          tipo: 'contribuicao',
          idContribuicao: idContribuicao as never,
          quantidade: q,
          contributionUnitAmountCents: 100 as never,
          feeUnitAmountCents: 10 as never,
          receiverUnitAmountCents: 100 as never,
          lineContributionAmountCents: (100 * q) as never,
          lineFeeAmountCents: (10 * q) as never,
          lineReceiverAmountCents: (100 * q) as never,
        },
        criadoEm: new Date(),
      }),
    );
    totalContribution += 100 * q;
    totalFee += 10 * q;
    totalReceiver += 100 * q;
  }

  const pagamentoId = randomUUID();
  const base = criarPagamentoPendente({
    idPagamento: pagamentoId as never,
    idIntencaoPagamento: randomUUID() as never,
    items: items as never,
    composicaoValoresAggregate: {
      idCampanha: opts.idCampanha as never,
      totalContributionCents: totalContribution as never,
      totalFeeCents: totalFee as never,
      totalReceiverCents: totalReceiver as never,
      totalSurchargeCents: 0,
      totalPaidCents: (totalContribution + totalFee) as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: (totalContribution + totalFee) as never,
    metodo: 'pix',
    criadoEm: new Date(),
  });
  const pagamento = { ...base, status: 'aprovado' as const };
  await repos.pagamentoRepository.save(pagamento);
  return { pagamentoId, contribuicaoIds };
}

export interface SeedPendenteResult {
  readonly pagamentoId: string;
  readonly externalRef: string;
  readonly idContribuicao: string;
}

/**
 * Seed a PENDENTE pagamento carrying an `externalRef` (the Stripe checkout
 * session id) so a checkout.session.completed webhook can resolve it via
 * findByExternalRef. Status stays 'pendente' (NOT flipped) — the webhook is
 * what advances it. Returns the pagamento id + externalRef + contribuição id.
 */
export async function seedPendentePagamento(
  repos: SeedGiftRepos,
  opts: {
    readonly idCampanha: string;
    readonly idOpcaoPresentes: string;
    readonly nome: string;
    readonly valorCents: number;
    readonly metodo: 'pix' | 'credit_card';
    readonly externalRef: string;
    readonly quantidade?: number;
    /**
     * Seed a non-null intencao.balanceTransactionAvailableOn. The card
     * finalizarPagamentoAprovado path needs this to build the financeiro
     * lançamento; in prod the dispatcher resolves it from the payment-intent
     * balance transaction, but criarPagamentoPendente always starts it null.
     * Pass a date to unblock the cartão webhook e2e (aperture-44mfy).
     */
    readonly balanceTransactionAvailableOn?: Date;
  },
): Promise<SeedPendenteResult> {
  const q = opts.quantidade ?? 1;
  const idContribuicao = await seedAvailableGift(repos, {
    idCampanha: opts.idCampanha,
    idOpcaoPresentes: opts.idOpcaoPresentes,
    nome: opts.nome,
    valorCents: opts.valorCents,
    quantidade: q,
  });

  const item = criarItemContribuicao({
    id: randomUUID() as never,
    composicaoValoresItem: {
      tipo: 'contribuicao',
      idContribuicao: idContribuicao as never,
      quantidade: q,
      contributionUnitAmountCents: 100 as never,
      feeUnitAmountCents: 10 as never,
      receiverUnitAmountCents: 100 as never,
      lineContributionAmountCents: (100 * q) as never,
      lineFeeAmountCents: (10 * q) as never,
      lineReceiverAmountCents: (100 * q) as never,
    },
    criadoEm: new Date(),
  });

  const pagamentoId = randomUUID();
  const pagamento = criarPagamentoPendente({
    idPagamento: pagamentoId as never,
    idIntencaoPagamento: randomUUID() as never,
    items: [item],
    composicaoValoresAggregate: {
      idCampanha: opts.idCampanha as never,
      totalContributionCents: (100 * q) as never,
      totalFeeCents: (10 * q) as never,
      totalReceiverCents: (100 * q) as never,
      totalSurchargeCents: 0,
      totalPaidCents: (110 * q) as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: (110 * q) as never,
    metodo: opts.metodo,
    externalRef: opts.externalRef,
    criadoEm: new Date(),
  });
  // Optionally seed a non-null balanceTransactionAvailableOn (nested under
  // intencao) so the card finalize path can build its financeiro lançamento.
  const pagamentoToSave = opts.balanceTransactionAvailableOn
    ? {
        ...pagamento,
        intencao: {
          ...pagamento.intencao,
          balanceTransactionAvailableOn: opts.balanceTransactionAvailableOn,
        },
      }
    : pagamento;
  // Stays pendente — the webhook advances it.
  await repos.pagamentoRepository.save(pagamentoToSave);
  return { pagamentoId, externalRef: opts.externalRef, idContribuicao };
}
