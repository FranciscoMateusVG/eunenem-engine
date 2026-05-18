import type {
  Conta,
  CredencialSimulada,
  EmailUsuario,
  IdContaUsuario,
  IdUsuario,
  NomeExibicaoUsuario,
  Usuario,
} from '../domain/usuario.js';

/**
 * Persistência de utilizador, conta e credencial simulada (porta).
 */
export interface UsuarioRepository {
  saveRegistro(bundle: {
    readonly usuario: Usuario;
    readonly conta: Conta;
    readonly credencial: CredencialSimulada;
  }): Promise<void>;

  findUsuarioById(id: IdUsuario): Promise<Usuario | undefined>;
  findUsuarioByEmail(email: EmailUsuario): Promise<Usuario | undefined>;
  findContaById(id: IdContaUsuario): Promise<Conta | undefined>;
  findCredencialByIdUsuario(idUsuario: IdUsuario): Promise<CredencialSimulada | undefined>;
  atualizarNomeExibicaoUsuario(
    idUsuario: IdUsuario,
    nomeExibicao: NomeExibicaoUsuario,
  ): Promise<void>;
}
