/**
 * aperture-zt9ch — API/router-level regression test for the CPF-immutability
 * guard (backend defense-in-depth, merged via engine #298).
 *
 * The frontend CPF disable (#296) is cosmetic/bypassable. The REAL enforcement
 * is the backend guard in `salvarDadosRecebimentoUsuario`: once a 'conta'
 * record has a non-empty `cpfTitular`, a save that submits a DIFFERENT
 * `cpfTitular` throws `UsuarioInputInvalidoError`, which the tRPC router maps
 * to a `BAD_REQUEST` `TRPCError` via `toTRPCError`.
 *
 * Rex covered the USE-CASE level (tests/unit/usuario/dados-recebimento-usuario
 * .test.ts). THIS test is the ROUTER/API-level net: it drives a real
 * authenticated tRPC caller (session cookie → resolverUsuarioAutenticado) at
 * `dadosRecebimento.salvar` and proves a direct API call cannot mutate a saved
 * CPF — the guard is wired into the API path AND error-mapped to a clean
 * client error. Follows the existing authed-router integration convention
 * (eunenem-server-evento-convite-router-auth.test.ts): appRouter.createCaller
 * + a real session built via criarSessaoUsuario, memory repos for the engine
 * deps.
 *
 * CPFs (checksum-valid, so they pass schema validation and REACH the guard
 * rather than being rejected for bad format — same pair Rex used):
 *   A = '52998224725'   B = '11144477735'
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { ConviteRepositoryMemory } from '../../src/adapters/evento/convite-repository.memory.js';
import { EventoRepositoryMemory } from '../../src/adapters/evento/evento-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoProviderFake } from '../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import {
  ProvedorRegraTaxaMemory,
  REGRAS_TAXA_SEED,
} from '../../src/adapters/taxas/regra-provider.memory.js';
import { AuthServiceMemoria } from '../../src/adapters/usuario/auth-service.memory.js';
import { DadosRecebimentoRepositoryMemory } from '../../src/adapters/usuario/dados-recebimento-repository.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { ResgatePendenteRepositoryMemory } from '../../src/adapters/usuario/resgate-pendente-repository.memory.js';
import { WebhookEventArchiveMemory } from '../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import type {
  DadosRecebedor,
  DadosRecebedorConta,
} from '../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';

const SESSION_COOKIE = 'better-auth.session_token';
const TEST_PASSWORD = 'senha-teste-123';

const CPF_A = '52998224725';
const CPF_B = '11144477735';

/** A valid 'conta' payload with CPF=A. Bank fields are all schema-valid. */
const CONTA_A: DadosRecebedorConta = {
  metodo: 'conta',
  nomeTitular: 'Joao Santos',
  cpfTitular: CPF_A,
  celularTitular: '11987654321',
  codigoBanco: '237',
  agencia: '1234',
  agenciaDigito: null,
  conta: '56789',
  contaDigito: '0',
  tipoConta: 'cc',
};

interface TestRig {
  caller: ReturnType<typeof appRouter.createCaller>;
  dadosRecebimentoRepository: DadosRecebimentoRepositoryMemory;
  idUsuario: string;
}

/**
 * Build an AUTHENTICATED tRPC caller for a fresh random user U. Mirrors the
 * convite router-auth integration test: a real session token resolved from a
 * cookie header, the appRouter constructed against memory repos.
 */
