/**
 * Repasse (Inter PIX payout) E2E seed + DB-observe helpers (aperture-r5y94).
 *
 * The /admin/repasses browser walks need a repasse in a controllable state
 * with a recebedor whose PIX chave is an E2E magic marker (aperture-4ifbm) —
 * `TransferenciaProviderFake.pagarPix` reads `input.chave` (fed straight from
 * `recebedor.chavePix` in executar-transferencia-repasse.ts) and selects the
 * outcome from the marker. So "forcing an outcome" == "set the recebedor's
 * chave to `e2e-outcome-<OUTCOME>[-consult-<STATUS>][-search-hit]@fake…`".
 *
 * These helpers seed DIRECTLY against the E2E Postgres (same DB the running
 * :3002 server reads), mirroring tests/integration/jguar-repasse-pgboss's
 * makeRepasse + seedLancamentoParents + saveLancamentos recipe, but attaching
 * a REAL usuario+campanha+recebedor so the server's executar path can load the
 * recebedor by campanha and drive the fake rail.
 *
 * DB assertions read the raw rows (repasses_recebedor / lancamentos_financeiros
 * / repasse_reconciliacao_candidatos) — settlement lands on the lançamento
 * (`transferido_em`), cancellation releases the funds-claim lock (`id_repasse`
 * back to NULL). There is no `transferido_em`/`cancelado_em` on the repasse row.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { LivroFinanceiroRepositoryPostgres } from '../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../src/adapters/usuario/auth-service.better-auth.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import { criarRecebedorInicial } from '../src/domain/arrecadacao/entities/recebedor.js';
import type { IdCampanha } from '../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type { IdRepasse } from '../src/domain/pagamentos/financeiro/value-objects/ids.js';
import { NoopLogger } from '../src/observability/noop-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import { gerarTransferReferencia } from '../src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
import { criarSessaoUsuario } from '../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../src/use-cases/usuario/registrar-conta-usuario.js';
import { seedLancamentoParents } from '../tests/helpers/seed-lancamento-parents.js';

export const REPASSE_SEED_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

const T0 = new Date('2026-07-16T12:00:00Z');

/** Build an E2E DB handle. Caller owns the lifecycle (destroy in finally). */
export function openSeedDb(): Database {
  return createDatabase(REPASSE_SEED_DATABASE_URL);
}

function buildRepasseSeedDeps(db: Database) {
  const logger = new NoopLogger();
  const observability = { logger, tracer: noopTracer() };
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  return {
    usuarioRepository: new UsuarioRepositoryPostgres(db),
    plataformaRepository: new PlataformaRepositoryMemory(),
    campanhaRepository: new CampanhaRepositoryPostgres(db, recebedorRepository),
    recebedorRepository,
    contribuicaoRepository: new ContribuicaoRepositoryPostgres(db),
    authService: new AuthServiceBetterAuth(db, { clock: () => new Date() }),
    clock: () => new Date(),
    observability,
  };
}

export interface SeededCampanhaOwner {
  idCampanha: IdCampanha;
  idRecebedor: string;
  slug: string;
  email: string;
  /** BetterAuth session token for the campaign OWNER (a non-admin). */
  sessionToken: string;
}

/**
 * Seed a fresh usuario + campanha + active PIX recebedor whose chave PIX is the
 * given magic marker. Returns the owner's identifiers + a non-admin session
 * token (used for the extrato view + the RBAC-denial walk).
 */
export async function seedCampanhaOwner(
  db: Database,
  chavePix: string,
): Promise<SeededCampanhaOwner> {
  const deps = buildRepasseSeedDeps(db);
  const runSuffix = randomUUID().slice(0, 8);
  // Unique suffix MUST lead the first name token — the slug base derives from
  // it and a shared base exhausts the collision walk (aperture-8jcec).
  const nomeExibicao = `E2e${runSuffix} Repasse`;
  const email = `e2e-repasse-${runSuffix}@e2e.local`;

  const { usuario, campanha } = await registrarContaUsuario(deps, {
    idUsuario: randomUUID() as never,
    idConta: randomUUID() as never,
    idPlataforma: ID_PLATAFORMA_EUNENEM as never,
    email,
    nomeExibicao,
    senhaSimulada: 'senha-e2e-repasse-123',
  });

  const idRecebedor = randomUUID();
  const recebedor = criarRecebedorInicial({
    id: idRecebedor as never,
    idCampanha: campanha.id,
    dadosRecebedor: {
      metodo: 'pix',
      nomeTitular: nomeExibicao,
      // Checksum-valid canonical fake CPF (recebedores_variante_check requires
      // cpf_titular NOT NULL for the pix variant — migration 036).
      cpfTitular: '11144477735',
      tipoChavePix: 'email',
      chavePix,
    },
    criadaEm: deps.clock(),
  });
  await deps.recebedorRepository.save(recebedor);

  const sessao = await criarSessaoUsuario(deps, {
    idPlataforma: ID_PLATAFORMA_EUNENEM as never,
    email,
    senhaSimulada: 'senha-e2e-repasse-123',
  });

  return {
    idCampanha: campanha.id,
    idRecebedor,
    slug: usuario.slug,
    email,
    sessionToken: sessao.token,
  };
}

