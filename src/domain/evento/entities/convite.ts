import type { FonteConvite } from '../value-objects/fonte-convite.js';
import type { IdConvite, IdEvento } from '../value-objects/ids.js';
import type { ImagemUrlConvite } from '../value-objects/imagem-url-convite.js';
import type { MensagemConvite } from '../value-objects/mensagem-convite.js';
import type { ModeloConvite } from '../value-objects/modelo-convite.js';
import type { NomeExibidoConvite } from '../value-objects/nome-exibido-convite.js';
import type { PaletaConvite } from '../value-objects/paleta-convite.js';

/**
 * @aggregateRoot Convite (BC Evento)
 *
 * Supporting subdomain: personalized invite content and presentation for a
 * single event. The event details themselves remain in the Evento aggregate.
 *
 * Persisted via: `ConviteRepository`.
 */
export interface Convite {
  readonly id: IdConvite;
  readonly idEvento: IdEvento;
  readonly nomeExibido: NomeExibidoConvite;
  readonly mensagem: MensagemConvite;
  readonly paleta: PaletaConvite;
  readonly fonte: FonteConvite;
  readonly modelo: ModeloConvite;
  readonly imagemUrl?: ImagemUrlConvite;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CriarConviteInput {
  readonly id: IdConvite;
  readonly idEvento: IdEvento;
  readonly nomeExibido: NomeExibidoConvite;
  readonly mensagem: MensagemConvite;
  readonly paleta: PaletaConvite;
  readonly fonte: FonteConvite;
  readonly modelo: ModeloConvite;
  readonly imagemUrl?: ImagemUrlConvite;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export function criarConvite(input: CriarConviteInput): Convite {
  return {
    id: input.id,
    idEvento: input.idEvento,
    nomeExibido: input.nomeExibido,
    mensagem: input.mensagem,
    paleta: input.paleta,
    fonte: input.fonte,
    modelo: input.modelo,
    ...(input.imagemUrl === undefined ? {} : { imagemUrl: input.imagemUrl }),
    criadoEm: input.criadoEm,
    atualizadoEm: input.atualizadoEm,
  };
}

export interface AtualizarConviteCampos {
  readonly nomeExibido: NomeExibidoConvite;
  readonly mensagem: MensagemConvite;
  readonly paleta: PaletaConvite;
  readonly fonte: FonteConvite;
  readonly modelo: ModeloConvite;
  readonly imagemUrl?: ImagemUrlConvite;
}

export function conviteComCamposAtualizados(
  convite: Convite,
  campos: AtualizarConviteCampos,
  atualizadoEm: Date,
): Convite {
  const imagemUrlAtualizada =
    campos.imagemUrl === undefined
      ? { ...(convite.imagemUrl === undefined ? {} : { imagemUrl: convite.imagemUrl }) }
      : { imagemUrl: campos.imagemUrl };

  return {
    ...convite,
    nomeExibido: campos.nomeExibido,
    mensagem: campos.mensagem,
    paleta: campos.paleta,
    fonte: campos.fonte,
    modelo: campos.modelo,
    ...imagemUrlAtualizada,
    atualizadoEm,
  };
}
