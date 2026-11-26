import { describe, expect, it } from 'vitest';
import {
  assinarPedidoEvento,
  carregarCertificado,
} from '../../../apps/eunenem-server/server/nfse/assinatura.js';
import { CertificadoNfse } from '../../../apps/eunenem-server/server/nfse/config.js';
import { montarPedidoCancelamento } from '../../../apps/eunenem-server/server/nfse/evento.js';
import { gerarPfxDeTeste } from '../../helpers/nfse-test-pfx.js';
import { validatePedRegEvento } from '../../helpers/nfse-xsd.js';
import { verificarAssinaturaPedidoEvento } from '../../helpers/xmldsig-verify.js';

/**
 * aperture-wp6j6 — pedido de registro do evento de cancelamento (e101101),
 * validado contra pedRegEvento_v1.01.xsd e com a assinatura conferida fora do
 * xml-crypto.
 */

const CHAVE = '31062002112223330001810000000000000000000000000001'.slice(0, 50);
const CNPJ = '11222333000181';

function pedido(overrides: Partial<Parameters<typeof montarPedidoCancelamento>[0]> = {}) {
  return montarPedidoCancelamento({
    tpAmb: '2',
    verAplic: 'eunenem-1',
    dhEvento: '2026-11-26T10:00:00-03:00',
    cnpjAutor: CNPJ,
    chaveAcesso: CHAVE,
    cMotivo: '1',
    xMotivo: 'Erro na emissão: valor incorreto',
    ...overrides,
  });
}

describe('montarPedidoCancelamento', () => {
  it('Id = PRE + chave + 101101 (59 caracteres)', () => {
    const { idPedido } = pedido();
    expect(idPedido).toBe(`PRE${CHAVE}101101`);
    expect(idPedido).toHaveLength(59);
  });

  it('passa no XSD oficial sem assinatura (Signature é opcional no schema)', () => {
    const r = validatePedRegEvento(pedido().xml);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('escapa o motivo digitado pelo admin', () => {
    const { xml } = pedido({ xMotivo: 'Valor <errado> & duplicado "x"' });
    expect(xml).toContain('<xMotivo>Valor &lt;errado&gt; &amp; duplicado &quot;x&quot;</xMotivo>');
    expect(validatePedRegEvento(xml).ok).toBe(true);
  });

  it('motivo curto demais é recusado pelo XSD (o router barra antes)', () => {
    expect(validatePedRegEvento(pedido({ xMotivo: 'curto' }).xml).ok).toBe(false);
  });

  it('assinado: XSD válido e assinatura conferida por libxml2 + OpenSSL', () => {
    const pfx = gerarPfxDeTeste({ cnpj: CNPJ });
    const material = carregarCertificado(new CertificadoNfse('base64', () => pfx.pfx, pfx.senha));
    const { xml, idPedido } = pedido();
    const assinado = assinarPedidoEvento(xml, idPedido, material);
    expect(validatePedRegEvento(assinado).errors).toEqual([]);
    const check = verificarAssinaturaPedidoEvento(assinado);
    expect(check.idReferenciado).toBe(idPedido);
    expect(check.digestConfere).toBe(true);
    expect(check.assinaturaConfere).toBe(true);
    expect(check.certificadoBase64).toBe(pfx.certificadoBase64);
  });
});
