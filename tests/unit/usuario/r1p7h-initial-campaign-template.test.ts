import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { CatalogoRepositoryMemory } from '../../../src/adapters/catalogo/repository.memory.js';
import { PlataformaRepositoryMemory } from '../../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceMemoria } from '../../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import type { Contribuicao } from '../../../src/domain/arrecadacao/entities/contribuicao.js';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/index.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import {
  InitialCampaignGiftTemplateInvalidError,
  provisionarContaUsuarioDominio,
  registrarContaUsuario,
} from '../../../src/use-cases/usuario/registrar-conta-usuario.js';
import {
  makeCatalogoCategoria,
  makeCatalogoLista,
  makeCatalogoListaItem,
  makeCatalogoProduto,
} from '../../helpers/catalogo-repository.conformance.js';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const observability = { logger: new NoopLogger(), tracer: noopTracer() };

function buildRig() {
  const recebedorRepository = new RecebedorRepositoryMemory();
  return {
    authService: new AuthServiceMemoria({ clock: () => NOW, sessionTtlMs: 60_000 }),
    campanhaRepository: new CampanhaRepositoryMemory(recebedorRepository),
    catalogoRepository: new CatalogoRepositoryMemory(),
    contribuicaoRepository: new ContribuicaoRepositoryMemory(),
    plataformaRepository: new PlataformaRepositoryMemory(),
    recebedorRepository,
    usuarioRepository: new UsuarioRepositoryMemory(),
  };
}

async function seedSelectedTemplate(
  catalogoRepository: CatalogoRepositoryMemory,
  overrides: { readonly nome?: string; readonly quantidade?: number } = {},
) {
  const categoria = makeCatalogoCategoria();
  const produto = makeCatalogoProduto(categoria.id, {
    nome: overrides.nome ?? 'Carrinho de bebê',
    precoCents: 54_990,
    imageUrl: '/catalogo/carrinho.webp',
  });
  const lista = makeCatalogoLista({ slug: 'lista-inicial' });
  await catalogoRepository.createCategoria(categoria);
  await catalogoRepository.createProduto(produto);
  await catalogoRepository.createLista(lista);
  await catalogoRepository.replaceListaItens(lista.id, [
    makeCatalogoListaItem(lista.id, produto.id, {
      quantidade: overrides.quantidade ?? 2,
    }),
  ]);
  await catalogoRepository.setInitialCampaignDefault(lista.id, () => undefined);
  return { lista, produto };
}

