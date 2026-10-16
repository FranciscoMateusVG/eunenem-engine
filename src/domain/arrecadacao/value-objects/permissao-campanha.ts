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
  /** Adicionar, editar e remover presentes da lista. */
  'presentes:gerenciar',
  /** Editar o perfil da campanha (textos, fotos, personalização). */
  'perfil:editar',
  /** Ler os recados deixados pelos convidados. */
  'mensagens:ver',
  /** Marcar recados como lidos. */
  'mensagens:gerenciar',
  /** Ver a lista de convidados do evento. */
  'convidados:ver',
  /** Editar o convite do evento e a lista de convidados. */
  'convite:editar',
  /** Alterar o link público (slug) da campanha. */
  'link:editar',
  /** Ver o extrato financeiro (valores recebidos, saldo, transferências). */
  'extrato:ver',
  /** Criar/editar o recebedor e ver os dados bancários completos. */
  'recebedor:gerenciar',
  /** Solicitar transferência (saque) do saldo. */
  'saque:solicitar',
] as const;

export const AcaoConcedivelSchema = z.enum(ACOES_CONCEDIVEIS);
export type AcaoConcedivel = z.infer<typeof AcaoConcedivelSchema>;

/**
 * Permissões de um membro recém-convidado (decisão do operador, 2026-10-16):
 * pode cuidar da lista, recados, perfil, convite e convidados; NÃO mexe em
 * link, extrato, dados bancários, saque nem membros. O owner ajusta por membro depois.
 */
export const PERMISSOES_PADRAO_MEMBRO: readonly AcaoConcedivel[] = [
  'presentes:gerenciar',
  'perfil:editar',
  'mensagens:ver',
  'mensagens:gerenciar',
  'convidados:ver',
  'convite:editar',
];

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