/** Swap the recebedor's chave PIX (drives the next executar's forced outcome). */
export async function setRecebedorChave(
  db: Database,
  idRecebedor: string,
  chavePix: string,
): Promise<void> {
  await sql`
    UPDATE recebedores SET chave_pix = ${chavePix} WHERE id = ${idRecebedor}
  `.execute(db);
}

function makeRepasse(args: {
  id: string;
  idCampanha: string;
  status: RepasseRecebedor['status'];
  amountCents: number;
  transferReferencia?: string | null;
  transferAttempts?: number;
  needsManualResolution?: boolean;
}): RepasseRecebedor {
  return {
    id: args.id as IdRepasse,
    idCampanha: args.idCampanha as IdCampanha,
    amountCents: args.amountCents as never,
    status: args.status,
    solicitadoEm: T0,
    aprovadoEm: args.status === 'solicitado' ? null : T0,
    bankTransferRef: null,
    transferReferencia: args.transferReferencia ?? null,
    interCodigoSolicitacao: null,
    transferAttempts: args.transferAttempts ?? 0,
    lastTransferError: null,
    needsManualResolution: args.needsManualResolution ?? false,
  };
}

/**
 * seedLancamentoParents seeds the intencao_items + pagamentos rows with ALL
 * amount columns at 0. That is invisible to repository/FSM tests but the admin
 * `show` DTO hydrates the full pagamento snapshot, whose composição schemas
 * require every amount > 0 with tight cross-field invariants
 * (snapshot-composicao-valores-{item,aggregate}.ts):
 *   ITEM (contribuição): line === unit × quantidade; receiverUnit === contributionUnit.
 *   AGGREGATE: total* === Σ line* over items; receiver + fee + surcharge === paid;
 *              responsavelTaxa='contribuinte' ⇒ receiver === contribution.
 * Patch the single seeded item + its pagamento to a valid, consistent
 * composition (qty 1, one contribuição item, no surcharge).
 */
const FEE_CENTS = 1; // any strictly-positive fee; independent of contribution

async function patchComposition(
  db: Database,
  args: { idItemPagamento: string; idPagamento: string; amountCents: number },
): Promise<void> {
  await sql`
    UPDATE intencao_items SET
      quantidade = 1,
      contribution_unit_amount_cents = ${args.amountCents},
      receiver_unit_amount_cents = ${args.amountCents},
      fee_unit_amount_cents = ${FEE_CENTS},
      line_contribution_amount_cents = ${args.amountCents},
      line_receiver_amount_cents = ${args.amountCents},
      line_fee_amount_cents = ${FEE_CENTS}
    WHERE id = ${args.idItemPagamento}
  `.execute(db);
  await sql`
    UPDATE pagamentos SET
      intencao_total_contribution_cents = ${args.amountCents},
      intencao_total_receiver_cents = ${args.amountCents},
      intencao_total_fee_cents = ${FEE_CENTS},
      intencao_total_surcharge_cents = 0,
      intencao_total_paid_cents = ${args.amountCents + FEE_CENTS}
    WHERE id = ${args.idPagamento}
  `.execute(db);
}

function makeClaimedLancamento(args: {
  idCampanha: string;
  idRepasse: string;
  amountCents: number;
}): LancamentoFinanceiro {
  return {
    id: randomUUID() as never,
    idPagamento: randomUUID() as never,
    idItemPagamento: randomUUID() as never,
    idContribuicao: randomUUID() as never,
    idCampanha: args.idCampanha as never,
    tipo: 'credito_saldo_recebedor',
    amountCents: args.amountCents as never,
    criadoEm: T0,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: args.idRepasse as never,
  };
}

export interface SeededRepasse {
  idRepasse: string;
  idLancamento: string;
}

/**
 * Seed a `solicitado` repasse with one claimed `credito_saldo_recebedor`
 * lançamento (id_repasse set, transferido_em NULL). This is the starting state
 * for the admin Aprovar flow (walks 1/2/3).
 */
export async function seedSolicitadoRepasse(
  db: Database,
  args: { idCampanha: string; amountCents: number },
): Promise<SeededRepasse> {
  const idRepasse = randomUUID();
  const repo = new LivroFinanceiroRepositoryPostgres(db, new RecebedorRepositoryPostgres(db));
  await repo.saveRepasse(
    makeRepasse({
      id: idRepasse,
      idCampanha: args.idCampanha,
      status: 'solicitado',
      amountCents: args.amountCents,
    }),
  );
  const lancamento = makeClaimedLancamento({
    idCampanha: args.idCampanha,
    idRepasse,
    amountCents: args.amountCents,
  });
  await seedLancamentoParents(db, [lancamento]);
  await patchComposition(db, {
    idItemPagamento: lancamento.idItemPagamento as unknown as string,
    idPagamento: lancamento.idPagamento as unknown as string,
    amountCents: args.amountCents,
  });
  await repo.saveLancamentos([lancamento]);
  return { idRepasse, idLancamento: lancamento.id as unknown as string };
}

