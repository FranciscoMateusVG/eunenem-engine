import { TRPCClientError } from '@trpc/client';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { trpc } from './trpc.js';
import { useCampanhaEscrita } from './campanha-escrita.js';
import { useCampanhaRota } from './campanha-rota.js';
import { painelConvitePreviewHref, painelHref } from './painelRoutes.js';

import type { AppRouter } from '../../server/trpc/router.js';
import type { ConviteState } from './mocks/convite.js';
import type { Template } from './mocks/templates.js';

export {
  conviteStateFromData,
  savePayloadFromConviteState,
  templateFromDomain,
  templateToDomain,
  paletteFromDomain,
  paletteToDomain,
} from './convite-mapper.js';

type RouterInputs = inferRouterInputs<AppRouter>;
type RouterOutputs = inferRouterOutputs<AppRouter>;

export type SaveConviteInput = RouterInputs['eventoConvite']['save'];
export type SaveConviteMutationInput = SaveConviteInput;
export type ConviteQueryData = RouterOutputs['eventoConvite']['get'];
export type ConvitePreviewQueryData = RouterOutputs['eventoConvite']['getPreview'];

export type ConviteUiErrorKind =
  | 'unauthorized'
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'network';

// aperture-z6vks — both convite queries resolve the ROUTE campanha
// internally (useCampanhaRota) so /c/:idCampanha painéis show THAT
// campanha's convite, not the session default. Bare URL → no idCampanha
// → server defaults to oldest (back-compat).
export function useConviteData() {
  const idCampanha = useCampanhaRota();
  return trpc.eventoConvite.get.useQuery(idCampanha ? { idCampanha } : undefined);
}

export function useConvitePreviewData(
  slug: string,
  opts: {
    /**
     * aperture-1yx1n — EXPLICIT campanha override, outranks route context.
     * The RSVP page (/:slug/confirmar-presenca/:idConvidado) has NO campanha
     * in its URL — the right campanha resolves CONVIDADO-FIRST from
     * getParaConfirmar (additive idCampanha field, aphk8 amendment pending);
     * without it the preview renders the OLDEST campanha's convite and the
     * page 404s for any non-oldest guest (Izzy's G3 red).
     */
    idCampanha?: string | null;
    /** Gate the fetch (RSVP waits for the convidado hop — no wrong-campanha flash). */
    enabled?: boolean;
  } = {},
) {
  const idCampanhaRota = useCampanhaRota();
  const idCampanha = opts.idCampanha ?? idCampanhaRota;
  return trpc.eventoConvite.getPreview.useQuery(
    idCampanha ? { slug, idCampanha } : { slug },
    { enabled: opts.enabled ?? true },
  );
}

export function hasSavedConvite(data: ConviteQueryData | null | undefined): boolean {
  return Boolean(data?.evento && data?.convite);
}

export function conviteDestinationHref(
  slug: string,
  data: ConviteQueryData | null | undefined,
  idCampanha?: string,
): string {
  return hasSavedConvite(data)
    ? painelConvitePreviewHref(slug, idCampanha)
    : painelHref(slug, 'convite', idCampanha);
}

// aperture-1kbyx — writes target the ROUTE campanha; bare URL → explicit
// session-default (oldest) id, so the server can require idCampanha.
export function useSalvarConvite() {
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaEscrita();
  const m = trpc.eventoConvite.save.useMutation({
    onSuccess: () => {
      void utils.eventoConvite.get.invalidate();
      void utils.eventoConvite.getPreview.invalidate();
    },
  });

  return {
    ...m,
    mutate: ((input, opts) => m.mutate(idCampanha ? { ...input, idCampanha } : input, opts)) as typeof m.mutate,
    mutateAsync: ((input, opts) => m.mutateAsync(idCampanha ? { ...input, idCampanha } : input, opts)) as typeof m.mutateAsync,
  };
}

export function toConviteUiErrorKind(err: unknown): ConviteUiErrorKind {
  if (err instanceof TRPCClientError) {
    switch (err.data?.code) {
      case 'UNAUTHORIZED':
        return 'unauthorized';
      case 'BAD_REQUEST':
        return 'validation';
      case 'NOT_FOUND':
        return 'not-found';
      case 'CONFLICT':
        return 'conflict';
      default:
        return 'network';
    }
  }

  return 'network';
}

export function conviteErrorMessage(err: unknown): string {
  switch (toConviteUiErrorKind(err)) {
    case 'unauthorized':
      return 'faça login novamente para editar o convite';
    case 'validation':
      return err instanceof Error ? err.message : 'algum campo do convite ficou inválido';
    case 'not-found':
      return 'não consegui reencontrar o convite salvo';
    case 'conflict':
      return 'deu conflito ao salvar o convite, tenta de novo';
    case 'network':
      return 'deu ruim ao falar com o servidor, tenta de novo daqui a pouco';
  }
}

// ── Template selection cascade (aperture-qa2m3 — shared desktop↔mobile) ──────
//
// DESKTOP is the canonical reference. Picking a template sets `bgTemplate`,
// clears any uploaded background (mutually exclusive), and CASCADES the
// template's suggested palette + name font. This logic used to live only in
// the desktop `selectTemplate`; it now lives here so desktop AND mobile apply
// the exact same rules and can never re-diverge. Callers spread the returned
// patch into their `setState`.

/** Field patch for selecting a watercolor template. */
export function templateSelectionPatch(
  tpl: Template,
): Pick<ConviteState, 'bgTemplate' | 'bgUpload' | 'palette' | 'nameFont'> {
  return {
    bgTemplate: tpl.id,
    bgUpload: null,
    palette: tpl.suggestedPalette,
    nameFont: tpl.suggestedNameFont,
  };
}

/** Field patch for the "papel"/scrapbook choice — no template, no upload. */
export function scrapbookSelectionPatch(): Pick<
  ConviteState,
  'bgTemplate' | 'bgUpload'
> {
  return { bgTemplate: 'none', bgUpload: null };
}

/** Field patch for a user-uploaded background image (clears any template). */
export function uploadSelectionPatch(
  dataUrl: string,
): Pick<ConviteState, 'bgTemplate' | 'bgUpload'> {
  return { bgTemplate: 'none', bgUpload: dataUrl };
}
