import type { AssinaturaConvite } from '../value-objects/assinatura-convite.js';
import type { FonteConvite } from '../value-objects/fonte-convite.js';
import type { IdConvite, IdEvento } from '../value-objects/ids.js';
import type { ImagemUrlConvite } from '../value-objects/imagem-url-convite.js';
import type { MensagemConvite } from '../value-objects/mensagem-convite.js';
import type { ModeloConvite } from '../value-objects/modelo-convite.js';
import type { NomeExibidoConvite } from '../value-objects/nome-exibido-convite.js';
import type { PaletaConvite } from '../value-objects/paleta-convite.js';
import type { RemetenteConvite } from '../value-objects/remetente-convite.js';

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
  readonly remetente: RemetenteConvite;
  readonly nomeExibido: NomeExibidoConvite;
  readonly mensagem: MensagemConvite;
  readonly paleta: PaletaConvite;
  readonly fonte: FonteConvite;
  readonly modelo: ModeloConvite;
  readonly imagemUrl?: ImagemUrlConvite;
  // aperture-zy4uo — linha de assinatura editavel do convite; ausente = nao definida.
  readonly assinatura?: AssinaturaConvite;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CriarConviteInput {
  readonly id: IdConvite;
  readonly idEvento: IdEvento;
  readonly remetente: RemetenteConvite;
  readonly nomeExibido: NomeExibidoConvite;
  readonly mensagem: MensagemConvite;
  readonly paleta: PaletaConvite;
  readonly fonte: FonteConvite;
  readonly modelo: ModeloConvite;
  readonly imagemUrl?: ImagemUrlConvite;
  readonly assinatura?: AssinaturaConvite;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export function criarConvite(input: CriarConviteInput): Convite {
  return {
    id: input.id,
    idEvento: input.idEvento,
    remetente: input.remetente,
    nomeExibido: input.nomeExibido,
    mensagem: input.mensagem,
    paleta: input.paleta,
    fonte: input.fonte,
    modelo: input.modelo,
    ...(input.imagemUrl === undefined ? {} : { imagemUrl: input.imagemUrl }),
    ...(input.assinatura === undefined ? {} : { assinatura: input.assinatura }),
    criadoEm: input.criadoEm,
    atualizadoEm: input.atualizadoEm,
  };
}

export interface AtualizarConviteCampos {
  readonly remetente: RemetenteConvite;
  readonly nomeExibido: NomeExibidoConvite;
  readonly mensagem: MensagemConvite;
  readonly paleta: PaletaConvite;
  readonly fonte: FonteConvite;
  readonly modelo: ModeloConvite;
  readonly imagemUrl?: ImagemUrlConvite;
  // aperture-zy4uo — tri-state: undefined = mantem a assinatura atual,
  // null = limpa (usuario apagou a assinatura), string = define.
  readonly assinatura?: AssinaturaConvite | null;
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

  // aperture-zy4uo — undefined mantem, null limpa, string define. O convite e
  // desestruturado (em vez de espalhado direto) para que "limpar" realmente
  // remova a chave `assinatura` do snapshot resultante.
  const { assinatura: assinaturaAnterior, ...conviteSemAssinatura } = convite;
  const assinaturaAtualizada =
    campos.assinatura === undefined
      ? { ...(assinaturaAnterior === undefined ? {} : { assinatura: assinaturaAnterior }) }
      : campos.assinatura === null
        ? {}
        : { assinatura: campos.assinatura };

  return {
    ...conviteSemAssinatura,
    remetente: campos.remetente,
    nomeExibido: campos.nomeExibido,
    mensagem: campos.mensagem,
    paleta: campos.paleta,
    fonte: campos.fonte,
    modelo: campos.modelo,
    ...imagemUrlAtualizada,
    ...assinaturaAtualizada,
    atualizadoEm,
  };
}
