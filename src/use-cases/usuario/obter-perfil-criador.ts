import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { PerfilCriadorRepository } from '../../adapters/usuario/perfil-criador-repository.js';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import { TipoEventoPerfilSchema } from '../../domain/usuario/value-objects/tipo-evento-perfil.js';
import { UsuarioNaoEncontradoError } from '../../errors/usuario/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * AUTHED own-profile view (aperture-cdo69) — what the painel `PerfilBody`
 * form loads. Combines `Usuario` identity (nomeExibicao=creatorName, slug)
 * with the `PerfilCriador` content. Dates are ISO strings (no transformer
 * assumed). A user with no profile row yet gets all-null content (the form
 * renders empty, not an error).
 */
export const PerfilProprioDTOSchema = z.object({
  slug: z.string(),
  creatorName: z.string(),
  nomeBebe: z.string().nullable(),
  relacao: z.string().nullable(),
  historia: z.string().nullable(),
  tipoEvento: TipoEventoPerfilSchema.nullable(),
  dataEvento: z.string().nullable(),
  dataNascimento: z.string().nullable(),
  fotoPerfil: z.string().nullable(),
  fotoCapa: z.string().nullable(),
  fotoHistoria: z.string().nullable(),
});

export type PerfilProprioDTO = z.infer<typeof PerfilProprioDTOSchema>;

export interface ObterPerfilCriadorDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly perfilCriadorRepository: PerfilCriadorRepository;
  readonly observability: Observability;
}

/**
 * Read the caller's own profile. Auth is NOT enforced here — the tRPC
 * procedure derives `idUsuario` from the session and passes it in.
 */
export async function obterPerfilCriador(
  deps: ObterPerfilCriadorDeps,
  idUsuario: IdUsuario,
): Promise<PerfilProprioDTO> {
  const { usuarioRepository, perfilCriadorRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterPerfilCriador', async (span) => {
    try {
      span.setAttribute('usuario.id', idUsuario);
      const usuario = await usuarioRepository.findUsuarioById(idUsuario);
      if (!usuario) {
        throw new UsuarioNaoEncontradoError(idUsuario);
      }

      const perfil = await perfilCriadorRepository.findByUsuarioId(idUsuario);
      const c = perfil?.conteudo;

      const dto: PerfilProprioDTO = {
        slug: usuario.slug,
        creatorName: usuario.nomeExibicao,
        nomeBebe: c?.nomeBebe ?? null,
        relacao: c?.relacao ?? null,
        historia: c?.historia ?? null,
        tipoEvento: c?.tipoEvento ?? null,
        dataEvento: c?.dataEvento ? c.dataEvento.toISOString() : null,
        dataNascimento: c?.dataNascimento ? c.dataNascimento.toISOString() : null,
        fotoPerfil: c?.fotoPerfilKey ?? null,
        fotoCapa: c?.fotoCapaKey ?? null,
        fotoHistoria: c?.fotoHistoriaKey ?? null,
      };

      span.setStatus({ code: SpanStatusCode.OK });
      return dto;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
