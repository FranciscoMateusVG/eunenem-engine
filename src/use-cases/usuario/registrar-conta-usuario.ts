import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { PlataformaRepository } from '../../adapters/plataforma/repository.js';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { Conta, Usuario } from '../../domain/usuario/entities/usuario.js';
import { EmailUsuarioSchema } from '../../domain/usuario/value-objects/email-usuario.js';
import {
  IdContaUsuarioSchema,
  IdPlataformaReferenciaSchema,
  IdUsuarioSchema,
} from '../../domain/usuario/value-objects/ids.js';
import { NomeExibicaoUsuarioSchema } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import { PERMISSOES_PADRAO } from '../../domain/usuario/value-objects/permissao.js';
import { SenhaSimuladaSchema } from '../../domain/usuario/value-objects/senha-simulada.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import { UsuarioPlataformaNaoEncontradaError } from '../../errors/usuario/plataforma-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

export const RegistrarContaUsuarioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  idPlataforma: IdPlataformaReferenciaSchema,
  idConta: IdContaUsuarioSchema,
  email: EmailUsuarioSchema,
  nomeExibicao: NomeExibicaoUsuarioSchema,
  senhaSimulada: SenhaSimuladaSchema,
});

export type RegistrarContaUsuarioInput = z.infer<typeof RegistrarContaUsuarioInputSchema>;

export interface RegistrarContaUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly plataformaRepository: PlataformaRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface RegistrarContaUsuarioResult {
  readonly usuario: Usuario;
  readonly conta: Conta;
}

/**
 * Regista utilizador, conta administrativa (1:1), perfil inicial e credencial
 * simulada, escopado à plataforma informada. Email é único por
 * `(idPlataforma, email)` — a mesma pessoa pode registrar em eunenem e
 * eucasei como contas separadas.
 */
export async function registrarContaUsuario(
  deps: RegistrarContaUsuarioDeps,
  input: RegistrarContaUsuarioInput,
): Promise<RegistrarContaUsuarioResult> {
  const { usuarioRepository, plataformaRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('registrarContaUsuario', async (span) => {
    try {
      const parsed = RegistrarContaUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const data = parsed.data;
      const criadoEm = clock();

      span.setAttribute('usuario.id', data.idUsuario);
      span.setAttribute('usuario.plataforma.id', data.idPlataforma);
      span.setAttribute('usuario.conta.id', data.idConta);
      span.setAttribute('usuario.email.length', data.email.length);

      const plataforma = await plataformaRepository.findById(data.idPlataforma);
      if (!plataforma) {
        throw new UsuarioPlataformaNaoEncontradaError(data.idPlataforma);
      }

      const usuario: Usuario = {
        id: data.idUsuario,
        idPlataforma: data.idPlataforma,
        idConta: data.idConta,
        email: data.email,
        nomeExibicao: data.nomeExibicao,
        criadoEm,
      };

      const conta: Conta = {
        id: data.idConta,
        idUsuario: data.idUsuario,
        permissoes: PERMISSOES_PADRAO,
        criadaEm: criadoEm,
      };

      const credencial = {
        idUsuario: data.idUsuario,
        senhaSimulada: data.senhaSimulada,
      };

      await usuarioRepository.saveRegistro({ usuario, conta, credencial });

      logger.info('usuario.conta.registrada', {
        idUsuario: usuario.id,
        idPlataforma: usuario.idPlataforma,
        idConta: conta.id,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { usuario, conta };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
