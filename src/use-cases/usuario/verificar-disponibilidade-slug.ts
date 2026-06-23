import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import { IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { SlugUsuarioSchema } from '../../domain/usuario/value-objects/slug-usuario.js';
import { UsuarioNaoEncontradoError } from '../../errors/usuario/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Input para a verificação de disponibilidade (aperture-2ztes).
 *
 * `slug` NÃO usa `SlugUsuarioSchema` aqui — um formato inválido não é um
 * erro, é apenas "indisponível por formato". A validação de formato é feita
 * em runtime via `SlugUsuarioSchema.safeParse` para que possamos devolver
 * `{ disponivel: false, motivo: 'formato' }` em vez de levantar.
 */
export const VerificarDisponibilidadeSlugInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  slug: z.string(),
});

export type VerificarDisponibilidadeSlugInput = z.infer<
  typeof VerificarDisponibilidadeSlugInputSchema
>;

export interface VerificarDisponibilidadeSlugResult {
  readonly disponivel: boolean;
  /** Por que está indisponível. Ausente quando `disponivel: true`. */
  readonly motivo?: 'formato' | 'em_uso';
}

export interface VerificarDisponibilidadeSlugDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly observability: Observability;
}

/**
 * Verifica se um slug está disponível para o utilizador (aperture-2ztes).
 * Suporta a verificação inline de disponibilidade na UI de edição (V2).
 *
 * Fluxo:
 *   1. Valida o formato via `SlugUsuarioSchema.safeParse`. Falha →
 *      `{ disponivel: false, motivo: 'formato' }` (NÃO levanta — formato é
 *      um resultado, não uma exceção).
 *   2. Resolve a `idPlataforma` do chamador via `findUsuarioById`. Chamador
 *      ausente → `UsuarioNaoEncontradoError` (404 tipado).
 *   3. `findUsuarioBySlug(idPlataforma, slug)` — se ninguém o tem, ou se o
 *      próprio chamador já o tem (re-check do slug atual), está disponível;
 *      caso contrário `{ disponivel: false, motivo: 'em_uso' }`.
 */
export async function verificarDisponibilidadeSlug(
  deps: VerificarDisponibilidadeSlugDeps,
  input: VerificarDisponibilidadeSlugInput,
): Promise<VerificarDisponibilidadeSlugResult> {
  const { usuarioRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('verificarDisponibilidadeSlug', async (span) => {
    try {
      const { idUsuario, slug } = VerificarDisponibilidadeSlugInputSchema.parse(input);

      span.setAttribute('usuario.id', idUsuario);

      const formato = SlugUsuarioSchema.safeParse(slug);
      if (!formato.success) {
        span.setStatus({ code: SpanStatusCode.OK });
        const indisponivel: VerificarDisponibilidadeSlugResult = {
          disponivel: false,
          motivo: 'formato',
        };
        return indisponivel;
      }

      const chamador = await usuarioRepository.findUsuarioById(idUsuario);
      if (!chamador) {
        throw new UsuarioNaoEncontradoError(idUsuario);
      }

      const dono = await usuarioRepository.findUsuarioBySlug(chamador.idPlataforma, formato.data);
      // Disponível se ninguém o tem OU se o próprio chamador já o tem
      // (re-check do slug atual não deve reportar-se como "em uso").
      const disponivel = dono === undefined || dono.id === idUsuario;

      span.setStatus({ code: SpanStatusCode.OK });
      const resultado: VerificarDisponibilidadeSlugResult = disponivel
        ? { disponivel: true }
        : { disponivel: false, motivo: 'em_uso' };
      return resultado;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
