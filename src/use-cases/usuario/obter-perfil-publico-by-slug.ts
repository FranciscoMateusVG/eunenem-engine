import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ObjectStorage } from '../../adapters/storage/object-storage.js';
import type { PerfilCriadorRepository } from '../../adapters/usuario/perfil-criador-repository.js';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { IdPlataformaReferencia } from '../../domain/usuario/value-objects/ids.js';
import { GeneroBebeSchema } from '../../domain/usuario/value-objects/genero-bebe.js';
import type { SlugUsuario } from '../../domain/usuario/value-objects/slug-usuario.js';
import { TipoEventoPerfilSchema } from '../../domain/usuario/value-objects/tipo-evento-perfil.js';
import { UsuarioNaoEncontradoError } from '../../errors/usuario/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * PUBLIC profile projection (aperture-cdo69) — the ONLY shape exposed on the
 * unauthenticated `/pagina/<slug>` route.
 *
 * 🔒 PII BOUNDARY: this DTO is the contract that prevents accidental leaks.
 * It carries ONLY display-safe fields. It MUST NEVER include email, idConta,
 * idUsuario, idPlataforma, any banking/Pix data, or any other PII. The router
 * pins it as the procedure `.output(...)` so tRPC strips/rejects anything
 * outside this set, and a dedicated test asserts the payload has no PII keys.
 * Dates are ISO strings (no transformer assumed on the wire).
 */
export const PerfilPublicoDTOSchema = z.object({
  slug: z.string(),
  /** Public display name of the creator (= Usuario.nomeExibicao). */
  creatorName: z.string(),
  nomeBebe: z.string().nullable(),
  relacao: z.string().nullable(),
  historia: z.string().nullable(),
  tipoEvento: TipoEventoPerfilSchema.nullable(),
  genero: GeneroBebeSchema.nullable(),
  dataEvento: z.string().nullable(),
  dataNascimento: z.string().nullable(),
  /**
   * Resolved public photo URLs — DISPLAY ONLY (aperture-qjgfr). No bare-key
   * field on the public surface: the public page never round-trips, and the
   * key embeds idUsuario (kept off the public projection).
   */
  fotoPerfilUrl: z.string().nullable(),
  fotoCapaUrl: z.string().nullable(),
  fotoHistoriaUrl: z.string().nullable(),
});

export type PerfilPublicoDTO = z.infer<typeof PerfilPublicoDTOSchema>;

export interface ObterPerfilPublicoBySlugDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly perfilCriadorRepository: PerfilCriadorRepository;
  /** Resolves stored photo keys → displayable public URLs (aperture-lq8vw). */
  readonly objectStorage: ObjectStorage;
  readonly observability: Observability;
}

/**
 * Resolve a public profile from a URL slug. Mirrors the `pagina-router`
 * tenant-resolution chain: `(idPlataforma, slug)` → Usuario → PerfilCriador.
 * Unknown slug → `UsuarioNaoEncontradoError` (router maps to NOT_FOUND).
 *
 * Pure read. No auth — this is the visitor-facing surface, so the projection
 * is deliberately narrow.
 */
export async function obterPerfilPublicoBySlug(
  deps: ObterPerfilPublicoBySlugDeps,
  idPlataforma: IdPlataformaReferencia,
  slug: SlugUsuario,
): Promise<PerfilPublicoDTO> {
  const { usuarioRepository, perfilCriadorRepository, objectStorage, observability } = deps;
  const { tracer } = observability;
  const fotoUrl = (key: string | null): string | null =>
    key === null ? null : objectStorage.urlPublica(key);

  return tracer.startActiveSpan('obterPerfilPublicoBySlug', async (span) => {
    try {
      span.setAttribute('usuario.slug', slug);
      const usuario = await usuarioRepository.findUsuarioBySlug(idPlataforma, slug);
      if (!usuario) {
        throw new UsuarioNaoEncontradoError(slug);
      }

      const perfil = await perfilCriadorRepository.findByUsuarioId(usuario.id);
      const c = perfil?.conteudo;

      const dto: PerfilPublicoDTO = {
        slug: usuario.slug,
        creatorName: usuario.nomeExibicao,
        nomeBebe: c?.nomeBebe ?? null,
        relacao: c?.relacao ?? null,
        historia: c?.historia ?? null,
        tipoEvento: c?.tipoEvento ?? null,
        genero: c?.genero ?? null,
        dataEvento: c?.dataEvento ? c.dataEvento.toISOString() : null,
        dataNascimento: c?.dataNascimento ? c.dataNascimento.toISOString() : null,
        fotoPerfilUrl: fotoUrl(c?.fotoPerfilKey ?? null),
        fotoCapaUrl: fotoUrl(c?.fotoCapaKey ?? null),
        fotoHistoriaUrl: fotoUrl(c?.fotoHistoriaKey ?? null),
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
