import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RecebedorRepository } from '../../src/adapters/arrecadacao/recebedor-repository.js';
import { criarRecebedorInicial } from '../../src/domain/arrecadacao/entities/recebedor.js';
import type { createArrecadacaoMemoryRepos } from './arrecadacao-repos.js';
import { makeCampanha } from './campanha-repository.conformance.js';

interface ConformanceOptions {
  factory: () =>
    | RecebedorRepository
    | Promise<RecebedorRepository>
    | ReturnType<typeof createArrecadacaoMemoryRepos>
    | Promise<ReturnType<typeof createArrecadacaoMemoryRepos>>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeRecebedorRepositoryConformance(name: string, options: ConformanceOptions) {
  describe(`RecebedorRepository conformance — ${name}`, () => {
    let repo: RecebedorRepository;
    let seedCampanha: (idCampanha: string) => Promise<void>;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      const built = await options.factory();
      if ('recebedorRepository' in built) {
        repo = built.recebedorRepository;
        seedCampanha = async (idCampanha: string) => {
          const campanha = makeCampanha({ id: idCampanha });
          await built.campanhaRepository.save(campanha);
        };
      } else {
        repo = built;
        seedCampanha = async () => {};
      }
    });

    it('saves and finds active receiver by campanha id', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const recebedor = criarRecebedorInicial({
        id: randomUUID(),
        idCampanha,
        dadosRecebedor: {
          metodo: 'pix',
          nomeTitular: 'Maria',
          tipoChavePix: 'email',
          chavePix: 'maria@exemplo.com',
        },
        criadaEm: new Date('2026-05-01T12:00:00.000Z'),
      });
      await repo.save(recebedor);
      expect(await repo.findAtivoByCampanhaId(idCampanha)).toEqual(recebedor);
    });

    it('round-trips a conta (bank-account) receiver', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const recebedor = criarRecebedorInicial({
        id: randomUUID(),
        idCampanha,
        dadosRecebedor: {
          metodo: 'conta',
          nomeTitular: 'Joao Santos',
          cpfTitular: '52998224725',
          celularTitular: '11987654321',
          codigoBanco: '237',
          agencia: '1234',
          agenciaDigito: null,
          conta: '56789',
          contaDigito: '0',
          tipoConta: 'cc',
        },
        criadaEm: new Date('2026-05-01T12:00:00.000Z'),
      });
      await repo.save(recebedor);
      expect(await repo.findAtivoByCampanhaId(idCampanha)).toEqual(recebedor);
    });

    it('returns undefined when no active receiver', async () => {
      expect(await repo.findAtivoByCampanhaId(randomUUID())).toBeUndefined();
    });

    it('lists history by campanha id', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const criadaEm = new Date('2026-05-01T12:00:00.000Z');
      const v1 = criarRecebedorInicial({
        id: randomUUID(),
        idCampanha,
        dadosRecebedor: {
          metodo: 'pix',
          nomeTitular: 'A',
          tipoChavePix: 'email',
          chavePix: 'a@exemplo.com',
        },
        criadaEm,
      });
      const v2 = criarRecebedorInicial({
        id: randomUUID(),
        idCampanha,
        dadosRecebedor: {
          metodo: 'pix',
          nomeTitular: 'B',
          tipoChavePix: 'email',
          chavePix: 'b@exemplo.com',
        },
        criadaEm: new Date('2026-05-02T12:00:00.000Z'),
      });
      await repo.save({ ...v1, isActive: false });
      await repo.save(v2);
      const historico = await repo.findByCampanhaId(idCampanha);
      expect(historico.length).toBeGreaterThanOrEqual(2);
      expect(historico.filter((r) => r.isActive)).toHaveLength(1);
    });

    it('save emits db.arrecadacao_recebedores.save span', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      await repo.save(
        criarRecebedorInicial({
          id: randomUUID(),
          idCampanha,
          dadosRecebedor: {
            metodo: 'pix',
            nomeTitular: 'Maria',
            tipoChavePix: 'email',
            chavePix: 'maria@exemplo.com',
          },
          criadaEm: new Date(),
        }),
      );
      const span = findSpan(options.getSpans(), 'db.arrecadacao_recebedores.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
    });
  });
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}
