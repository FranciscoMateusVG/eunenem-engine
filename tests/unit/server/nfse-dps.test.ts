import { describe, expect, it } from 'vitest';
import {
  competenciaDoMes,
  type DpsInput,
  dhEmiSaoPaulo,
  escaparXml,
  formatarValorDps,
  montarDpsXml,
  montarIdDps,
  numeroDpsPrevia,
  SERIE_DPS_PREVIA,
} from '../../../apps/eunenem-server/server/nfse/dps.js';

/**
 * aperture-dh1k7 — builder da DPS (leiaute SN NFS-e v1.01), lógica pura.
 * Validação contra o XSD oficial e assinatura real ficam nos testes de
 * fronteira do nfse-tester.
 */

function input(overrides: Partial<DpsInput> = {}): DpsInput {
  return {
    tpAmb: '2',
    dhEmi: '2026-10-05T14:30:00-03:00',
    verAplic: 'eunenem-previa-1',
    serie: SERIE_DPS_PREVIA,
    nDPS: numeroDpsPrevia('2026-09'),
    dCompet: '2026-09-01',
    cLocEmi: '2611606',
    prestador: {
      cnpj: '12345678000195',
      inscricaoMunicipal: null,
      opSimpNac: '1',
      regApTribSN: null,
      regEspTrib: '0',
    },
    servico: {
      cLocPrestacao: '2611606',
      cTribNac: '100501',
      xDescServ: 'Comissão de intermediação - setembro/2026',
      cNBS: null,
    },
    valores: {
      vServCents: 123456,
      tribISSQN: '1',
      tpRetISSQN: '1',
      pAliq: null,
      totTrib: { tipo: 'indicador' },
    },
    ...overrides,
  };
}

