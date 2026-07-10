import { TRPCClientError } from '@trpc/client';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from './trpc.js';
import { type SemIdCampanha, useCampanhaEscrita } from './campanha-escrita.js';
import { useCampanhaRota } from './campanha-rota.js';

import type { AppRouter } from '../../server/trpc/router.js';

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type ListaDeConvidadosQueryData = RouterOutputs['eventoListaDeConvidados']['get'];
export type ListaDeConvidadosSnapshot = NonNullable<ListaDeConvidadosQueryData['lista']>;
export type ConvidadoSnapshot = ListaDeConvidadosSnapshot['convidados'][number];
export type StatusPresencaConvidado = ConvidadoSnapshot['presenca'];
export type FormatoMensagemConvite = ListaDeConvidadosSnapshot['formatoMensagemConvite'];

/** Matches the backend default (a lista sem escolha ainda salva assume "texto"). */
export const FORMATO_MENSAGEM_CONVITE_DEFAULT: FormatoMensagemConvite = 'texto';

/** UI-facing guest shape used by ConvidadosBody — `presenca` is the domain
 * source of truth. */
export interface Convidado {
  id: string;
  name: string;
  phone: string;
  presenca: StatusPresencaConvidado;
}

export function convidadoFromSnapshot(c: ConvidadoSnapshot): Convidado {
  return {
    id: c.id,
    name: c.nome,
    phone: c.numeroCelular,
    presenca: c.presenca,
  };
}

export function hasListaDeConvidados(data: ListaDeConvidadosQueryData | undefined): boolean {
  return Boolean(data?.lista && data.lista.convidados.length > 0);
}

/** Label + token color per presence state — single source for badges/filters. */
export const PRESENCA_META: Record<StatusPresencaConvidado, { label: string; color: string }> = {
  nao_enviado: { label: 'não enviada', color: 'var(--ink-mute)' },
  enviado: { label: 'aguardando resposta', color: '#c79b1d' },
  sim: { label: 'confirmado', color: 'var(--green-deep)' },
  talvez: { label: 'talvez', color: '#c79b1d' },
  nao: { label: 'não comparecerá', color: 'var(--coral-pink)' },
};

// aperture-z6vks — resolves the ROUTE campanha internally so /c/:idCampanha
// shows THAT campanha's guest list. Bare URL → no input → server default.
export function useListaDeConvidadosData() {
  const idCampanha = useCampanhaRota();
  return trpc.eventoListaDeConvidados.get.useQuery(idCampanha ? { idCampanha } : undefined);
}

// aperture-1kbyx — writes target the ROUTE campanha; bare URL → explicit
// session-default (oldest) id, so the server can require idCampanha.
export function useAlterarPresencaConvidado() {
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaEscrita();
  const m = trpc.eventoListaDeConvidados.alterarPresenca.useMutation({
    onSuccess: () => {
      void utils.eventoListaDeConvidados.get.invalidate();
    },
  });
  return {
    ...m,
    mutate: ((input, opts) => m.mutate({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutate>,
    mutateAsync: ((input, opts) => m.mutateAsync({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutateAsync>,
  };
}

// aperture-1kbyx — writes target the ROUTE campanha; bare URL → explicit
// session-default (oldest) id, so the server can require idCampanha.
export function useAdicionarConvidado() {
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaEscrita();
  const m = trpc.eventoListaDeConvidados.adicionarConvidado.useMutation({
    onSuccess: () => {
      void utils.eventoListaDeConvidados.get.invalidate();
    },
  });
  return {
    ...m,
    mutate: ((input, opts) => m.mutate({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutate>,
    mutateAsync: ((input, opts) => m.mutateAsync({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutateAsync>,
  };
}

// aperture-1kbyx — writes target the ROUTE campanha; bare URL → explicit
// session-default (oldest) id, so the server can require idCampanha.
export function useSalvarFormatoMensagem() {
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaEscrita();
  const m = trpc.eventoListaDeConvidados.salvarFormatoMensagem.useMutation({
    onSuccess: () => {
      void utils.eventoListaDeConvidados.get.invalidate();
    },
  });
  return {
    ...m,
    mutate: ((input, opts) => m.mutate({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutate>,
    mutateAsync: ((input, opts) => m.mutateAsync({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutateAsync>,
  };
}

export type ConvidadosUiErrorKind = 'unauthorized' | 'validation' | 'not-found' | 'conflict' | 'network';

function toConvidadosUiErrorKind(err: unknown): ConvidadosUiErrorKind {
  if (err instanceof TRPCClientError) {
    switch (err.data?.code) {
      case 'UNAUTHORIZED':
        return 'unauthorized';
      case 'BAD_REQUEST':
      case 'PRECONDITION_FAILED':
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

export function convidadosErrorMessage(err: unknown): string {
  switch (toConvidadosUiErrorKind(err)) {
    case 'unauthorized':
      return 'faça login novamente para editar a lista de convidados';
    case 'validation':
      return err instanceof Error ? err.message : 'algum campo do convidado ficou inválido';
    case 'not-found':
      return 'não consegui reencontrar a lista de convidados salva';
    case 'conflict':
      return 'deu conflito ao salvar, tenta de novo';
    case 'network':
      return 'deu ruim ao falar com o servidor, tenta de novo daqui a pouco';
  }
}
