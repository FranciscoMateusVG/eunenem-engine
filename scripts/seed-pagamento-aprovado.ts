/**
 * seed-pagamento-aprovado — seeds ONE APROVADO pagamento (with the full
 * Financeiro effects) onto a given campanha, for the tier-2 E2E content
 * gate (the 'presentes recebidos' tile needs a per-campanha signal).
 *
 * Why real use-cases: every money-table invariant (composição per-item
 * via the RegraTaxa engine, aggregate totals, 2-lançamento shape per
 * contribuição item, contribuinte snapshot on the intencao) holds BY
 * CONSTRUCTION because the script composes the exact production flow:
 *
 *   1. `iniciarPagamentoCarrinho` — the same saga `pagina-router`'s
 *      `iniciarPagamentoContribuicao` calls (1-item cart, quantidade=1,
 *      metodo 'pix' so no surcharge item), with POSTGRES adapters and
 *      the same `ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED)` production
 *      wires in `apps/eunenem-server/server/auth/setup.ts`.
 *   2. `finalizarPagamentoAprovado` — the post-webhook process manager
 *      (aprovar + contribuinte stamp + registrar efeitos financeiros).
 *
 * No Stripe network calls: the `PagamentoProviderFake` covers BOTH ports
 * (CheckoutSessionProvider for the session, PagamentoProvider for the
 * approval). Its `idSessaoFactory` is pinned to the deterministic seed
 * ref, so `externalRef = cs_seed_tier2_<idCampanha>` — which doubles as
 * the idempotency key: re-runs find the pagamento via
 * `pagamentoRepository.findByExternalRef` and exit 0 without writing.
 *
 * Contribuição to pay for: the first NON-esgotada contribuição of the
 * campanha's 'presente' opção; if none exists (or all are sold out) one
 * is created via the real `criarContribuicao` use-case with `--valor`.
 *
 * Exit codes: 0 seeded (or already seeded); 1 on missing DATABASE_URL /
 * bad args / campanha not found / campanha without a 'presente' opção.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/seed-pagamento-aprovado.ts \
 *     --campanha <uuid> [--valor <cents, default 5000>]
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { CampanhaRepository } from '../src/adapters/arrecadacao/campanha-repository.js';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import type { ContribuicaoRepository } from '../src/adapters/arrecadacao/contribuicao-repository.js';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase } from '../src/adapters/database.js';
import type { PagamentoEventPublisher } from '../src/adapters/pagamentos/event-publisher.js';
import { PagamentoEventPublisherMemory } from '../src/adapters/pagamentos/event-publisher.memory.js';
import type { LivroFinanceiroRepository } from '../src/adapters/pagamentos/financeiro/livro-repository.js';
import { LivroFinanceiroRepositoryPostgres } from '../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { PagamentoProviderFake } from '../src/adapters/pagamentos/provider.fake.js';
import type { PagamentoRepository } from '../src/adapters/pagamentos/repository.js';
import { PagamentoRepositoryPostgres } from '../src/adapters/pagamentos/repository.postgres.js';
import type { ProvedorRegraTaxa } from '../src/adapters/taxas/regra-provider.js';
import {
  ProvedorRegraTaxaMemory,
  REGRAS_TAXA_SEED,
} from '../src/adapters/taxas/regra-provider.memory.js';
import type { Contribuicao } from '../src/domain/arrecadacao/entities/contribuicao.js';
import type { IdCampanha } from '../src/domain/arrecadacao/value-objects/ids.js';
import { IdCampanhaSchema } from '../src/domain/arrecadacao/value-objects/ids.js';
import type { MoneyCents } from '../src/domain/money.js';
import { MoneyCentsSchema } from '../src/domain/money.js';
import { ConsoleLogger } from '../src/observability/console-logger.js';
import type { Logger } from '../src/observability/logger.js';
import type { Observability } from '../src/observability/observability.js';
import { criarContribuicao } from '../src/use-cases/arrecadacao/criar-contribuicao.js';
import { esgotada } from '../src/use-cases/arrecadacao/quantidade-restante.js';
import { finalizarPagamentoAprovado } from '../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import { iniciarPagamentoCarrinho } from '../src/use-cases/checkout/iniciar-pagamento-carrinho.js';

/** Deterministic per-campanha idempotency key / fake session ref. */
export function seedExternalRef(idCampanha: IdCampanha): string {
  return `cs_seed_tier2_${idCampanha}`;
}

const CONTRIBUINTE_SEED = {
  nome: 'Seed Tier2',
  email: 'seed-tier2@example.com',
  // mensagem intentionally omitted (DadosContribuinteSchema.mensagem is
  // `.optional()`, not nullable) — the seeded recado stays empty.
} as const;

