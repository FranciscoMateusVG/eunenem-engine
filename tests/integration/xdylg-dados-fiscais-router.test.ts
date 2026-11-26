/**
 * aperture-xdylg — dados fiscais obrigatórios no resgate (router/API).
 *
 * O CPF já é obrigatório e imutável; o endereço fiscal (tomador da NFS-e)
 * passa a ser exigido por `recebedor.transferencia.solicitar`. Rig copiado de
 * zt9ch-cpf-immutability-router.test.ts (sessão real + repos em memória).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaMembrosRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-membros-repository.memory.js';
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
import type { DadosRecebedorPix } from '../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';

const SESSION_COOKIE = 'better-auth.session_token';
const TEST_PASSWORD = 'senha-teste-123';

const PIX: DadosRecebedorPix = {
  metodo: 'pix',
  nomeTitular: 'Ana Titular',
  cpfTitular: '52998224725',
  tipoChavePix: 'email',
  chavePix: 'ana@exemplo.com',
};

const ENDERECO = {
  cep: '30130-010',
  logradouro: 'Av. Afonso Pena',
  numero: '1000',
  complemento: null,
  bairro: 'Centro',
  cidade: 'Belo Horizonte',
  uf: 'MG',
  codigoMunicipioIbge: '3106200',
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
    campanhaMembrosRepository: new CampanhaMembrosRepositoryMemory(campanhaRepository),
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

describe('aperture-xdylg — dados fiscais do recebedor', () => {
  it('status informa se os dados fiscais estão completos', async () => {
    const rig = await buildRig();
    const status = () => rig.caller.recebedor.status({ idCampanha: rig.idCampanha });
    expect(await status()).toMatchObject({ configurado: false, dadosFiscaisCompletos: false });
    await rig.caller.recebedor.atualizar({ idCampanha: rig.idCampanha, dadosRecebedor: PIX });
    expect(await status()).toMatchObject({ configurado: true, dadosFiscaisCompletos: false });
    await rig.caller.recebedor.atualizarEnderecoFiscal({
      idCampanha: rig.idCampanha,
      enderecoFiscal: ENDERECO,
    });
    expect(await status()).toMatchObject({ configurado: true, dadosFiscaisCompletos: true });
  });

  it('solicitar resgate sem endereço fiscal → BAD_REQUEST antes de qualquer saldo/repasse', async () => {
    const rig = await buildRig();
    await rig.caller.recebedor.atualizar({ idCampanha: rig.idCampanha, dadosRecebedor: PIX });
    await expect(
      rig.caller.recebedor.transferencia.solicitar({ idCampanha: rig.idCampanha }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('endereço'),
    });
  });

  it('com endereço, solicitar passa pelo portão (cai na regra de saldo)', async () => {
    const rig = await buildRig();
    await rig.caller.recebedor.atualizar({
      idCampanha: rig.idCampanha,
      dadosRecebedor: { ...PIX, enderecoFiscal: ENDERECO },
    });
    await expect(
      rig.caller.recebedor.transferencia.solicitar({ idCampanha: rig.idCampanha }),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      message: 'saldo_disponivel_insuficiente',
    });
  });

  it('atualizarEnderecoFiscal: nova versão do recebedor, demais dados intactos; CEP normalizado', async () => {
    const rig = await buildRig();
    await rig.caller.recebedor.atualizar({ idCampanha: rig.idCampanha, dadosRecebedor: PIX });
    await rig.caller.recebedor.atualizarEnderecoFiscal({
      idCampanha: rig.idCampanha,
      enderecoFiscal: ENDERECO,
    });
    const ativo = await rig.recebedorRepository.findAtivoByCampanhaId(rig.idCampanha as never);
    expect(ativo?.dadosRecebedor).toEqual({
      ...PIX,
      enderecoFiscal: { ...ENDERECO, cep: '30130010' },
    });
    const historico = await rig.recebedorRepository.findByCampanhaId(rig.idCampanha as never);
    expect(historico).toHaveLength(2);
  });

  it('atualizarEnderecoFiscal sem recebedor ou com IBGE de outra UF → BAD_REQUEST', async () => {
    const rig = await buildRig();
    await expect(
      rig.caller.recebedor.atualizarEnderecoFiscal({
        idCampanha: rig.idCampanha,
        enderecoFiscal: ENDERECO,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await rig.caller.recebedor.atualizar({ idCampanha: rig.idCampanha, dadosRecebedor: PIX });
    await expect(
      rig.caller.recebedor.atualizarEnderecoFiscal({
        idCampanha: rig.idCampanha,
        enderecoFiscal: { ...ENDERECO, codigoMunicipioIbge: '3550308' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('atualizar sem enderecoFiscal (editor de dados bancários) mantém o endereço gravado', async () => {
    const rig = await buildRig();
    await rig.caller.recebedor.atualizar({
      idCampanha: rig.idCampanha,
      dadosRecebedor: { ...PIX, enderecoFiscal: ENDERECO },
    });
    await rig.caller.recebedor.atualizar({
      idCampanha: rig.idCampanha,
      dadosRecebedor: { ...PIX, chavePix: 'nova@exemplo.com' },
    });
    const ativo = await rig.recebedorRepository.findAtivoByCampanhaId(rig.idCampanha as never);
    expect(ativo?.dadosRecebedor).toMatchObject({
      chavePix: 'nova@exemplo.com',
      enderecoFiscal: { cep: '30130010' },
    });
  });

  it('recebedor.get devolve o endereço para o editor', async () => {
    const rig = await buildRig();
    await rig.caller.recebedor.atualizar({
      idCampanha: rig.idCampanha,
      dadosRecebedor: { ...PIX, enderecoFiscal: ENDERECO },
    });
    expect(await rig.caller.recebedor.get({ idCampanha: rig.idCampanha })).toMatchObject({
      enderecoFiscal: { codigoMunicipioIbge: '3106200', uf: 'MG' },
    });
  });

  it('barreira: edição bancária concorrente entre a leitura e a gravação do endereço → CONFLICT, PIX novo preservado', async () => {
    // Quantas leituras do ativo um atualizarEnderecoFiscal faz (permissão,
    // campanha, snapshot do router, releitura do caso de uso): a ÚLTIMA é a
    // releitura do caso de uso, depois do snapshot.
    const contar = await buildRig();
    await contar.caller.recebedor.atualizar({ idCampanha: contar.idCampanha, dadosRecebedor: PIX });
    let total = 0;
    const lerContando = contar.recebedorRepository.findAtivoByCampanhaId.bind(
      contar.recebedorRepository,
    );
    contar.recebedorRepository.findAtivoByCampanhaId = async (...args) => {
      total += 1;
      return lerContando(...args);
    };
    await contar.caller.recebedor.atualizarEnderecoFiscal({
      idCampanha: contar.idCampanha,
      enderecoFiscal: ENDERECO,
    });
    expect(total).toBeGreaterThanOrEqual(2);

    const rig = await buildRig();
    await rig.caller.recebedor.atualizar({ idCampanha: rig.idCampanha, dadosRecebedor: PIX });
    const repo = rig.recebedorRepository;
    const original = repo.findAtivoByCampanhaId.bind(repo);
    let leituras = 0;
    repo.findAtivoByCampanhaId = async (...args) => {
      leituras += 1;
      if (leituras === total) {
        // Outra aba troca a chave PIX logo antes da releitura do caso de uso.
        repo.findAtivoByCampanhaId = original;
        await rig.caller.recebedor.atualizar({
          idCampanha: rig.idCampanha,
          dadosRecebedor: { ...PIX, chavePix: 'nova@exemplo.com' },
        });
      }
      return original(...args);
    };
    await expect(
      rig.caller.recebedor.atualizarEnderecoFiscal({
        idCampanha: rig.idCampanha,
        enderecoFiscal: ENDERECO,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const ativo = await original(rig.idCampanha as never);
    expect(ativo?.dadosRecebedor).toMatchObject({ chavePix: 'nova@exemplo.com' });
    expect(ativo?.dadosRecebedor).not.toHaveProperty('enderecoFiscal');
  });

  it('barreira simétrica: endereço completado no meio de uma edição bancária → CONFLICT, endereço preservado', async () => {
    const contar = await buildRig();
    await contar.caller.recebedor.atualizar({ idCampanha: contar.idCampanha, dadosRecebedor: PIX });
    let total = 0;
    const lerContando = contar.recebedorRepository.findAtivoByCampanhaId.bind(
      contar.recebedorRepository,
    );
    contar.recebedorRepository.findAtivoByCampanhaId = async (...args) => {
      total += 1;
      return lerContando(...args);
    };
    await contar.caller.recebedor.atualizar({
      idCampanha: contar.idCampanha,
      dadosRecebedor: { ...PIX, chavePix: 'nova@exemplo.com' },
    });

    const rig = await buildRig();
    await rig.caller.recebedor.atualizar({ idCampanha: rig.idCampanha, dadosRecebedor: PIX });
    const repo = rig.recebedorRepository;
    const original = repo.findAtivoByCampanhaId.bind(repo);
    let leituras = 0;
    repo.findAtivoByCampanhaId = async (...args) => {
      leituras += 1;
      if (leituras === total) {
        // Outra aba completa o endereço logo antes da releitura do caso de uso.
        repo.findAtivoByCampanhaId = original;
        await rig.caller.recebedor.atualizarEnderecoFiscal({
          idCampanha: rig.idCampanha,
          enderecoFiscal: ENDERECO,
        });
      }
      return original(...args);
    };
    await expect(
      rig.caller.recebedor.atualizar({
        idCampanha: rig.idCampanha,
        dadosRecebedor: { ...PIX, chavePix: 'nova@exemplo.com' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const ativo = await original(rig.idCampanha as never);
    expect(ativo?.dadosRecebedor).toMatchObject({
      chavePix: PIX.chavePix,
      enderecoFiscal: { cep: '30130010' },
    });
  });
});
