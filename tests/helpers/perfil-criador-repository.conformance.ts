import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PerfilCriadorRepository } from '../../src/adapters/usuario/perfil-criador-repository.js';
import type { UsuarioRepository } from '../../src/adapters/usuario/repository.js';
import {
  criarPerfilCriador,
  type PerfilCriador,
} from '../../src/domain/usuario/entities/perfil-criador.js';
import type { Conta, Usuario } from '../../src/domain/usuario/entities/usuario.js';
import type { ConteudoPerfilCriador } from '../../src/domain/usuario/value-objects/conteudo-perfil-criador.js';

/**
 * Build a minimal valid Usuario + Conta aggregate for a given id, with
 * email/slug derived from the id so multiple seeds in one platform never
 * collide on the composite-unique constraints.
 */
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

/** Build a PerfilCriador for a usuario with the given (partial) content. */
export function makePerfilCriador(
  idUsuario: string,
  conteudo: ConteudoPerfilCriador,
  criadoEm: Date = new Date('2026-06-01T12:00:00.000Z'),
): PerfilCriador {
  return criarPerfilCriador({ id: randomUUID(), idUsuario, conteudo, criadoEm });
}

const CONTEUDO_PREENCHIDO: ConteudoPerfilCriador = {
  nomeBebe: 'Helena',
  relacao: 'Mãe',
  historia: 'Era uma vez uma espera cheia de amor.',
  dataNascimento: new Date('2026-09-15T00:00:00.000Z'),
  tipoEvento: 'cha-bebe',
  dataEvento: new Date('2026-08-01T00:00:00.000Z'),
  fotoPerfilKey: 'perfis/helena/perfil.jpg',
  fotoCapaKey: 'perfis/helena/capa.jpg',
  fotoHistoriaKey: 'perfis/helena/historia.jpg',
};

const CONTEUDO_ATUALIZADO: ConteudoPerfilCriador = {
  nomeBebe: 'Helena Maria',
  relacao: 'Mãe',
  historia: 'A história atualizada.',
  dataNascimento: new Date('2026-09-16T00:00:00.000Z'),
  tipoEvento: 'cha-revelacao',
  dataEvento: null,
  fotoPerfilKey: null,
  fotoCapaKey: null,
  fotoHistoriaKey: null,
};

interface ConformanceOptions {
  /**
   * Returns the repo under test. For adapters with a real FK to `usuarios`
   * (Postgres), also return a `usuarioRepository` so the suite can seed the
   * parent row before saving a profile. Memory adapters return the bare repo.
   */
  factory: () =>
    | PerfilCriadorRepository
    | Promise<PerfilCriadorRepository>
    | { perfilCriadorRepository: PerfilCriadorRepository; usuarioRepository: UsuarioRepository }
    | Promise<{
        perfilCriadorRepository: PerfilCriadorRepository;
        usuarioRepository: UsuarioRepository;
      }>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describePerfilCriadorRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`PerfilCriadorRepository conformance — ${name}`, () => {
    let repo: PerfilCriadorRepository;
    let seedUsuario: (idUsuario: string) => Promise<void>;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      const built = await options.factory();
      if ('perfilCriadorRepository' in built) {
        repo = built.perfilCriadorRepository;
        seedUsuario = async (idUsuario: string) => {
          await built.usuarioRepository.saveRegistroDomain(makeUsuario(idUsuario));
        };
      } else {
        repo = built;
        seedUsuario = async () => {};
      }
    });

    it('saves a profile and finds it by usuario id', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const perfil = makePerfilCriador(idUsuario, CONTEUDO_PREENCHIDO);
      await repo.save(perfil);
      expect(await repo.findByUsuarioId(idUsuario)).toEqual(perfil);
    });

    it('returns undefined when no profile exists for the usuario', async () => {
      expect(await repo.findByUsuarioId(randomUUID())).toBeUndefined();
    });

    it('upsert replaces content and bumps atualizadoEm while preserving id + criadoEm', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const original = makePerfilCriador(
        idUsuario,
        CONTEUDO_PREENCHIDO,
        new Date('2026-06-01T12:00:00.000Z'),
      );
      await repo.save(original);

      // Second save: new aggregate id + later timestamps + new content.
      const reedit = makePerfilCriador(
        idUsuario,
        CONTEUDO_ATUALIZADO,
        new Date('2026-06-10T08:00:00.000Z'),
      );
      await repo.save(reedit);

      const found = await repo.findByUsuarioId(idUsuario);
      expect(found).toBeDefined();
      // Identity + creation time are immutable across re-saves (1:1).
      expect(found?.id).toBe(original.id);
      expect(found?.criadoEm).toEqual(original.criadoEm);
      // Content + atualizadoEm reflect the latest save.
      expect(found?.conteudo).toEqual(CONTEUDO_ATUALIZADO);
      expect(found?.atualizadoEm).toEqual(reedit.atualizadoEm);
    });

    it('persists all-null content (empty profile)', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      const vazio: ConteudoPerfilCriador = {
        nomeBebe: null,
        relacao: null,
        historia: null,
        dataNascimento: null,
        tipoEvento: null,
        dataEvento: null,
        fotoPerfilKey: null,
        fotoCapaKey: null,
        fotoHistoriaKey: null,
      };
      const perfil = makePerfilCriador(idUsuario, vazio);
      await repo.save(perfil);
      expect(await repo.findByUsuarioId(idUsuario)).toEqual(perfil);
    });

    it('save emits db.perfil_criadores.save span', async () => {
      const idUsuario = randomUUID();
      await seedUsuario(idUsuario);
      await repo.save(makePerfilCriador(idUsuario, CONTEUDO_PREENCHIDO));
      const span = options.getSpans().find((s) => s.name === 'db.perfil_criadores.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
    });
  });
}