describe('initial campaign gift template provisioning', () => {
  it('preserves the historical empty campaign when no default is configured', async () => {
    const rig = buildRig();
    const result = await provisionarContaUsuarioDominio(
      {
        ...rig,
        clock: () => NOW,
        catalogImageUrlReadable: () => true,
        observability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'sem-default@example.com',
        nome: 'Sem Default',
      },
    );

    expect(await rig.contribuicaoRepository.findByCampanhaId(result.campanha.id)).toEqual([]);
  });

  it('copies the coherent selected snapshot into the first campaign only', async () => {
    const rig = buildRig();
    const { lista, produto } = await seedSelectedTemplate(rig.catalogoRepository);
    const result = await registrarContaUsuario(
      {
        ...rig,
        clock: () => NOW,
        catalogImageUrlReadable: (value) => value.startsWith('/catalogo/'),
        observability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'com-default@example.com',
        nomeExibicao: 'Com Default',
        senhaSimulada: 'senha-local',
      },
    );

    expect(await rig.contribuicaoRepository.findByCampanhaId(result.campanha.id)).toEqual([
      expect.objectContaining({
        nome: produto.nome,
        valor: produto.precoCents,
        imagemUrl: produto.imageUrl,
        grupo: lista.slug,
        quantidade: 2,
      }),
    ]);
  });

  it('does not rewrite an existing personal copy after the template changes', async () => {
    const rig = buildRig();
    const { lista, produto } = await seedSelectedTemplate(rig.catalogoRepository, {
      nome: 'Versão original',
    });
    const deps = {
      ...rig,
      clock: () => NOW,
      catalogImageUrlReadable: () => true,
      observability,
    };
    const first = await provisionarContaUsuarioDominio(deps, {
      idUsuario: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email: 'primeira@example.com',
      nome: 'Primeira',
    });

    await rig.catalogoRepository.updateProduto(produto.id, {
      nome: 'Versão nova',
      atualizadoEm: new Date(NOW.getTime() + 1_000),
    });
    await rig.catalogoRepository.replaceListaItens(lista.id, [
      makeCatalogoListaItem(lista.id, produto.id, { quantidade: 4 }),
    ]);
    const second = await provisionarContaUsuarioDominio(deps, {
      idUsuario: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email: 'segunda@example.com',
      nome: 'Segunda',
    });

    expect(await rig.contribuicaoRepository.findByCampanhaId(first.campanha.id)).toEqual([
      expect.objectContaining({ nome: 'Versão original', quantidade: 2 }),
    ]);
    expect(await rig.contribuicaoRepository.findByCampanhaId(second.campanha.id)).toEqual([
      expect.objectContaining({ nome: 'Versão nova', quantidade: 4 }),
    ]);
  });

  it('rejects an invalid configured marker before domain writes', async () => {
    const rig = buildRig();
    const invalid = makeCatalogoLista({ aplicarCampanhaInicial: true });
    await rig.catalogoRepository.createLista(invalid);
    const idUsuario = randomUUID();

    await expect(
      provisionarContaUsuarioDominio(
        {
          ...rig,
          clock: () => NOW,
          catalogImageUrlReadable: () => true,
          observability,
        },
        {
          idUsuario,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'invalido@example.com',
          nome: 'Inválido',
        },
      ),
    ).rejects.toBeInstanceOf(InitialCampaignGiftTemplateInvalidError);
    expect(await rig.usuarioRepository.findUsuarioById(idUsuario)).toBeUndefined();
  });

  it('rejects a selected item that would require silent string normalization', async () => {
    const rig = buildRig();
    const { produto } = await seedSelectedTemplate(rig.catalogoRepository);
    await rig.catalogoRepository.updateProduto(produto.id, {
      nome: '  Nome que exigiria trim  ',
      atualizadoEm: NOW,
    });
    const idUsuario = randomUUID();

    await expect(
      provisionarContaUsuarioDominio(
        {
          ...rig,
          clock: () => NOW,
          catalogImageUrlReadable: () => true,
          observability,
        },
        {
          idUsuario,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'normalizacao@example.com',
          nome: 'Normalização',
        },
      ),
    ).rejects.toBeInstanceOf(InitialCampaignGiftTemplateInvalidError);
    expect(await rig.usuarioRepository.findUsuarioById(idUsuario)).toBeUndefined();
  });

  it('runs LIFO compensation when the final bulk insert fails and permits a clean retry', async () => {
    const rig = buildRig();
    await seedSelectedTemplate(rig.catalogoRepository);
    let fail = true;
    const originalSaveBulk = rig.contribuicaoRepository.saveBulk.bind(rig.contribuicaoRepository);
    rig.contribuicaoRepository.saveBulk = async (contribuicoes: readonly Contribuicao[]) => {
      if (fail) throw new Error('bulk unavailable');
      await originalSaveBulk(contribuicoes);
    };
    const input = {
      idUsuario: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email: 'retry@example.com',
      nome: 'Retry',
    } as const;
    const deps = {
      ...rig,
      clock: () => NOW,
      catalogImageUrlReadable: () => true,
      observability,
    };

    await expect(provisionarContaUsuarioDominio(deps, input)).rejects.toThrow('bulk unavailable');
    expect(await rig.usuarioRepository.findUsuarioById(input.idUsuario)).toBeUndefined();
    fail = false;
    const retried = await provisionarContaUsuarioDominio(deps, input);
    expect(await rig.contribuicaoRepository.findByCampanhaId(retried.campanha.id)).toHaveLength(1);
  });
});
