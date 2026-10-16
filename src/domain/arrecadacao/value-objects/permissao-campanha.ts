import { z } from 'zod/v4';

/**
 * Permissões por ação em campanhas compartilhadas (aperture-1z18g).
 *
 * Cada administrador de uma campanha tem um `PapelMembroCampanha`:
 *   - 'owner'  → TODAS as ações, inclusive `membros:gerenciar`.
 *   - 'membro' → só as ações concedidas pelo owner (`permissoes`).
 *
 * `membros:gerenciar` é exclusiva do owner: nunca pode ser concedida a um
 * membro (não está em `ACOES_CONCEDIVEIS`).
 */

export const ACOES_CONCEDIVEIS = [
  /** Criar/editar o recebedor e ver os dados bancários completos. */
  'recebedor:gerenciar',
  /** Solicitar transferência (saque) do saldo. */
  'saque:solicitar',
  /** Adicionar, editar e remover presentes da lista. */
  'presentes:gerenciar',
] as const;

export const AcaoConcedivelSchema = z.enum(ACOES_CONCEDIVEIS);
export type AcaoConcedivel = z.infer<typeof AcaoConcedivelSchema>;

export const AcaoCampanhaSchema = z.enum([...ACOES_CONCEDIVEIS, 'membros:gerenciar']);
export type AcaoCampanha = z.infer<typeof AcaoCampanhaSchema>;

export const PapelMembroCampanhaSchema = z.enum(['owner', 'membro']);
export type PapelMembroCampanha = z.infer<typeof PapelMembroCampanhaSchema>;

export interface AcessoMembroCampanha {
  readonly papel: PapelMembroCampanha;
  readonly permissoes: readonly AcaoConcedivel[];
}

/** Regra única: owner pode tudo; membro só o que foi concedido. */
export function acessoPermite(acesso: AcessoMembroCampanha, acao: AcaoCampanha): boolean {
  if (acesso.papel === 'owner') return true;
  if (acao === 'membros:gerenciar') return false;
  return acesso.permissoes.includes(acao);
}

/** Lista efetiva de ações (owner = todas). Usada pela UI para esconder o que o membro não pode. */
export function acoesPermitidas(acesso: AcessoMembroCampanha): readonly AcaoCampanha[] {
  return AcaoCampanhaSchema.options.filter((acao) => acessoPermite(acesso, acao));
}