const NOME_CONTRIBUICAO_SEED = 'Presente semeado (tier-2)';

export interface SeedDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly observability: Observability;
  readonly clock: () => Date;
}

export interface SeedInput {
  readonly idCampanha: IdCampanha;
  readonly valor: MoneyCents;
}

/** One persisted row, for the caller's SQL-replay dump. */
export interface RowWritten {
  readonly table: string;
  readonly id: string;
  readonly detail: string;
}

export type SeedResult =
  | { readonly status: 'already-seeded'; readonly idPagamento: string }
  | {
      readonly status: 'seeded';
      readonly idPagamento: string;
      readonly externalRef: string;
      readonly rows: readonly RowWritten[];
    };

/**
 * Picks the first non-esgotada contribuição of the opção, or creates a
 * fresh one via the real `criarContribuicao` use-case. Returns the
 * contribuição + whether a row was written.
 */
async function garantirContribuicaoDisponivel(
  deps: SeedDeps,
  input: SeedInput,
  idOpcaoPresente: string,
): Promise<{ contribuicao: Contribuicao; criada: boolean }> {
  const { campanhaRepository, contribuicaoRepository, pagamentoRepository, observability, clock } =
    deps;

  const existentes = await contribuicaoRepository.findByOpcao(input.idCampanha, idOpcaoPresente);
  for (const candidata of existentes) {
    const soldOut = await esgotada(
      { pagamentoRepository, contribuicaoRepository, observability },
      { idContribuicao: candidata.id },
    );
    if (!soldOut) {
      return { contribuicao: candidata, criada: false };
    }
  }

  const contribuicao = await criarContribuicao(
    { campanhaRepository, contribuicaoRepository, clock, observability },
    {
      id: randomUUID(),
      idCampanha: input.idCampanha,
      idOpcaoContribuicao: idOpcaoPresente,
      nome: NOME_CONTRIBUICAO_SEED,
      valor: input.valor,
    },
  );
  return { contribuicao, criada: true };
}

/**
 * Seeds one APROVADO pagamento onto the campanha. Exported (vs. inlined
 * into main) so an integration test can call it with a test-container DB
 * + the same deps the CLI builds — mirrors p8i01-backfill-campanhas.
 */
export async function seedPagamentoAprovado(deps: SeedDeps, input: SeedInput): Promise<SeedResult> {
  const {
    campanhaRepository,
    contribuicaoRepository,
    pagamentoRepository,
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    provedorRegraTaxa,
    observability,
    clock,
  } = deps;
  const logger = observability.logger;

  const externalRef = seedExternalRef(input.idCampanha);

  // ─── idempotency gate: re-runs are a no-op ─────────────────────────
  const existing = await pagamentoRepository.findByExternalRef(externalRef);
  if (existing) {
    return { status: 'already-seeded', idPagamento: existing.id };
  }

  // ─── load campanha + find its 'presente' opção — fail loud ─────────
  const campanha = await campanhaRepository.findById(input.idCampanha);
  if (!campanha) {
    throw new Error(`Campanha ${input.idCampanha} nao encontrada.`);
  }
  const opcaoPresente = campanha.opcoes.find((o) => o.tipo === 'presente');
  if (!opcaoPresente) {
    throw new Error(
      `Campanha ${input.idCampanha} nao tem opcao 'presente' (opcoes: ${campanha.opcoes.length}).`,
    );
  }

  // ─── ensure a contribuição to pay for ──────────────────────────────
  const { contribuicao, criada: contribuicaoCriada } = await garantirContribuicaoDisponivel(
    deps,
    input,
    opcaoPresente.id,
  );

  // ─── fake provider, pinned to the deterministic seed ref ───────────
  // One instance covers BOTH ports, exactly like setup.ts's fresh-clone
  // fallback: CheckoutSessionProvider (session → externalRef) and
  // PagamentoProvider (solicitarPagamento → transacao aprovada whose
  // amountCents echoes the aggregate's totalPaidCents, satisfying
  // aprovarPagamento's amount-match invariant).
  const providerFake = new PagamentoProviderFake({
    statusResultado: 'aprovado',
    idSessaoFactory: () => externalRef,
  });

  // ─── step 1: intenção pendente via the production saga ─────────────
  // Same composition as pagina-router.iniciarPagamentoContribuicao:
  // 1-element cart, quantidade=1, server-minted UUIDs. metodo 'pix' so
  // the saga does NOT inject the surcharge item (idsItens length 1).
  const idPagamento = randomUUID();
  const { pagamento: pendente } = await iniciarPagamentoCarrinho(
    {
      campanhaRepository,
      contribuicaoRepository,
      provedorRegraTaxa,
      pagamentoRepository,
      pagamentoEventPublisher,
      checkoutSessionProvider: providerFake,
      clock,
      observability,
    },
    {
      idPlataforma: campanha.idPlataforma,
      idCampanha: campanha.id,
      itens: [{ idContribuicao: contribuicao.id, quantidade: 1 }],
      metodo: 'pix',
      idPagamento,
      idIntencaoPagamento: randomUUID(),
      idsItens: [randomUUID()],
      // The fake provider never redirects; template literal kept for
      // shape-parity with the router's server-built returnUrl.
      returnUrl: 'https://seed.invalid/sucesso?sessionId={CHECKOUT_SESSION_ID}',
    },
  );

  // ─── step 2: approve + register Financeiro effects (real saga) ─────
  const { pagamento, lancamentos } = await finalizarPagamentoAprovado(
    {
      pagamentoRepository,
      pagamentoProvider: providerFake,
      pagamentoEventPublisher,
      contribuicaoRepository,
      campanhaRepository,
      livroFinanceiroRepository,
      clock,
      observability,
    },
    { idPagamento: pendente.id, contribuinte: CONTRIBUINTE_SEED },
  );

  const rows: RowWritten[] = [
    ...(contribuicaoCriada
      ? [
          {
            table: 'contribuicoes',
            id: contribuicao.id,
            detail: `${NOME_CONTRIBUICAO_SEED} — ${contribuicao.valor}c`,
          },
        ]
      : []),
    {
      table: 'pagamentos',
      id: pagamento.id,
      detail: `aprovado — externalRef=${externalRef} — total ${pagamento.intencao.composicaoValoresAggregate.totalPaidCents}c`,
    },
    ...pagamento.intencao.items.map((item) => ({
      table: 'intencao_items',
      id: item.id,
      detail: `tipo=${item.tipo}`,
    })),
    ...lancamentos.map((lancamento) => ({
      table: 'lancamentos_financeiros',
      id: lancamento.id,
      detail: `${lancamento.tipo} — ${lancamento.amountCents}c`,
    })),
  ];

  logger.info('seed.pagamento_aprovado.seeded', {
    idCampanha: campanha.id,
    idContribuicao: contribuicao.id,
    idPagamento: pagamento.id,
    externalRef,
    lancamentosCount: lancamentos.length,
  });

  return { status: 'seeded', idPagamento: pagamento.id, externalRef, rows };
}

