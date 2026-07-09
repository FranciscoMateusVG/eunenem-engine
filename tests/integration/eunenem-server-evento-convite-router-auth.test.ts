import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { PerfilCampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/perfil-campanha-repository.memory.js';
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
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { criarRecebedorInicial } from '../../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';

const SESSION_COOKIE = 'better-auth.session_token';
const TEST_EMAIL = 'francisco@example.com';
const TEST_PASSWORD = 'senha-teste-123';

interface TestRig {
  callerAnon: ReturnType<typeof appRouter.createCaller>;
  callerAuth: ReturnType<typeof appRouter.createCaller>;
  slug: string;
}

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
    observability,
    clock: () => new Date('2026-06-11T12:00:00.000Z'),
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive,
  };

  const { usuario, campanha } = await registrarContaUsuario(
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
      idUsuario: randomUUID(),
      idConta: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email: TEST_EMAIL,
      nomeExibicao: 'Francisco',
      senhaSimulada: TEST_PASSWORD,
    },
  );

  await recebedorRepository.save(
    criarRecebedorInicial({
      id: randomUUID(),
      idCampanha: campanha.id,
      dadosRecebedor: {
        metodo: 'pix',
        nomeTitular: 'Francisco',
        tipoChavePix: 'email',
        chavePix: TEST_EMAIL,
      },
      criadaEm: deps.clock(),
    }),
  );

  const sessao = await criarSessaoUsuario(
    {
      usuarioRepository,
      authService,
      observability,
    },
    {
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email: TEST_EMAIL,
      senhaSimulada: TEST_PASSWORD,
    },
  );

  const anonCtx: TrpcContext = {
    deps,
    headers: new Headers(),
    resHeaders: new Headers(),
  };
  const authCtx: TrpcContext = {
    deps,
    headers: new Headers({
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}`,
    }),
    resHeaders: new Headers(),
  };

  return {
    callerAnon: appRouter.createCaller(anonCtx),
    callerAuth: appRouter.createCaller(authCtx),
    slug: usuario.slug,
  };
}

describe('eventoConvite router (edicao autenticada + preview publico)', () => {
  it('exige sessao para carregar o wizard de edicao', async () => {
    const rig = await buildRig();

    await expect(rig.callerAnon.eventoConvite.get()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('permite preview publico por slug quando ainda nao existe convite salvo', async () => {
    const rig = await buildRig();

    const result = await rig.callerAnon.eventoConvite.getPreview({ slug: rig.slug });

    expect(result).toEqual({
      evento: null,
      convite: null,
    });
  });

  it('salva via sessao autenticada e expoe o preview publico pelo slug', async () => {
    const rig = await buildRig();

    const created = await rig.callerAuth.eventoConvite.save({
      tipoEvento: 'cha-bebe',
      modalidade: 'presencial',
      dataHoraIso: '2026-08-15T18:30:00.000Z',
      endereco: 'Rua das Acacias, 142',
      remetente: 'Mariana e Tiago',
      nomeExibido: 'Maria Helena',
      mensagem: 'vem celebrar com a gente ♡',
      paleta: 'lilas',
      fonte: 'patrick',
      modelo: 'scrapbook',
    });

    expect(created.evento?.tipoEvento).toBe('cha-bebe');
    expect(created.convite?.nomeExibido).toBe('Maria Helena');

    const reloadedWizard = await rig.callerAuth.eventoConvite.get();
    expect(reloadedWizard.evento?.id).toBe(created.evento?.id);
    expect(reloadedWizard.convite?.id).toBe(created.convite?.id);

    const preview = await rig.callerAnon.eventoConvite.getPreview({ slug: rig.slug });
    expect(preview.evento?.id).toBe(created.evento?.id);
    expect(preview.convite?.remetente).toBe('Mariana e Tiago');
    expect(preview.convite?.modelo).toBe('scrapbook');
  });

  it('salva um convite sem dataHoraIso (data/hora indefinidas)', async () => {
    const rig = await buildRig();

    const created = await rig.callerAuth.eventoConvite.save({
      tipoEvento: 'cha-bebe',
      modalidade: 'presencial',
      dataHoraIso: null,
      endereco: 'Rua das Acacias, 142',
      remetente: 'Mariana e Tiago',
      nomeExibido: 'Maria Helena',
      mensagem: 'vem celebrar com a gente ♡',
      paleta: 'lilas',
      fonte: 'patrick',
      modelo: 'scrapbook',
    });

    expect(created.evento?.dataHoraIso).toBeNull();

    const reloadedWizard = await rig.callerAuth.eventoConvite.get();
    expect(reloadedWizard.evento?.dataHoraIso).toBeNull();

    const preview = await rig.callerAnon.eventoConvite.getPreview({ slug: rig.slug });
    expect(preview.evento?.dataHoraIso).toBeNull();
  });
});
