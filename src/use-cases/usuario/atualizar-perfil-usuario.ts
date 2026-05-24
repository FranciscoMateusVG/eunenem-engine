import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { Usuario } from '../../domain/usuario/entities/usuario.js';
import { IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { NomeExibicaoUsuarioSchema } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const AtualizarPerfilUsuarioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  nomeExibicao: NomeExibicaoUsuarioSchema,
});

export type AtualizarPerfilUsuarioInput = z.infer<typeof AtualizarPerfilUsuarioInputSchema>;

export interface AtualizarPerfilUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly observability: Observability;
}

/**
 * Atualiza o nome de exibição (perfil) do utilizador.
 */
export async function atualizarPerfilUsuario(
  deps: AtualizarPerfilUsuarioDeps,
  input: AtualizarPerfilUsuarioInput,
): Promise<Usuario> {
  const { usuarioRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('atualizarPerfilUsuario', async (span) => {
    try {
      const parsed = AtualizarPerfilUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const { idUsuario, nomeExibicao } = parsed.data;

      span.setAttribute('usuario.id', idUsuario);

      const existing = await usuarioRepository.findUsuarioById(idUsuario);
      if (!existing) {
        throw new UsuarioInputInvalidoError('Usuario nao encontrado');
      }

      await usuarioRepository.atualizarNomeExibicaoUsuario(idUsuario, nomeExibicao);

      const updated: Usuario = {
        ...existing,
        nomeExibicao,
      };

      logger.info('usuario.perfil.atualizado', { idUsuario });

      span.setStatus({ code: SpanStatusCode.OK });
      return updated;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
