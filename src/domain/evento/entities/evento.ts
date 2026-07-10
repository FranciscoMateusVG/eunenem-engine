import type { DataHoraEvento } from '../value-objects/data-hora-evento.js';
import type { EnderecoEvento } from '../value-objects/endereco-evento.js';
import type { IdCampanha, IdEvento } from '../value-objects/ids.js';
import type { ModalidadeEvento } from '../value-objects/modalidade-evento.js';
import type { TipoEvento } from '../value-objects/tipo-evento.js';

/**
 * @aggregateRoot Evento (BC Evento)
 *
 * Supporting subdomain: one event per campanha (1:1 via `idCampanha`).
 * Holds when/where/type/modality — not invite copy or guest list (future
 * subdomains Convite and Lista de Convidados under the same BC).
 *
 * aperture-mu1v9 (fblrt W3-c): the aggregate is the SINGLE SOURCE for the
 * event type + date, so it must represent PARTIAL rows seeded by the setup
 * wizard (`upsertEventoParcial`) — `tipoEvento`, `modalidade` and `dataHora`
 * are all nullable at the entity level. The convite save path
 * (`criarEvento`/`atualizarEvento` use-cases) stays STRICT: a publishable
 * convite requires tipoEvento + modalidade non-null (DB permissive, domain
 * strict at the use-case layer).
 *
 * Persisted via: `EventoRepository`.
 *
 */
export interface Evento {
  readonly id: IdEvento;
  readonly idCampanha: IdCampanha;
  readonly tipoEvento: TipoEvento | null;
  readonly modalidade: ModalidadeEvento | null;
  readonly dataHora: DataHoraEvento | null;
  readonly endereco: EnderecoEvento | null;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CriarEventoInput {
  readonly id: IdEvento;
  readonly idCampanha: IdCampanha;
  readonly tipoEvento: TipoEvento | null;
  readonly modalidade: ModalidadeEvento | null;
  readonly dataHora: DataHoraEvento | null;
  readonly endereco: EnderecoEvento | null;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export function criarEvento(input: CriarEventoInput): Evento {
  return {
    id: input.id,
    idCampanha: input.idCampanha,
    tipoEvento: input.tipoEvento,
    modalidade: input.modalidade,
    dataHora: input.dataHora,
    endereco: input.endereco,
    criadoEm: input.criadoEm,
    atualizadoEm: input.atualizadoEm,
  };
}

export function eventoComTipo(
  evento: Evento,
  tipoEvento: TipoEvento | null,
  atualizadoEm: Date,
): Evento {
  return { ...evento, tipoEvento, atualizadoEm };
}

export function eventoComModalidade(
  evento: Evento,
  modalidade: ModalidadeEvento | null,
  atualizadoEm: Date,
): Evento {
  return { ...evento, modalidade, atualizadoEm };
}

export function eventoComDataHora(
  evento: Evento,
  dataHora: DataHoraEvento | null,
  atualizadoEm: Date,
): Evento {
  return { ...evento, dataHora, atualizadoEm };
}

export function eventoComEndereco(
  evento: Evento,
  endereco: EnderecoEvento | null,
  atualizadoEm: Date,
): Evento {
  return { ...evento, endereco, atualizadoEm };
}

export interface AtualizarEventoCampos {
  readonly tipoEvento: TipoEvento | null;
  readonly modalidade: ModalidadeEvento | null;
  readonly dataHora: DataHoraEvento | null;
  readonly endereco: EnderecoEvento | null;
}

/** Replaces mutable fields and bumps `atualizadoEm`. */
export function eventoComCamposAtualizados(
  evento: Evento,
  campos: AtualizarEventoCampos,
  atualizadoEm: Date,
): Evento {
  return {
    ...evento,
    tipoEvento: campos.tipoEvento,
    modalidade: campos.modalidade,
    dataHora: campos.dataHora,
    endereco: campos.endereco,
    atualizadoEm,
  };
}
