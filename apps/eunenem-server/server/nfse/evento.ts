import { escaparXml, NFSE_NAMESPACE, type TipoAmbiente } from './dps.js';

/**
 * Pedido de registro do evento de cancelamento da NFS-e (e101101) —
 * pedRegEvento_v1.01.xsd (aperture-wp6j6). Módulo puro.
 *
 * Substitui o esqueleto do nfse-sandbox (que montava um `<evento>` com
 * `infEvento`, leiaute de RETORNO, não de pedido). O Id segue TSIdPedRegEvt:
 * "PRE" + chave de acesso (50) + tipo do evento (6). A assinatura entra depois
 * de `infPedReg`, dentro de `pedRegEvento`.
 */

export const TIPO_EVENTO_CANCELAMENTO = '101101';
export const VERSAO_EVENTO = '1.01';

/** 1 = erro na emissão, 2 = serviço não prestado, 9 = outros. */
export type MotivoCancelamento = '1' | '2' | '9';

export interface PedidoCancelamentoInput {
  readonly tpAmb: TipoAmbiente;
  readonly verAplic: string;
  /** AAAA-MM-DDThh:mm:ss±hh:mm */
  readonly dhEvento: string;
  readonly cnpjAutor: string;
  readonly chaveAcesso: string;
  readonly cMotivo: MotivoCancelamento;
  /** 15 a 255 caracteres (TSMotivo). */
  readonly xMotivo: string;
}

export function montarPedidoCancelamento(input: PedidoCancelamentoInput): { readonly xml: string; readonly idPedido: string } {
  const idPedido = `PRE${input.chaveAcesso}${TIPO_EVENTO_CANCELAMENTO}`;
  const t = (tag: string, valor: string) => `<${tag}>${escaparXml(valor)}</${tag}>`;
  const infPedReg =
    `<infPedReg Id="${idPedido}">` +
    t('tpAmb', input.tpAmb) +
    t('verAplic', input.verAplic) +
    t('dhEvento', input.dhEvento) +
    t('CNPJAutor', input.cnpjAutor) +
    t('chNFSe', input.chaveAcesso) +
    `<e${TIPO_EVENTO_CANCELAMENTO}>` +
    t('xDesc', 'Cancelamento de NFS-e') +
    t('cMotivo', input.cMotivo) +
    t('xMotivo', input.xMotivo) +
    `</e${TIPO_EVENTO_CANCELAMENTO}>` +
    '</infPedReg>';
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="${NFSE_NAMESPACE}" versao="${VERSAO_EVENTO}">${infPedReg}</pedRegEvento>`,
    idPedido,
  };
}