interface CliArgs {
  readonly idCampanha: IdCampanha;
  readonly valor: MoneyCents;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      campanha: { type: 'string' },
      valor: { type: 'string' },
    },
  });

  if (!values.campanha) {
    throw new Error('--campanha <uuid> is required');
  }
  const idCampanha = IdCampanhaSchema.parse(values.campanha);
  const valor = MoneyCentsSchema.parse(Number(values.valor ?? '5000'));
  return { idCampanha, valor };
}

/**
 * CLI entrypoint — runs only when this file is executed directly (not
 * when imported by tests). Builds the same adapter set setup.ts wires in
 * production (Postgres repos + PagamentoEventPublisherMemory +
 * ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED)), runs the seed, prints
 * every row written (table + id) for SQL-replay dumping, and exits.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.length === 0) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const args = parseCliArgs(process.argv.slice(2));

  const logger: Logger = new ConsoleLogger();
  const observability: Observability = {
    logger,
    // Tracer not wired up for a one-shot CLI — adapters fall back to the
    // no-op global tracer from @opentelemetry/api.
    tracer: (await import('@opentelemetry/api')).trace.getTracer('seed-pagamento-aprovado'),
  };

  const db = createDatabase(databaseUrl);
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  const campanhaRepository = new CampanhaRepositoryPostgres(db, recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryPostgres(db);
  const pagamentoRepository = new PagamentoRepositoryPostgres(db);
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryPostgres(db, recebedorRepository);
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED);

  try {
    const result = await seedPagamentoAprovado(
      {
        campanhaRepository,
        contribuicaoRepository,
        pagamentoRepository,
        pagamentoEventPublisher,
        livroFinanceiroRepository,
        provedorRegraTaxa,
        observability,
        clock: () => new Date(),
      },
      { idCampanha: args.idCampanha, valor: args.valor },
    );

    if (result.status === 'already-seeded') {
      console.log(`already seeded (pagamento ${result.idPagamento})`);
      return;
    }

    console.log(`seeded pagamento ${result.idPagamento} (externalRef ${result.externalRef})`);
    console.log('rows written:');
    for (const row of result.rows) {
      console.log(`  ${row.table} ${row.id} — ${row.detail}`);
    }
    console.log(JSON.stringify({ event: 'seed.pagamento_aprovado.summary', ...result }, null, 2));
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('seed.pagamento_aprovado.fatal', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