async function buildRig(): Promise<TestRig> {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };

  const authService = new AuthServiceMemoria();
  const usuarioRepository = new UsuarioRepositoryMemory();
  const plataformaRepository = new PlataformaRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const eventoRepository = new EventoRepositoryMemory();
  const conviteRepository = new ConviteRepositoryMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoProvider = new PagamentoProviderFake();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory(
    recebedorRepository,
    pagamentoRepository,
  );
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED);
  const webhookEventArchive = new WebhookEventArchiveMemory();
  const dadosRecebimentoRepository = new DadosRecebimentoRepositoryMemory();
  const resgatePendenteRepository = new ResgatePendenteRepositoryMemory();

  const deps: ServerDeps = {
    db: {} as never,
    auth: {} as never,
    authService,
    usuarioRepository,
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    eventoRepository,
    conviteRepository,
    pagamentoRepository,
    pagamentoProvider,
    checkoutSessionProvider: pagamentoProvider,
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    provedorRegraTaxa,
    dadosRecebimentoRepository,
    resgatePendenteRepository,
    observability,
    clock: () => new Date('2026-06-11T12:00:00.000Z'),
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive,
  };

  const idUsuario = randomUUID();
  const email = `cpf-${idUsuario}@example.com`;

  await registrarContaUsuario(
    {
      usuarioRepository,
      plataformaRepository,
      campanhaRepository,
      recebedorRepository,
      authService,
      clock: deps.clock,
      observability,
    },
    {
      idUsuario,
      idConta: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      nomeExibicao: 'Francisco',
      senhaSimulada: TEST_PASSWORD,
    },
  );

  const sessao = await criarSessaoUsuario(
    {
      usuarioRepository,
      authService,
      observability,
    },
    {
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senhaSimulada: TEST_PASSWORD,
    },
  );

  const authCtx: TrpcContext = {
    deps,
    headers: new Headers({
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}`,
    }),
    resHeaders: new Headers(),
  };

  return {
    caller: appRouter.createCaller(authCtx),
    dadosRecebimentoRepository,
    // resolverUsuarioAutenticado derives idUsuario from the session; this is
    // the same user, exposed for repo-state assertions.
    idUsuario,
  };
}

/** Narrow the persisted VO to the 'conta' variant for cpf assertions. */
function storedConta(dados: DadosRecebedor | undefined): DadosRecebedorConta {
  if (!dados || dados.metodo !== 'conta') {
    throw new Error(`expected a stored 'conta' record, got ${dados?.metodo ?? 'undefined'}`);
  }
  return dados;
}

describe('aperture-zt9ch — dadosRecebimento.salvar CPF immutability (router/API level)', () => {
  it('rejects a direct API call that mutates a saved cpfTitular (BAD_REQUEST), leaving it unchanged; allows non-CPF edits', async () => {
    const rig = await buildRig();

    // ── 1. Initial save: conta with cpfTitular=A → succeeds, stored as A. ──
    const saved = await rig.caller.dadosRecebimento.salvar(CONTA_A);
    expect(saved.metodo === 'conta' && saved.cpfTitular).toBe(CPF_A);

    const afterFirst = await rig.dadosRecebimentoRepository.findByUsuarioId(rig.idUsuario as never);
    expect(storedConta(afterFirst?.dados).cpfTitular).toBe(CPF_A);

    // ── 2. ⭐ THE PIN: re-save same user, DIFFERENT valid CPF=B via the
    //        authed caller → must be REJECTED as a clean BAD_REQUEST
    //        TRPCError (NOT a 500/INTERNAL — the guard must surface as a
    //        client error). We capture the thrown error and assert its shape
    //        directly rather than weakening to a string match. ──
    let thrown: unknown;
    try {
      await rig.caller.dadosRecebimento.salvar({ ...CONTA_A, cpfTitular: CPF_B });
    } catch (err) {
      thrown = err;
    }

    // NOTE: `@trpc/server` is a dep of the eunenem-server app package, not the
    // root test scope (see the resolution note in contribuicao-router.ts), so
    // we can't `instanceof TRPCError` here. We assert the cross-realm-safe
    // surface instead: it's a TRPCError (name) carrying `code === 'BAD_REQUEST'`
    // — which would be 'INTERNAL_SERVER_ERROR' for an un-mapped 500, so this
    // genuinely distinguishes a clean client error from a server error.
    expect(thrown, 'a post-save CPF change MUST be rejected at the API').toBeDefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('TRPCError');
    expect((thrown as { code?: string }).code).toBe('BAD_REQUEST');

    // Belt-and-suspenders: rejects-matcher form (the convite router-test
    // convention), asserting the mapped code.
    await expect(
      rig.caller.dadosRecebimento.salvar({ ...CONTA_A, cpfTitular: CPF_B }),
    ).rejects.toMatchObject({ name: 'TRPCError', code: 'BAD_REQUEST' });

    // ── 3. After the rejected attempt, the stored CPF is STILL A — the
    //        mutation was rejected, not partially applied. ──
    const afterReject = await rig.dadosRecebimentoRepository.findByUsuarioId(
      rig.idUsuario as never,
    );
    expect(storedConta(afterReject?.dados).cpfTitular).toBe(CPF_A);

    // ── 4. CONTROL: same user, SAME CPF=A but a CHANGED bank field
    //        (agencia + conta) → must SUCCEED. Proves the guard blocks only
    //        CHANGING the cpf, not legitimate edits to other fields (i.e. the
    //        rejection is CPF-specific, not a blanket re-save block). ──
    const legitimateEdit = await rig.caller.dadosRecebimento.salvar({
      ...CONTA_A,
      agencia: '9999',
      conta: '11111',
    });
    expect(legitimateEdit.metodo === 'conta' && legitimateEdit.cpfTitular).toBe(CPF_A);
    expect(legitimateEdit.metodo === 'conta' && legitimateEdit.agencia).toBe('9999');

    const afterEdit = await rig.dadosRecebimentoRepository.findByUsuarioId(rig.idUsuario as never);
    expect(storedConta(afterEdit?.dados).cpfTitular).toBe(CPF_A);
    expect(storedConta(afterEdit?.dados).agencia).toBe('9999');
  });
});