export interface SeededCandidate {
  codigoSolicitacao: string;
  valorCents: number;
  chaveMascarada: string | null;
  descricaoPix: string | null;
  dataMovimento: string | null;
}

/**
 * Seed a `verificando` repasse FLAGGED needs-manual-resolution with persisted
 * reconciliation candidates. This is the starting state for the manual-
 * resolution UI walk (walk 4). We seed the terminal-ish parked state directly
 * rather than driving the async confirmar poll (CONFIRMAR_DELAY_INICIAL = 30s,
 * too slow for a browser walk) — the UI resolution mutations are the coverage.
 */
export async function seedVerificandoNeedsManual(
  db: Database,
  args: {
    idCampanha: string;
    amountCents: number;
    candidates: readonly SeededCandidate[];
  },
): Promise<SeededRepasse> {
  const idRepasse = randomUUID();
  const repo = new LivroFinanceiroRepositoryPostgres(db, new RecebedorRepositoryPostgres(db));
  await repo.saveRepasse(
    makeRepasse({
      id: idRepasse,
      idCampanha: args.idCampanha,
      status: 'verificando',
      amountCents: args.amountCents,
      transferReferencia: gerarTransferReferencia(idRepasse as IdRepasse),
      transferAttempts: 1,
      needsManualResolution: true,
    }),
  );
  // rowFromRepasse (the saveRepasse mapper) only writes id/campanha/amount/
  // status/solicitado/aprovado/bank_ref — it DROPS needs_manual_resolution +
  // transfer_attempts (production only ever sets those via a later UPDATE, as
  // repasses are always INSERTED at 'solicitado'). Force the parked-for-manual
  // shape directly so the show DTO renders ManualResolutionActions.
  await sql`
    UPDATE repasses_recebedor
      SET needs_manual_resolution = TRUE, transfer_attempts = 1
      WHERE id = ${idRepasse}
  `.execute(db);
  const lancamento = makeClaimedLancamento({
    idCampanha: args.idCampanha,
    idRepasse,
    amountCents: args.amountCents,
  });
  await seedLancamentoParents(db, [lancamento]);
  await patchComposition(db, {
    idItemPagamento: lancamento.idItemPagamento as unknown as string,
    idPagamento: lancamento.idPagamento as unknown as string,
    amountCents: args.amountCents,
  });
  await repo.saveLancamentos([lancamento]);

  for (const c of args.candidates) {
    await sql`
      INSERT INTO repasse_reconciliacao_candidatos
        (id, repasse_id, codigo_solicitacao, valor_cents, data_movimento,
         chave_mascarada, descricao_pix, criado_em)
      VALUES
        (${randomUUID()}, ${idRepasse}, ${c.codigoSolicitacao}, ${c.valorCents},
         ${c.dataMovimento}, ${c.chaveMascarada}, ${c.descricaoPix}, ${T0})
    `.execute(db);
  }
  return { idRepasse, idLancamento: lancamento.id as unknown as string };
}

// ── DB observers ────────────────────────────────────────────────────────

export interface RepasseRow {
  status: string;
  needs_manual_resolution: boolean;
  transfer_attempts: number;
  inter_codigo_solicitacao: string | null;
}

export async function getRepasseRow(
  db: Database,
  idRepasse: string,
): Promise<RepasseRow | undefined> {
  const result = await sql<RepasseRow>`
    SELECT status, needs_manual_resolution, transfer_attempts, inter_codigo_solicitacao
      FROM repasses_recebedor WHERE id = ${idRepasse}
  `.execute(db);
  return result.rows[0];
}

export interface LancamentoRow {
  id_repasse: string | null;
  transferido_em: Date | null;
  cancelado_em: Date | null;
}

export async function getLancamentosForRepasse(
  db: Database,
  idRepasse: string,
): Promise<LancamentoRow[]> {
  const result = await sql<LancamentoRow>`
    SELECT id_repasse, transferido_em, cancelado_em
      FROM lancamentos_financeiros WHERE id_repasse = ${idRepasse}
  `.execute(db);
  return [...result.rows];
}

/** Read a single lançamento's current claim/settle/cancel state by its id. */
export async function getLancamentoById(
  db: Database,
  idLancamento: string,
): Promise<LancamentoRow | undefined> {
  const result = await sql<LancamentoRow>`
    SELECT id_repasse, transferido_em, cancelado_em
      FROM lancamentos_financeiros WHERE id = ${idLancamento}
  `.execute(db);
  return result.rows[0];
}
