import { TRPCClientError } from '@trpc/client';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { trpc } from './trpc.js';
import { painelConvitePreviewHref, painelHref } from './painelRoutes.js';

import type { AppRouter } from '../../server/trpc/router.js';

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

export function useConviteData() {
  return trpc.eventoConvite.get.useQuery();
}

export function useConvitePreviewData(slug: string) {
  return trpc.eventoConvite.getPreview.useQuery({ slug });
}

export function hasSavedConvite(data: ConviteQueryData | null | undefined): boolean {
  return Boolean(data?.evento && data?.convite);
}

export function conviteDestinationHref(
  slug: string,
  data: ConviteQueryData | null | undefined,
): string {
  return hasSavedConvite(data) ? painelConvitePreviewHref(slug) : painelHref(slug, 'convite');
}

export function useSalvarConvite() {
  const utils = trpc.useUtils();
  const mutation = trpc.eventoConvite.save.useMutation({
    onSuccess: () => {
      void utils.eventoConvite.get.invalidate();
      void utils.eventoConvite.getPreview.invalidate();
    },
  });

  return mutation;
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
