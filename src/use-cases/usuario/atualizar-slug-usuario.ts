import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { Usuario } from '../../domain/usuario/entities/usuario.js';
import { IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { SlugUsuarioSchema } from '../../domain/usuario/value-objects/slug-usuario.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import { UsuarioNaoEncontradoError } from '../../errors/usuario/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export const AtualizarSlugUsuarioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  novoSlug: SlugUsuarioSchema,
});

export type AtualizarSlugUsuarioInput = z.infer<typeof AtualizarSlugUsuarioInputSchema>;

export interface AtualizarSlugUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly observability: Observability;
}

/**
 * Edita o slug público do utilizador (aperture-2ztes).
 *
 * Diferenças face ao caminho de registo (`registrarContaUsuario`):
 *   - SEM auto-sufixo. O utilizador escolheu o slug; se já estiver em uso,
 *     o adapter levanta `UsuarioSlugJaExisteError` e nós deixamo-lo
 *     propagar tipado para a UI pedir outro slug.
 *   - Validação de formato falha → `UsuarioInputInvalidoError` (NUNCA um
 *     500): o slug vem do utilizador e um formato inválido é um erro de
 *     input, não uma exceção interna.
 *   - Existência: `findUsuarioById` antes de gravar; ausente →
 *     `UsuarioNaoEncontradoError` (404 tipado). O adapter por si só é um
 *     no-op silencioso para id desconhecido, por isso a garantia vive aqui.
 */
export async function atualizarSlugUsuario(
  deps: AtualizarSlugUsuarioDeps,
  input: AtualizarSlugUsuarioInput,
): Promise<Usuario> {
  const { usuarioRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('atualizarSlugUsuario', async (span) => {
    try {
      const parsed = AtualizarSlugUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const { idUsuario, novoSlug } = parsed.data;

      span.setAttribute('usuario.id', idUsuario);

      const existing = await usuarioRepository.findUsuarioById(idUsuario);
      if (!existing) {
        throw new UsuarioNaoEncontradoError(idUsuario);
      }

      // No auto-suffix: a taken slug propagates UsuarioSlugJaExisteError
      // from the adapter so the caller can surface "pick another".
      await usuarioRepository.atualizarSlugUsuario(idUsuario, novoSlug);

      const updated: Usuario = {
        ...existing,
        slug: novoSlug,
      };

      logger.info('usuario.slug.atualizado', { idUsuario });

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