describe('formatarValorDps', () => {
  it.each([
    [1, '0.01'],
    [5, '0.05'],
    [99, '0.99'],
    [100, '1.00'],
    [123456, '1234.56'],
    [100000000, '1000000.00'],
  ])('%i centavos → %s', (cents, esperado) => {
    expect(formatarValorDps(cents)).toBe(esperado);
  });

  it('casa o pattern TSDec15V2 do XSD', () => {
    const pattern = /^(0|0\.[0-9]{2}|[1-9]{1}[0-9]{0,14}(\.[0-9]{2})?)$/;
    for (const cents of [1, 10, 99, 100, 101, 999999, 123456789012]) {
      expect(formatarValorDps(cents)).toMatch(pattern);
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])('recusa %s (DPS só leva valor positivo inteiro em centavos)', (cents) => {
    expect(() => formatarValorDps(cents)).toThrow('nfse_valor_invalido');
  });
});

describe('competenciaDoMes', () => {
  it('mês comum: [dia 1, dia 1 do mês seguinte) em datas locais', () => {
    expect(competenciaDoMes('2026-09')).toEqual({
      mes: '2026-09',
      de: '2026-09-01',
      ate: '2026-10-01',
      ultimoDia: '2026-09-30',
      rotulo: 'setembro/2026',
    });
  });

  it('dezembro vira o ano', () => {
    expect(competenciaDoMes('2026-12')).toMatchObject({
      de: '2026-12-01',
      ate: '2027-01-01',
      ultimoDia: '2026-12-31',
      rotulo: 'dezembro/2026',
    });
  });

  it('fevereiro bissexto e não bissexto', () => {
    expect(competenciaDoMes('2028-02').ultimoDia).toBe('2028-02-29');
    expect(competenciaDoMes('2027-02').ultimoDia).toBe('2027-02-28');
  });

  it.each([
    '2026-13',
    '2026-00',
    '2026-9',
    '26-09',
    '2026-09-01',
    '',
    '1999-01',
  ])('recusa %j', (mes) => {
    expect(() => competenciaDoMes(mes)).toThrow('nfse_mes_invalido');
  });
});

describe('numeroDpsPrevia / série de prévia', () => {
  it('série 99999 e número AAAAMM99999999 (casa TSNumDPS, nunca colide com série real 00001)', () => {
    expect(SERIE_DPS_PREVIA).toBe('99999');
    expect(numeroDpsPrevia('2026-09')).toBe('20260999999999');
    expect(numeroDpsPrevia('2026-09')).toMatch(/^[1-9][0-9]{0,14}$/);
  });
});

describe('montarIdDps', () => {
  it('"DPS" + município(7) + tipo(1, 2 = CNPJ) + CNPJ(14) + série(5) + número(15) = 45', () => {
    const id = montarIdDps({
      cLocEmi: '2611606',
      cnpj: '12345678000195',
      serie: '99999',
      nDPS: '20260999999999',
    });
    expect(id).toBe('DPS2611606212345678000195999990' + '20260999999999');
    expect(id).toHaveLength(45);
    expect(id).toMatch(/^DPS[0-9]{42}$/);
  });

  it('completa série e número com zeros à esquerda', () => {
    const id = montarIdDps({ cLocEmi: '2611606', cnpj: '12345678000195', serie: '1', nDPS: '7' });
    expect(id.slice(-20)).toBe('00001000000000000007');
  });
});

describe('Id da DPS decomposto confere com o XML (Anexo I: tipo 2 = CNPJ, E0004)', () => {
  it('cLocEmi, tipo 2, CNPJ do prest, série e nDPS', () => {
    const { xml, idDps } = montarDpsXml(input());
    const m = /^DPS(\d{7})(\d)(\d{14})(\d{5})(\d{15})$/.exec(idDps);
    if (!m) throw new Error(idDps);
    const [, mun, tipo, inscricao, serie, numero] = m;
    expect(tipo).toBe('2');
    expect(xml).toContain(`<cLocEmi>${mun}</cLocEmi>`);
    expect(xml).toContain(`<prest><CNPJ>${inscricao}</CNPJ>`);
    expect(xml).toContain(`<serie>${Number(serie)}</serie>`);
    expect(xml).toContain(`<nDPS>${Number(numero)}</nDPS>`);
  });
});

describe('dhEmiSaoPaulo', () => {
  it('formata o instante no horário local de São Paulo com offset -03:00', () => {
    expect(dhEmiSaoPaulo(new Date('2026-10-05T17:30:15.999Z'))).toBe('2026-10-05T14:30:15-03:00');
  });

  it('virada de dia em UTC continua no dia local anterior', () => {
    expect(dhEmiSaoPaulo(new Date('2026-10-01T02:00:00Z'))).toBe('2026-09-30T23:00:00-03:00');
  });
});

describe('escaparXml', () => {
  it('escapa os cinco caracteres reservados', () => {
    expect(escaparXml(`a & b < c > d "e" 'f'`)).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;',
    );
  });
});

