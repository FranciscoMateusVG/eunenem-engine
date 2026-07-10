/**
 * aperture-zt9ch — API/router-level regression test for the CPF-immutability
 * guard (backend defense-in-depth, merged via engine #298; ported to the
 * campanha-scoped recebedor.atualizar procedure during the recebedor-per-
 * campanha unification).
 *
 * The frontend CPF disable is cosmetic/bypassable. The REAL enforcement is
 * the backend guard in `recebedor.atualizar`: once a campanha's active
 * recebedor has a non-empty `cpfTitular`, a save that submits a DIFFERENT
 * `cpfTitular` throws `ArrecadacaoInputInvalidoError`, which the tRPC router
 * maps to a `BAD_REQUEST` `TRPCError` via `toTRPCError`.
 *
 * THIS test is the ROUTER/API-level net: it drives a real authenticated tRPC
 * caller (session cookie → resolverUsuarioAutenticado) at
 * `recebedor.atualizar` and proves a direct API call cannot mutate a saved
 * CPF — the guard is wired into the API path AND error-mapped to a clean
 * client error. Follows the existing authed-router integration convention
 * (eunenem-server-evento-convite-router-auth.test.ts): appRouter.createCaller
 * + a real session built via criarSessaoUsuario, memory repos for the engine
 * deps.
 *
 * CPFs (checksum-valid, so they pass schema validation and REACH the guard
 * rather than being rejected for bad format):
 *   A = '52998224725'   B = '11144477735'
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { PerfilCampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/perfil-campanha-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { ResgatePendenteRepositoryMemory } from '../../src/adapters/arrecadacao/resgate-pendente-repository.memory.js';
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
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import type { DadosRecebedorConta } from '../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
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
  recebedorRepository: RecebedorRepositoryMemory;
  idCampanha: string;
}

/**
 * Build an AUTHENTICATED tRPC caller for a fresh random user U, with their
 * signup-saga default campanha. Mirrors the convite router-auth integration
 * test: a real session token resolved from a cookie header, the appRouter
 * constructed against memory repos.
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
  const resgatePendenteRepository = new ResgatePendenteRepositoryMemory();

  const deps: ServerDeps = {
    db: {} as never,
    auth: {} as never,
    authService,
    usuarioRepository,
    perfilCampanhaRepository: new PerfilCampanhaRepositoryMemory(),
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
  const idConta = randomUUID();
  const email = `cpf-${idUsuario}@example.com`;

  const registro = await registrarContaUsuario(
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
      idConta,
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
    recebedorRepository,
    idCampanha: registro.campanha.id,
  };
}

/** Narrow the persisted VO to the 'conta' variant for cpf assertions. */
function storedConta(
  dados: ReturnType<RecebedorRepositoryMemory['findAtivoByCampanhaId']> extends Promise<infer R>
    ? R
    : never,
): DadosRecebedorConta {
  const d = dados?.dadosRecebedor;
  if (!d || d.metodo !== 'conta') {
    throw new Error(`expected a stored 'conta' record, got ${d?.metodo ?? 'undefined'}`);
  }
  return d;
}

describe('aperture-zt9ch — recebedor.atualizar CPF immutability (router/API level)', () => {
  it('rejects a direct API call that mutates a saved cpfTitular (BAD_REQUEST), leaving it unchanged; allows non-CPF edits', async () => {
    const rig = await buildRig();

    // ── 1. Initial save: conta with cpfTitular=A → succeeds, stored as A. ──
    const saved = await rig.caller.recebedor.atualizar({
      idCampanha: rig.idCampanha,
      dadosRecebedor: CONTA_A,
    });
    expect(saved.metodo === 'conta' && saved.cpfTitular).toBe(CPF_A);

    const afterFirst = await rig.recebedorRepository.findAtivoByCampanhaId(rig.idCampanha as never);
    expect(storedConta(afterFirst).cpfTitular).toBe(CPF_A);

    // ── 2. ⭐ THE PIN: re-save same campanha, DIFFERENT valid CPF=B via the
    //        authed caller → must be REJECTED as a clean BAD_REQUEST
    //        TRPCError (NOT a 500/INTERNAL — the guard must surface as a
    //        client error). We capture the thrown error and assert its shape
    //        directly rather than weakening to a string match. ──
    let thrown: unknown;
    try {
      await rig.caller.recebedor.atualizar({
        idCampanha: rig.idCampanha,
        dadosRecebedor: { ...CONTA_A, cpfTitular: CPF_B },
      });
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
      rig.caller.recebedor.atualizar({
        idCampanha: rig.idCampanha,
        dadosRecebedor: { ...CONTA_A, cpfTitular: CPF_B },
      }),
    ).rejects.toMatchObject({ name: 'TRPCError', code: 'BAD_REQUEST' });

    // ── 3. After the rejected attempt, the stored CPF is STILL A — the
    //        mutation was rejected, not partially applied. ──
    const afterReject = await rig.recebedorRepository.findAtivoByCampanhaId(
      rig.idCampanha as never,
    );
    expect(storedConta(afterReject).cpfTitular).toBe(CPF_A);

    // ── 4. CONTROL: same campanha, SAME CPF=A but a CHANGED bank field
    //        (agencia + conta) → must SUCCEED. Proves the guard blocks only
    //        CHANGING the cpf, not legitimate edits to other fields (i.e. the
    //        rejection is CPF-specific, not a blanket re-save block). ──
    const legitimateEdit = await rig.caller.recebedor.atualizar({
      idCampanha: rig.idCampanha,
      dadosRecebedor: { ...CONTA_A, agencia: '9999', conta: '11111' },
    });
    expect(legitimateEdit.metodo === 'conta' && legitimateEdit.cpfTitular).toBe(CPF_A);
    expect(legitimateEdit.metodo === 'conta' && legitimateEdit.agencia).toBe('9999');

    const afterEdit = await rig.recebedorRepository.findAtivoByCampanhaId(rig.idCampanha as never);
    expect(storedConta(afterEdit).cpfTitular).toBe(CPF_A);
    expect(storedConta(afterEdit).agencia).toBe('9999');
  });
});
