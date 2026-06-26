import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UsuarioRepository } from '../../src/adapters/usuario/repository.js';
import type { ResgatePendenteRepository } from '../../src/adapters/usuario/resgate-pendente-repository.js';
import type { Conta, Usuario } from '../../src/domain/usuario/entities/usuario.js';

function makeUsuario(id: string): { usuario: Usuario; conta: Conta } {
  const slug = `u${id.replace(/-/g, '').slice(0, 20)}`;
  const idConta = randomUUID();
  const criadoEm = new Date('2026-01-01T00:00:00.000Z');
  const usuario: Usuario = {
    id,
    idPlataforma: randomUUID(),
    idConta,
    email: `${slug}@test.com`,
    nomeExibicao: 'Usuario Teste',
    slug,
    criadoEm,
    tutorialCompletadoEm: null,
  };
  const conta: Conta = { id: idConta, idUsuario: id, permissoes: [], criadaEm: criadoEm };
  return { usuario, conta };
}

interface ConformanceOptions {
  factory: () =>
    | ResgatePendenteRepository
    | Promise<ResgatePendenteRepository>
    | {
        resgatePendenteRepository: ResgatePendenteRepository;
        usuarioRepository: UsuarioRepository;
      }
    | Promise<{
        resgatePendenteRepository: ResgatePendenteRepository;
        usuarioRepository: UsuarioRepository;
      }>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeResgatePendenteRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`ResgatePendenteRepository conformance — ${name}`, () => {
    let repo: ResgatePendenteRepository;
    let seedUsuario: (idUsuario: string) => Promise<void>;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      const built = await options.factory();
      if ('resgatePendenteRepository' in built) {
        repo = built.resgatePendenteRepository;
        seedUsuario = async (idUsuario: string) => {
          await built.usuarioRepository.saveRegistroDomain(makeUsuario(idUsuario));
        };
      } else {
        repo = built;
        seedUsuario = async () => {};
      }
    });

    it('marcarPendente persists pendente_desde, readable via obterPendenteDesde', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const desde = new Date('2026-06-01T12:00:00.000Z');
      await repo.marcarPendente(idUsuario, desde, desde);
      expect(await repo.obterPendenteDesde(idUsuario)).toEqual(desde);
    });

    it('obterPendenteDesde returns null when no marker exists', async () => {
      expect(await repo.obterPendenteDesde(randomUUID())).toBeNull();
    });

    it('marcarPendente upserts — a second marca refreshes pendente_desde', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const first = new Date('2026-06-01T12:00:00.000Z');
      const second = new Date('2026-06-10T08:00:00.000Z');
      await repo.marcarPendente(idUsuario, first, first);
      await repo.marcarPendente(idUsuario, second, second);
      expect(await repo.obterPendenteDesde(idUsuario)).toEqual(second);
    });

    it('limparPendente removes the marker (obterPendenteDesde → null)', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const desde = new Date('2026-06-01T12:00:00.000Z');
      await repo.marcarPendente(idUsuario, desde, desde);
      await repo.limparPendente(idUsuario);
      expect(await repo.obterPendenteDesde(idUsuario)).toBeNull();
    });

    it('limparPendente is idempotent — no-op when no marker exists', async () => {
      await expect(repo.limparPendente(randomUUID())).resolves.toBeUndefined();
    });

    it('marcarPendente emits db.resgates_pendentes.marcarPendente span', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const desde = new Date('2026-06-01T12:00:00.000Z');
      await repo.marcarPendente(idUsuario, desde, desde);
      const span = options
        .getSpans()
        .find((s) => s.name === 'db.resgates_pendentes.marcarPendente');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
    });
  });
}
