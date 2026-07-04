import type { FormatoMensagemConvite } from '../value-objects/formato-mensagem-convite.js';
import type { IdConvidado, IdEvento, IdListaDeConvidados } from '../value-objects/ids.js';
import type { LinkConfirmacao } from '../value-objects/link-confirmacao-lista.js';
import type { NomeConvidado } from '../value-objects/nome-convidado.js';
import type { NumeroCelularConvidado } from '../value-objects/numero-celular-convidado.js';
import type { StatusPresencaConvidado } from '../value-objects/status-presenca-convidado.js';

export interface Convidado {
  readonly id: IdConvidado;
  readonly nome: NomeConvidado;
  readonly numeroCelular: NumeroCelularConvidado;
  readonly presenca: StatusPresencaConvidado;
}

/**
 * @aggregateRoot ListaDeConvidados (BC Evento)
 *
 * Supporting subdomain: invitee roster and RSVP management for a single event.
 * Visual invite content remains in Convite; event details remain in Evento.
 *
 * Persisted via: `ListaDeConvidadosRepository`.
 */
export interface ListaDeConvidados {
  readonly id: IdListaDeConvidados;
  readonly idEvento: IdEvento;
  readonly linkConfirmacao: LinkConfirmacao;
  readonly formatoMensagemConvite: FormatoMensagemConvite;
  readonly convidados: readonly Convidado[];
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CriarListaDeConvidadosInput {
  readonly id: IdListaDeConvidados;
  readonly idEvento: IdEvento;
  readonly linkConfirmacao: LinkConfirmacao;
  readonly formatoMensagemConvite: FormatoMensagemConvite;
  readonly convidados: readonly Convidado[];
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export function criarListaDeConvidados(input: CriarListaDeConvidadosInput): ListaDeConvidados {
  return {
    id: input.id,
    idEvento: input.idEvento,
    linkConfirmacao: input.linkConfirmacao,
    formatoMensagemConvite: input.formatoMensagemConvite,
    convidados: [...input.convidados],
    criadoEm: input.criadoEm,
    atualizadoEm: input.atualizadoEm,
  };
}

export interface AtualizarListaDeConvidadosCampos {
  readonly linkConfirmacao: LinkConfirmacao;
  readonly formatoMensagemConvite: FormatoMensagemConvite;
  readonly convidados: readonly Convidado[];
}

export function listaDeConvidadosComCamposAtualizados(
  lista: ListaDeConvidados,
  campos: AtualizarListaDeConvidadosCampos,
  atualizadoEm: Date,
): ListaDeConvidados {
  return {
    ...lista,
    linkConfirmacao: campos.linkConfirmacao,
    formatoMensagemConvite: campos.formatoMensagemConvite,
    convidados: [...campos.convidados],
    atualizadoEm,
  };
}

export function convidadoComPresencaAtualizada(
  convidado: Convidado,
  presenca: StatusPresencaConvidado,
): Convidado {
  return { ...convidado, presenca };
}

export function listaDeConvidadosComPresencaAlterada(
  lista: ListaDeConvidados,
  idConvidado: IdConvidado,
  presenca: StatusPresencaConvidado,
  atualizadoEm: Date,
): ListaDeConvidados {
  return {
    ...lista,
    convidados: lista.convidados.map((convidado) =>
      convidado.id === idConvidado
        ? convidadoComPresencaAtualizada(convidado, presenca)
        : convidado,
    ),
    atualizadoEm,
  };
}
