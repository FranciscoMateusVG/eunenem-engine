import { afterAll, describe, expect, it } from 'vitest';
import { PerfilCampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/perfil-campanha-repository.memory.js';
import {
  atualizarConteudoPerfilCampanha,
  criarPerfilCampanha,
} from '../../../src/domain/arrecadacao/entities/perfil-campanha.js';
import {
  type ConteudoPerfilCriador,
  conteudoPerfilCriadorVazio,
} from '../../../src/domain/usuario/value-objects/conteudo-perfil-criador.js';
import { createTestObservability } from '../../helpers/observability.js';
import { describePerfilCampanhaRepositoryConformance } from '../../helpers/perfil-campanha-repository.conformance.js';

/**
 * PerfilCampanha unit tests (aperture-aphk8):
 *   - pure entity factory/mutator behavior (mirrors perfil-criador's)
 *   - memory-adapter conformance (same shared suite the postgres adapter
 *     runs, so both are pinned to identical expectations).
 */

describe('criarPerfilCampanha', () => {
  it('sets atualizadoEm equal to criadoEm on creation', () => {
    const criadoEm = new Date('2026-07-01T12:00:00.000Z');
    const perfil = criarPerfilCampanha({
      id: '11111111-1111-1111-1111-111111111111',
      idCampanha: '22222222-2222-2222-2222-222222222222',
      conteudo: conteudoPerfilCriadorVazio(),
      criadoEm,
    });
    expect(perfil.criadoEm).toEqual(criadoEm);
    expect(perfil.atualizadoEm).toEqual(criadoEm);
    expect(perfil.conteudo.nomeBebe).toBeNull();
  });
});

describe('atualizarConteudoPerfilCampanha', () => {
  it('replaces content and bumps atualizadoEm, preserving identity + criadoEm', () => {
    const criadoEm = new Date('2026-07-01T12:00:00.000Z');
    const perfil = criarPerfilCampanha({
      id: '11111111-1111-1111-1111-111111111111',
      idCampanha: '22222222-2222-2222-2222-222222222222',
      conteudo: conteudoPerfilCriadorVazio(),
      criadoEm,
    });
    const novoConteudo: ConteudoPerfilCriador = {
      ...conteudoPerfilCriadorVazio(),
      nomeBebe: 'Helena',
      tipoEvento: 'cha-bebe',
    };
    const atualizadoEm = new Date('2026-07-10T08:00:00.000Z');
    const atualizado = atualizarConteudoPerfilCampanha(perfil, {
      conteudo: novoConteudo,
      atualizadoEm,
    });
    expect(atualizado.id).toBe(perfil.id);
    expect(atualizado.idCampanha).toBe(perfil.idCampanha);
    expect(atualizado.criadoEm).toEqual(criadoEm);
    expect(atualizado.atualizadoEm).toEqual(atualizadoEm);
    expect(atualizado.conteudo.nomeBebe).toBe('Helena');
    // original is untouched (pure function)
    expect(perfil.conteudo.nomeBebe).toBeNull();
    expect(perfil.atualizadoEm).toEqual(criadoEm);
  });
});

const testObs = createTestObservability();

afterAll(async () => {
  await testObs.shutdown();
});

describePerfilCampanhaRepositoryConformance('Memory', {
  factory: () => new PerfilCampanhaRepositoryMemory(),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