describe('montarDpsXml', () => {
  it('Id no infDPS (não no DPS), versao 1.01 só no DPS, namespace SN NFS-e', () => {
    const { xml, idDps } = montarDpsXml(input());
    expect(idDps).toMatch(/^DPS[0-9]{42}$/);
    expect(xml).toMatch(
      new RegExp(
        `^<\\?xml version="1.0" encoding="UTF-8"\\?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="${idDps}">`,
      ),
    );
    expect(xml.endsWith('</infDPS></DPS>')).toBe(true);
  });

  it('segue a ordem da sequência TCInfDPS e omite toma/interm/subst', () => {
    const { xml } = montarDpsXml(input());
    const ordem = [
      'tpAmb',
      'dhEmi',
      'verAplic',
      'serie',
      'nDPS',
      'dCompet',
      'tpEmit',
      'cLocEmi',
      'prest',
      'serv',
      'valores',
    ];
    const posicoes = ordem.map((tag) => xml.indexOf(`<${tag}>`));
    expect(posicoes.every((p) => p > 0)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
    expect(xml).not.toContain('<toma>');
    expect(xml).not.toContain('<interm>');
    expect(xml).not.toContain('<subst>');
  });

  it('prestador com CNPJ e regTrib; sem IM quando não configurada', () => {
    const { xml } = montarDpsXml(input());
    expect(xml).toContain(
      '<prest><CNPJ>12345678000195</CNPJ><regTrib><opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>',
    );
  });

  it('IM e regApTribSN entram quando configurados', () => {
    const { xml } = montarDpsXml(
      input({
        prestador: {
          cnpj: '12345678000195',
          inscricaoMunicipal: '123456',
          opSimpNac: '3',
          regApTribSN: '1',
          regEspTrib: '0',
        },
      }),
    );
    expect(xml).toContain(
      '<prest><CNPJ>12345678000195</CNPJ><IM>123456</IM><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>',
    );
  });

  it('serviço: local de prestação, cTribNac de 6 dígitos e descrição escapada', () => {
    const { xml } = montarDpsXml(
      input({
        servico: {
          cLocPrestacao: '2611606',
          cTribNac: '100501',
          xDescServ: 'Comissão <EuNeném> & cia',
          cNBS: null,
        },
      }),
    );
    expect(xml).toContain(
      '<serv><locPrest><cLocPrestacao>2611606</cLocPrestacao></locPrest><cServ><cTribNac>100501</cTribNac><xDescServ>Comissão &lt;EuNeném&gt; &amp; cia</xDescServ></cServ></serv>',
    );
  });

  it('cNBS entra depois de xDescServ quando configurado', () => {
    const { xml } = montarDpsXml(
      input({
        servico: {
          cLocPrestacao: '2611606',
          cTribNac: '100501',
          xDescServ: 'x',
          cNBS: '109051200',
        },
      }),
    );
    expect(xml).toContain('<xDescServ>x</xDescServ><cNBS>109051200</cNBS></cServ>');
  });

  it('valores: vServ formatado, tribMun com tpRetISSQN e totTrib indTotTrib=0', () => {
    const { xml } = montarDpsXml(input());
    expect(xml).toContain(
      '<valores><vServPrest><vServ>1234.56</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores>',
    );
  });

  it('pAliq entra depois de tpRetISSQN quando configurada', () => {
    const { xml } = montarDpsXml(
      input({
        valores: {
          vServCents: 100,
          tribISSQN: '1',
          tpRetISSQN: '1',
          pAliq: '2.00',
          totTrib: { tipo: 'indicador' },
        },
      }),
    );
    expect(xml).toContain('<tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq></tribMun>');
  });

  it('totTrib percentual (não optante, E0713): pTotTrib federal/estadual/municipal', () => {
    const { xml } = montarDpsXml(
      input({
        valores: {
          vServCents: 100,
          tribISSQN: '1',
          tpRetISSQN: '1',
          pAliq: null,
          totTrib: { tipo: 'percentual', fed: '13.45', est: '0.00', mun: '2.00' },
        },
      }),
    );
    expect(xml).toContain(
      '<totTrib><pTotTrib><pTotTribFed>13.45</pTotTribFed><pTotTribEst>0.00</pTotTribEst><pTotTribMun>2.00</pTotTribMun></pTotTrib></totTrib>',
    );
  });

  it('totTrib Simples Nacional (ME/EPP, E0712): pTotTribSN', () => {
    const { xml } = montarDpsXml(
      input({
        valores: {
          vServCents: 100,
          tribISSQN: '1',
          tpRetISSQN: '1',
          pAliq: null,
          totTrib: { tipo: 'simples', pTotTribSN: '6.00' },
        },
      }),
    );
    expect(xml).toContain('<totTrib><pTotTribSN>6.00</pTotTribSN></totTrib>');
  });

  it('cabeçalho: tpEmit=1 (prestador) e cLocEmi', () => {
    const { xml } = montarDpsXml(input());
    expect(xml).toContain(
      '<tpAmb>2</tpAmb><dhEmi>2026-10-05T14:30:00-03:00</dhEmi><verAplic>eunenem-previa-1</verAplic><serie>99999</serie><nDPS>20260999999999</nDPS><dCompet>2026-09-01</dCompet><tpEmit>1</tpEmit><cLocEmi>2611606</cLocEmi>',
    );
  });

  it('é determinístico', () => {
    expect(montarDpsXml(input())).toEqual(montarDpsXml(input()));
  });
});
