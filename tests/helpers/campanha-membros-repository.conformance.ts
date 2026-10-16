import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CampanhaMembrosRepository } from '../../src/adapters/arrecadacao/campanha-membros-repository.js';
import type { CampanhaRepository } from '../../src/adapters/arrecadacao/campanha-repository.js';
import type { Campanha } from '../../src/domain/arrecadacao/entities/campanha.js';
import { CampanhaPermissaoNegadaError } from '../../src/errors/arrecadacao/permissao-negada.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { assertCampaignPermission } from '../../src/use-cases/arrecadacao/assert-campaign-permission.js';
import { makeCampanhaSemRecebedor } from './campanha-repository.conformance.js';

export interface CampanhaMembrosRig {
  readonly campanhaMembrosRepository: CampanhaMembrosRepository;
  readonly campanhaRepository: CampanhaRepository;
  /**
   * Persist a NEW campanha whose `idsAdministradores[0]` is its creator/owner
   * (Postgres: what the aggregate save does for a brand-new campanha).
   */
  readonly criarCampanha: (campanha: Campanha) => Promise<void>;
  /** Add a conta to campanha_administradores only (no papel row). */
  readonly adicionarAdministrador: (idCampanha: string, idConta: string) => Promise<void>;
  /** Remove a conta from campanha_administradores only (keeps any papel row). */
  readonly removerAdministrador: (idCampanha: string, idConta: string) => Promise<void>;
}

