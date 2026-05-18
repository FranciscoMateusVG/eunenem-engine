import { z } from 'zod/v4';

/**
 * BC **Usuário**: administradores de campanhas (sem auth real; didático em memória).
 * `IdConta` é compatível com `idContaCriadora` em Arrecadação.
 */

export const IdUsuarioSchema = z.uuid();
export type IdUsuario = z.infer<typeof IdUsuarioSchema>;

/** Conta administrativa (1:1 com utilizador nesta fatia). */
export const IdContaUsuarioSchema = z.uuid();
export type IdContaUsuario = z.infer<typeof IdContaUsuarioSchema>;

export const EmailUsuarioSchema = z
  .string()
  .trim()
  .transform((s) => s.toLowerCase())
  .pipe(z.string().email('Deve ser um email valido'));

export type EmailUsuario = z.infer<typeof EmailUsuarioSchema>;

export const NomeExibicaoUsuarioSchema = z
  .string()
  .trim()
  .min(1, 'Nome de exibicao nao pode ser vazio')
  .max(120);

export type NomeExibicaoUsuario = z.infer<typeof NomeExibicaoUsuarioSchema>;

/** Permissão rudimentar (sem RBAC completo). */
export const PermissaoSchema = z.enum(['campaign:admin']);
export type Permissao = z.infer<typeof PermissaoSchema>;

export const PERMISSOES_PADRAO: readonly Permissao[] = ['campaign:admin'];

export const SenhaSimuladaSchema = z
  .string()
  .min(1, 'Senha simulada nao pode ser vazia')
  .max(200, 'Senha simulada e longa demais');

export type SenhaSimulada = z.infer<typeof SenhaSimuladaSchema>;

/** Token opaco de sessão (não é JWT). */
export const TokenSessaoSchema = z
  .string()
  .min(32, 'Token de sessao deve ser opaco e longo o suficiente');

export type TokenSessao = z.infer<typeof TokenSessaoSchema>;

export interface Usuario {
  readonly id: IdUsuario;
  readonly idConta: IdContaUsuario;
  readonly email: EmailUsuario;
  readonly nomeExibicao: NomeExibicaoUsuario;
  readonly criadoEm: Date;
}

/** Conta: permissões administrativas ligadas a um utilizador. */
export interface Conta {
  readonly id: IdContaUsuario;
  readonly idUsuario: IdUsuario;
  readonly permissoes: readonly Permissao[];
  readonly criadaEm: Date;
}

/** Credencial simulada (texto plano só para demo — nunca produção). */
export interface CredencialSimulada {
  readonly idUsuario: IdUsuario;
  readonly senhaSimulada: SenhaSimulada;
}

export interface Sessao {
  readonly token: TokenSessao;
  readonly idConta: IdContaUsuario;
  readonly expiraEm: Date;
}

export const RegistrarContaUsuarioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  idConta: IdContaUsuarioSchema,
  email: EmailUsuarioSchema,
  nomeExibicao: NomeExibicaoUsuarioSchema,
  senhaSimulada: SenhaSimuladaSchema,
});

export type RegistrarContaUsuarioInput = z.infer<typeof RegistrarContaUsuarioInputSchema>;

export const AtualizarPerfilUsuarioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  nomeExibicao: NomeExibicaoUsuarioSchema,
});

export type AtualizarPerfilUsuarioInput = z.infer<typeof AtualizarPerfilUsuarioInputSchema>;

export const CriarSessaoUsuarioInputSchema = z.object({
  email: EmailUsuarioSchema,
  senhaSimulada: SenhaSimuladaSchema,
});

export type CriarSessaoUsuarioInput = z.infer<typeof CriarSessaoUsuarioInputSchema>;

export const AutorizarPermissaoUsuarioInputSchema = z.object({
  token: TokenSessaoSchema,
  permissao: PermissaoSchema,
});

export type AutorizarPermissaoUsuarioInput = z.infer<typeof AutorizarPermissaoUsuarioInputSchema>;

/** Verifica se a sessão já expirou (regra pura). */
export function sessaoExpirada(sessao: Sessao, agora: Date): boolean {
  return agora.getTime() >= sessao.expiraEm.getTime();
}

/** Verifica se a conta concede a permissão pedida. */
export function contaTemPermissao(conta: Conta, permissao: Permissao): boolean {
  return conta.permissoes.includes(permissao);
}
