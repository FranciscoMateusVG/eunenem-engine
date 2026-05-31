/**
 * Regression test for the obterListaPresentes projection
 * (aperture-ines9).
 *
 * Operator caught on live-walk: the marketplace card showed bare
 * `contribuicao.valor` (e.g. R$ 1.00 for BABADOR B) while Stripe
 * actually charged R$ 1.05 — contribution + 5% eunenem fee.
 *
 * The fee is invisible to the visitor (operator's intent — taxa de
 * serviço lives IN the displayed price). Same goes for the Cartão
 * differential — the surcharge is shown on top of the fee-inclusive
 * total, not on top of bare contribution.
 *
 * **What this test locks:** the projection returns
 *   - `valor = contribution + fee` (matches Stripe gift line item on Pix)
 *   - `valorComTaxaCartao = valor + surcharge` (matches Stripe gift +
 *     surcharge line items on Cartão)
 *
 * A future refactor that reverts `valor` to bare contribution (the
 * original bug) fails this test.
 *
 * Math reference for `contribuicao.valor = 100` cents:
 *   - eunenem RegraTaxa: presente = 5% (REGRAS_TAXA_SEED)
 *   - fee  = ceil(100 × 500 / 10_000) = 5
 *   - valor = 100 + 5 = 105
 *   - surcharge = ceil((100 × 0.039 + 39) / (1 − 0.039))
 *               = ceil(42.9 / 0.961)
 *               = ceil(44.64)
 *               = 45
 *   - valorComTaxaCartao = 105 + 45 = 150
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../src/adapters/taxas/regra-provider.memory.js';
import { AuthServiceMemoria } from '../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { criarContribuicaoDisponivel } from '../../src/domain/arrecadacao/entities/contribuicao.js';
import { criarRecebedorInicial } from '../../src/domain/arrecadacao/entities/recebedor.js';
import type { IdContribuicao } from '../../src/domain/arrecadacao/value-objects/ids.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';

function buildPaginaTestDeps(): ServerDeps {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };
  const usuarioRepository = new UsuarioRepositoryMemory();
  const plataformaRepository = new PlataformaRepositoryMemory();
  const authService = new AuthServiceMemoria();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

  // Only the fields actually touched by pagina-router.obterListaPresentes
  // (+ resolvePaginaBySlug). Other ports stubbed to satisfy the type;
  // they're never reached on the read-only projection path.
  return {
    db: {} as never,
    auth: {} as never,
    authService,
    usuarioRepository,
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    pagamentoRepository: {} as never,
    pagamentoProvider: {} as never,
    pagamentoEventPublisher: {} as never,
    checkoutSessionProvider: {} as never,
    livroFinanceiroRepository: {} as never,
    provedorRegraTaxa,
    observability,
    clock: () => new Date(),
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaaaaaaaaaa',
  };
}

describe('pagina.obterListaPresentes projection (aperture-ines9)', () => {
  it('returns valor = contribution + 5% eunenem fee and valorComTaxaCartao = valor + Stripe Brazil card surcharge', async () => {
    const deps = buildPaginaTestDeps();

    // Seed: register a user → saga creates their campanha + presente opção
    const { usuario, campanha } = await registrarContaUsuario(
      {
        usuarioRepository: deps.usuarioRepository,
        plataformaRepository: deps.plataformaRepository,
        campanhaRepository: deps.campanhaRepository,
        recebedorRepository: deps.recebedorRepository,
        authService: deps.authService,
        clock: deps.clock,
        observability: deps.observability,
      },
      {
        idUsuario: randomUUID(),
        idConta: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'lista-projection@test.local',
        nomeExibicao: 'Lista Projection Owner',
        senhaSimulada: 'irrelevant-for-this-test',
      },
    );

    const opcaoPresentes = campanha.opcoes.find((o) => o.tipo === 'presente');
    if (!opcaoPresentes) throw new Error('seed: no presente opção');

    // Saga creates campanha WITHOUT a recebedor (user has no PIX at signup);
    // CampanhaRepositoryMemory.findByAdministrador returns undefined when
    // there's no active recebedor — surfaces as NOT_FOUND in pagina-router.
    // Attach an initial recebedor so the rig represents a user with PIX
    // configured (mirrors the seedUserWithCampanha helper in
    // eunenem-server-contribuicao-router.test.ts).
    await deps.recebedorRepository.save(
      criarRecebedorInicial({
        id: randomUUID(),
        idCampanha: campanha.id,
        dadosRecebedor: {
          nomeTitular: 'Lista Projection Owner',
          tipoChavePix: 'email',
          chavePix: 'lista-projection@test.local',
        },
        criadaEm: deps.clock(),
      }),
    );

    // Seed a contribuicao with bare valor = 100 cents (R$ 1.00) — matches
    // the BABADOR B amount from operator's live-walk screenshot.
    const contribuicao = criarContribuicaoDisponivel({
      id: randomUUID() as IdContribuicao,
      idCampanha: campanha.id,
      idOpcaoContribuicao: opcaoPresentes.id,
      nome: 'BABADOR B',
      valor: 100,
      criadaEm: new Date(),
    });
    await deps.contribuicaoRepository.save(contribuicao);

    // Call the projection through the real tRPC caller — same boundary the
    // HTTP layer hits, minus the JSON envelope.
    const ctx: TrpcContext = {
      deps,
      headers: new Headers(),
      resHeaders: new Headers(),
    };
    const caller = appRouter.createCaller(ctx);
    const items = await caller.pagina.obterListaPresentes({ slug: usuario.slug });

    expect(items).toHaveLength(1);
    const [item] = items;
    if (!item) throw new Error('seed: projection returned empty array');
    expect(item.nome).toBe('BABADOR B');
    // valor = 100 + 5 (5% eunenem fee) = 105
    expect(item.valor).toBe(105);
    // valorComTaxaCartao = 105 + 45 (Stripe Brazil 3.9% + R$0.39 gross-up
    // computed off the bare 100 base) = 150
    expect(item.valorComTaxaCartao).toBe(150);
  });
});
