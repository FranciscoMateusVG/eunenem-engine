import { afterAll, describe, expect, it } from 'vitest';
import { PerfilCriadorRepositoryMemory } from '../../../src/adapters/usuario/perfil-criador-repository.memory.js';
import {
  atualizarConteudoPerfilCriador,
  criarPerfilCriador,
} from '../../../src/domain/usuario/entities/perfil-criador.js';
import {
  type ConteudoPerfilCriador,
  conteudoPerfilCriadorVazio,
} from '../../../src/domain/usuario/value-objects/conteudo-perfil-criador.js';
import { createTestObservability } from '../../helpers/observability.js';
import { describePerfilCriadorRepositoryConformance } from '../../helpers/perfil-criador-repository.conformance.js';

/**
 * PerfilCriador unit tests (aperture-3dlzs):
 *   - pure entity factory/mutator behavior
 *   - memory-adapter conformance (same shared suite the postgres adapter
 *     runs, so both are pinned to identical expectations).
 */

describe('criarPerfilCriador', () => {
  it('sets atualizadoEm equal to criadoEm on creation', () => {
    const criadoEm = new Date('2026-06-01T12:00:00.000Z');
    const perfil = criarPerfilCriador({
      id: '11111111-1111-1111-1111-111111111111',
      idUsuario: '22222222-2222-2222-2222-222222222222',
      conteudo: conteudoPerfilCriadorVazio(),
      criadoEm,
    });
    expect(perfil.criadoEm).toEqual(criadoEm);
    expect(perfil.atualizadoEm).toEqual(criadoEm);
    expect(perfil.conteudo.nomeBebe).toBeNull();
  });
});

describe('atualizarConteudoPerfilCriador', () => {
  it('replaces content and bumps atualizadoEm, preserving identity + criadoEm', () => {
    const criadoEm = new Date('2026-06-01T12:00:00.000Z');
    const perfil = criarPerfilCriador({
      id: '11111111-1111-1111-1111-111111111111',
      idUsuario: '22222222-2222-2222-2222-222222222222',
      conteudo: conteudoPerfilCriadorVazio(),
      criadoEm,
    });
    const novoConteudo: ConteudoPerfilCriador = {
      ...conteudoPerfilCriadorVazio(),
      nomeBebe: 'Helena',
      tipoEvento: 'cha-bebe',
    };
    const atualizadoEm = new Date('2026-06-10T08:00:00.000Z');
    const atualizado = atualizarConteudoPerfilCriador(perfil, {
      conteudo: novoConteudo,
      atualizadoEm,
    });
    expect(atualizado.id).toBe(perfil.id);
    expect(atualizado.idUsuario).toBe(perfil.idUsuario);
    expect(atualizado.criadoEm).toEqual(criadoEm);
    expect(atualizado.atualizadoEm).toEqual(atualizadoEm);
    expect(atualizado.conteudo.nomeBebe).toBe('Helena');
    // original is untouched (pure function)
    expect(perfil.conteudo.nomeBebe).toBeNull();
  });
});

const testObs = createTestObservability();

afterAll(async () => {
  await testObs.shutdown();
});

describePerfilCriadorRepositoryConformance('Memory', {
  factory: () => new PerfilCriadorRepositoryMemory(),
  // No resetState — each beforeEach creates a fresh repo via factory.
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
