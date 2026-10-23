/**
 * aperture-1z18g (kpesy-04) — the painel dashboard filters menu rows and the
 * recebido card by the caller's effective actions (campanhaMembros.meuAcesso).
 * Real-browser evidence: e2e/1z18g-member-permissions-ui.spec.ts (dashboard case).
 */
import { describe, expect, it } from 'vitest';
import {
  buildPainelMenu,
  PAINEL_DEMO,
} from '../../../apps/eunenem-server/pages/lib/mocks/painelDemo.js';
import {
  filtrarMenuPorAcesso,
  visibilidadeRecebido,
} from '../../../apps/eunenem-server/pages/lib/painel-permissoes.js';
import {
  ACOES_CONCEDIVEIS,
  type AcaoCampanha,
  PERMISSOES_PADRAO_MEMBRO,
} from '../../../src/domain/arrecadacao/value-objects/permissao-campanha.js';

const com = (acoes: readonly AcaoCampanha[]) => (a: AcaoCampanha) => acoes.includes(a);
const ids = (pode: (a: AcaoCampanha) => boolean) =>
  filtrarMenuPorAcesso(buildPainelMenu(PAINEL_DEMO), pode).flatMap((g) => g.items.map((i) => i.id));

describe('painel dashboard — filtered by member permissions', () => {
  it('owner (every action) keeps every row', () => {
    const todas = buildPainelMenu(PAINEL_DEMO).flatMap((g) => g.items.map((i) => i.id));
    expect(ids(com([...ACOES_CONCEDIVEIS, 'membros:gerenciar']))).toEqual(todas);
  });

  it('default member: no statement, bank data or sharing rows; editing rows stay', () => {
    const visiveis = ids(com(PERMISSOES_PADRAO_MEMBRO));
    expect(visiveis).not.toContain('presentes');
    expect(visiveis).not.toContain('bancarios');
    expect(visiveis).not.toContain('compartilhar');
    for (const id of [
      'lista',
      'convite',
      'preview',
      'lista-convidados',
      'mensagens',
      'perfil',
      'suporte',
    ]) {
      expect(visiveis).toContain(id);
    }
  });

  it('member with no grants still sees the gift list, preview and support; empty groups are dropped', () => {
    const grupos = filtrarMenuPorAcesso(buildPainelMenu(PAINEL_DEMO), com([]));
    expect(grupos.flatMap((g) => g.items.map((i) => i.id)).sort()).toEqual(
      ['configuracoes', 'lista', 'preview', 'rifa', 'suporte'].sort(),
    );
    expect(grupos.map((g) => g.id)).not.toContain('convidados');
  });

  it('sharing row is owner-only even with every grantable action', () => {
    expect(ids(com(ACOES_CONCEDIVEIS))).not.toContain('compartilhar');
  });

  it('recebido card: amount/strip need extrato:ver; resgatar needs extrato:ver AND saque:solicitar', () => {
    expect(visibilidadeRecebido(com(PERMISSOES_PADRAO_MEMBRO))).toEqual({
      valor: false,
      resgatar: false,
      presentes: false,
      confirmados: true,
      recados: false,
      card: true,
    });
    expect(visibilidadeRecebido(com(['saque:solicitar'])).resgatar).toBe(false);
    expect(visibilidadeRecebido(com(['extrato:ver'])).resgatar).toBe(false);
    expect(visibilidadeRecebido(com(['extrato:ver', 'saque:solicitar'])).resgatar).toBe(true);
    expect(visibilidadeRecebido(com([])).card).toBe(false);
  });
});
