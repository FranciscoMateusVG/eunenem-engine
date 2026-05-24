import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { Conta, Usuario } from '../../domain/usuario/entities/usuario.js';
import { EmailUsuarioSchema } from '../../domain/usuario/value-objects/email-usuario.js';
import { IdContaUsuarioSchema, IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { NomeExibicaoUsuarioSchema } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import { PERMISSOES_PADRAO } from '../../domain/usuario/value-objects/permissao.js';
import { SenhaSimuladaSchema } from '../../domain/usuario/value-objects/senha-simulada.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const RegistrarContaUsuarioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  idConta: IdContaUsuarioSchema,
  email: EmailUsuarioSchema,
  nomeExibicao: NomeExibicaoUsuarioSchema,
  senhaSimulada: SenhaSimuladaSchema,
});

export type RegistrarContaUsuarioInput = z.infer<typeof RegistrarContaUsuarioInputSchema>;

export interface RegistrarContaUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface RegistrarContaUsuarioResult {
  readonly usuario: Usuario;
  readonly conta: Conta;
}

/**
 * Regista utilizador, conta administrativa (1:1), perfil inicial e credencial simulada.
 */
export async function registrarContaUsuario(
  deps: RegistrarContaUsuarioDeps,
  input: RegistrarContaUsuarioInput,
): Promise<RegistrarContaUsuarioResult> {
  const { usuarioRepository, clock, observability } = deps;
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
      span.setAttribute('usuario.conta.id', data.idConta);
      span.setAttribute('usuario.email.length', data.email.length);

      const usuario: Usuario = {
        id: data.idUsuario,
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
