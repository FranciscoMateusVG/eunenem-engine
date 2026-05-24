import type { Conta, CredencialSimulada, Usuario } from '../../domain/usuario/entities/usuario.js';
import type { EmailUsuario } from '../../domain/usuario/value-objects/email-usuario.js';
import type {
  IdContaUsuario,
  IdPlataformaReferencia,
  IdUsuario,
} from '../../domain/usuario/value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';

/**
 * Persistência de utilizador, conta e credencial simulada (porta).
 *
 * Uniqueness de email é composta `(idPlataforma, email)` — a mesma pessoa
 * pode registrar-se em eunenem E eucasei como dois `Usuario` distintos.
 */
export interface UsuarioRepository {
  saveRegistro(bundle: {
    readonly usuario: Usuario;
    readonly conta: Conta;
    readonly credencial: CredencialSimulada;
  }): Promise<void>;

  findUsuarioById(id: IdUsuario): Promise<Usuario | undefined>;
  findUsuarioByEmail(
    idPlataforma: IdPlataformaReferencia,
    email: EmailUsuario,
  ): Promise<Usuario | undefined>;
  findContaById(id: IdContaUsuario): Promise<Conta | undefined>;
  findCredencialByIdUsuario(idUsuario: IdUsuario): Promise<CredencialSimulada | undefined>;
  atualizarNomeExibicaoUsuario(
    idUsuario: IdUsuario,
    nomeExibicao: NomeExibicaoUsuario,
  ): Promise<void>;
}