interface ConformanceOptions {
  factory: () => Promise<CampanhaMembrosRig>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

const observability = { logger: new NoopLogger(), tracer: noopTracer() };

export function describeCampanhaMembrosRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`CampanhaMembrosRepository conformance — ${name}`, () => {
    let rig: CampanhaMembrosRig;
    let repo: CampanhaMembrosRepository;
    const owner = randomUUID();
    const membro = randomUUID();
    let idCampanha: string;

    const assertAcao = (
      idConta: string,
      acao: Parameters<typeof assertCampaignPermission>[1]['acao'],
    ) =>
      assertCampaignPermission(
        { campanhaMembrosRepository: repo, observability },
        { idCampanha, idConta, acao },
      );

    beforeEach(async () => {
      if (options.resetState) await options.resetState();
      rig = await options.factory();
      repo = rig.campanhaMembrosRepository;
      const campanha = makeCampanhaSemRecebedor({ idsAdministradores: [owner] });
      idCampanha = campanha.id;
      await rig.criarCampanha(campanha);
      options.resetSpans();
    });

    it('creator is owner and passes every action, including membros:gerenciar', async () => {
      expect(await repo.obterAcesso(idCampanha, owner)).toEqual({ papel: 'owner', permissoes: [] });
      for (const acao of [
        'recebedor:gerenciar',
        'saque:solicitar',
        'presentes:gerenciar',
        'membros:gerenciar',
      ] as const) {
        await expect(assertAcao(owner, acao)).resolves.toMatchObject({ papel: 'owner' });
      }
    });

    it('new member starts with NO permissions and is denied everything (fail-closed)', async () => {
      await rig.adicionarAdministrador(idCampanha, membro);
      await repo.adicionarMembro(idCampanha, membro);
      expect(await repo.obterAcesso(idCampanha, membro)).toEqual({
        papel: 'membro',
        permissoes: [],
      });
      await expect(assertAcao(membro, 'presentes:gerenciar')).rejects.toBeInstanceOf(
        CampanhaPermissaoNegadaError,
      );
      await expect(assertAcao(membro, 'membros:gerenciar')).rejects.toBeInstanceOf(
        CampanhaPermissaoNegadaError,
      );
    });

    it('an admin WITHOUT a papel row has no rights', async () => {
      await rig.adicionarAdministrador(idCampanha, membro);
      expect(await repo.obterAcesso(idCampanha, membro)).toBeUndefined();
      await expect(assertAcao(membro, 'saque:solicitar')).rejects.toBeInstanceOf(
        CampanhaPermissaoNegadaError,
      );
    });

    it('a papel row WITHOUT admin membership grants nothing', async () => {
      await rig.adicionarAdministrador(idCampanha, membro);
      await repo.adicionarMembro(idCampanha, membro);
      await repo.definirPermissoes(idCampanha, membro, ['saque:solicitar']);
      await rig.removerAdministrador(idCampanha, membro);
      expect(await repo.obterAcesso(idCampanha, membro)).toBeUndefined();
      await expect(assertAcao(membro, 'saque:solicitar')).rejects.toBeInstanceOf(
        CampanhaPermissaoNegadaError,
      );
    });

    it('granted actions pass, others stay denied; revocation is immediate', async () => {
      await rig.adicionarAdministrador(idCampanha, membro);
      await repo.adicionarMembro(idCampanha, membro);
      expect(await repo.definirPermissoes(idCampanha, membro, ['presentes:gerenciar'])).toBe(true);
      await expect(assertAcao(membro, 'presentes:gerenciar')).resolves.toMatchObject({
        papel: 'membro',
      });
      await expect(assertAcao(membro, 'recebedor:gerenciar')).rejects.toBeInstanceOf(
        CampanhaPermissaoNegadaError,
      );
      expect(await repo.definirPermissoes(idCampanha, membro, [])).toBe(true);
      await expect(assertAcao(membro, 'presentes:gerenciar')).rejects.toBeInstanceOf(
        CampanhaPermissaoNegadaError,
      );
    });

    it('adicionarMembro is idempotent: never downgrades an owner nor resets grants', async () => {
      await repo.adicionarMembro(idCampanha, owner);
      expect((await repo.obterAcesso(idCampanha, owner))?.papel).toBe('owner');

      await rig.adicionarAdministrador(idCampanha, membro);
      await repo.adicionarMembro(idCampanha, membro);
      await repo.definirPermissoes(idCampanha, membro, ['saque:solicitar']);
      await repo.adicionarMembro(idCampanha, membro);
      expect(await repo.obterAcesso(idCampanha, membro)).toEqual({
        papel: 'membro',
        permissoes: ['saque:solicitar'],
      });
    });

    it('definirPermissoes refuses an owner or a non-member (returns false, changes nothing)', async () => {
      expect(await repo.definirPermissoes(idCampanha, owner, ['saque:solicitar'])).toBe(false);
      expect(await repo.obterAcesso(idCampanha, owner)).toEqual({ papel: 'owner', permissoes: [] });
      expect(await repo.definirPermissoes(idCampanha, randomUUID(), ['saque:solicitar'])).toBe(
        false,
      );
    });

    it('removerMembro drops the papel; re-adding starts from zero permissions', async () => {
      await rig.adicionarAdministrador(idCampanha, membro);
      await repo.adicionarMembro(idCampanha, membro);
      await repo.definirPermissoes(idCampanha, membro, ['saque:solicitar']);
      await repo.removerMembro(idCampanha, membro);
      expect(await repo.obterAcesso(idCampanha, membro)).toBeUndefined();
      await repo.adicionarMembro(idCampanha, membro);
      expect(await repo.obterAcesso(idCampanha, membro)).toEqual({
        papel: 'membro',
        permissoes: [],
      });
    });

    it('listarMembros returns owners first, then members, with their grants', async () => {
      await rig.adicionarAdministrador(idCampanha, membro);
      await repo.adicionarMembro(idCampanha, membro);
      await repo.definirPermissoes(idCampanha, membro, ['recebedor:gerenciar']);
      expect(await repo.listarMembros(idCampanha)).toEqual([
        { idConta: owner, papel: 'owner', permissoes: [] },
        { idConta: membro, papel: 'membro', permissoes: ['recebedor:gerenciar'] },
      ]);
    });

    it('access never leaks across campanhas', async () => {
      const outra = makeCampanhaSemRecebedor({ idsAdministradores: [randomUUID()] });
      await rig.criarCampanha(outra);
      expect(await repo.obterAcesso(outra.id, owner)).toBeUndefined();
      await expect(
        assertCampaignPermission(
          { campanhaMembrosRepository: repo, observability },
          { idCampanha: outra.id, idConta: owner, acao: 'presentes:gerenciar' },
        ),
      ).rejects.toBeInstanceOf(CampanhaPermissaoNegadaError);
    });

    it('emits db.campanha_membros_permissoes.* spans with the adapter db.system', async () => {
      await repo.obterAcesso(idCampanha, owner);
      const span = options
        .getSpans()
        .find((s) => s.name === 'db.campanha_membros_permissoes.obterAcesso');
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });
  });
}
