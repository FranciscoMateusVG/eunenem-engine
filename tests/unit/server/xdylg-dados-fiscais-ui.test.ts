import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  csvCadastrosIncompletos,
  TabelaCadastrosIncompletos,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/nota-fiscal/CadastrosIncompletos.js';
import {
  aplicarRespostaCep,
  buscarCep,
  criarBuscaCep,
  DadosFiscaisForm,
  ENDERECO_VAZIO,
  type EnderecoForm,
  enderecoPreenchido,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/DadosFiscaisModal.js';

/**
 * aperture-xdylg — tela de dados fiscais no resgate (ViaCEP com só o CEP,
 * preenchimento manual sempre possível) e lista/CSV de cadastros incompletos
 * para a equipe (sem CPF).
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};
const render = (el: unknown) => renderToStaticMarkup(el).replace(/ /g, ' ');
const nada = () => undefined;

function fetchFalso(resposta: unknown, opts: { ok?: boolean; falha?: boolean } = {}) {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    if (opts.falha) throw new Error('rede fora');
    return { ok: opts.ok ?? true, json: async () => resposta } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('buscarCep (ViaCEP)', () => {
  it('envia só o CEP e mapeia logradouro/bairro/cidade/UF/IBGE', async () => {
    const f = fetchFalso({
      logradouro: 'Avenida Afonso Pena',
      bairro: 'Centro',
      localidade: 'Belo Horizonte',
      uf: 'MG',
      ibge: '3106200',
    });
    expect(await buscarCep('30130-010', f.impl)).toEqual({
      logradouro: 'Avenida Afonso Pena',
      bairro: 'Centro',
      cidade: 'Belo Horizonte',
      uf: 'MG',
      codigoMunicipioIbge: '3106200',
    });
    expect(f.urls).toEqual(['https://viacep.com.br/ws/30130010/json/']);
  });

  it('CEP inexistente, HTTP de erro, rede fora ou CEP incompleto → null (segue manual)', async () => {
    expect(await buscarCep('00000000', fetchFalso({ erro: true }).impl)).toBeNull();
    expect(await buscarCep('30130010', fetchFalso({}, { ok: false }).impl)).toBeNull();
    expect(await buscarCep('30130010', fetchFalso({}, { falha: true }).impl)).toBeNull();
    const f = fetchFalso({});
    expect(await buscarCep('3013', f.impl)).toBeNull();
    expect(f.urls).toEqual([]);
  });

  it('IBGE malformado do ViaCEP não é aproveitado', async () => {
    const r = await buscarCep('30130010', fetchFalso({ uf: 'MG', ibge: '31062' }).impl);
    expect(r?.codigoMunicipioIbge).toBe('');
  });
});

describe('controlador de CEP (respostas fora de ordem, edição durante a busca)', () => {
  function adiada<T>() {
    let resolver!: (v: T) => void;
    const promessa = new Promise<T>((r) => {
      resolver = r;
    });
    return { promessa, resolver };
  }
  const respostaA = {
    logradouro: 'Rua A',
    bairro: 'Bairro A',
    cidade: 'Cidade A',
    uf: 'SP',
    codigoMunicipioIbge: '3550308',
  };
  const respostaB = {
    logradouro: 'Rua B',
    bairro: 'Bairro B',
    cidade: 'Belo Horizonte',
    uf: 'MG',
    codigoMunicipioIbge: '3106200',
  };

  /** Estado do formulário + o `aplicar` que o componente usa (setState com atualizador). */
  function formulario(inicial: EnderecoForm) {
    let atual = inicial;
    return {
      get: () => atual,
      set: (campos: Partial<EnderecoForm>) => {
        atual = { ...atual, ...campos };
      },
      aplicar: (atualizar: (f: EnderecoForm) => EnderecoForm) => {
        atual = atualizar(atual);
      },
    };
  }

  it('CEP A e depois B; B responde primeiro, A atrasado é DESCARTADO', async () => {
    const pendentes = new Map<string, ReturnType<typeof adiada<Partial<EnderecoForm> | null>>>();
    const buscar = (cep: string) => {
      const d = adiada<Partial<EnderecoForm> | null>();
      pendentes.set(cep.replace(/\D/g, ''), d);
      return d.promessa;
    };
    const busca = criarBuscaCep(buscar);
    const f = formulario({ ...ENDERECO_VAZIO, cep: '01001000' });
    const a = busca(f.get(), f.aplicar);
    f.set({ cep: '30130010' });
    const b = busca(f.get(), f.aplicar);
    pendentes.get('30130010')?.resolver(respostaB);
    expect(await b).toBe('aplicada');
    pendentes.get('01001000')?.resolver(respostaA);
    expect(await a).toBe('obsoleta');
    expect(f.get()).toMatchObject({ cep: '30130010', ...respostaB });
  });

  it('resposta chega depois de a pessoa trocar o CEP (sem nova busca): ignorada', async () => {
    let resolver!: (v: Partial<EnderecoForm>) => void;
    const busca = criarBuscaCep(
      () =>
        new Promise((r) => {
          resolver = r;
        }),
    );
    const f = formulario({ ...ENDERECO_VAZIO, cep: '01001000' });
    const p = busca(f.get(), f.aplicar);
    f.set({ cep: '3013' }); // digitando outro CEP, ainda incompleto
    resolver(respostaA);
    await p;
    expect(f.get().logradouro).toBe('');
    expect(f.get().codigoMunicipioIbge).toBe('');
  });

  it('campo editado à mão enquanto a busca corria não é sobrescrito', async () => {
    let resolver!: (v: Partial<EnderecoForm>) => void;
    const busca = criarBuscaCep(
      () =>
        new Promise((r) => {
          resolver = r;
        }),
    );
    const f = formulario({ ...ENDERECO_VAZIO, cep: '30130010' });
    const p = busca(f.get(), f.aplicar);
    f.set({ logradouro: 'Rua digitada à mão' });
    resolver(respostaB);
    expect(await p).toBe('aplicada');
    expect(f.get()).toMatchObject({
      logradouro: 'Rua digitada à mão',
      bairro: 'Bairro B',
      codigoMunicipioIbge: '3106200',
    });
  });

  it('aplicarRespostaCep: vazio do ViaCEP nunca apaga o que existe', () => {
    const atual = { ...ENDERECO_VAZIO, cep: '30130010', bairro: 'Meu bairro' };
    const r = aplicarRespostaCep(
      atual,
      { cep: '30130-010', antes: atual },
      { bairro: '', logradouro: 'Rua B' },
    );
    expect(r).toMatchObject({ bairro: 'Meu bairro', logradouro: 'Rua B' });
  });
});

describe('DadosFiscaisForm', () => {
  const completo = {
    cep: '30130-010',
    logradouro: 'Av. Afonso Pena',
    numero: '1000',
    complemento: '',
    bairro: 'Centro',
    cidade: 'Belo Horizonte',
    uf: 'MG',
    codigoMunicipioIbge: '3106200',
  };

  it('pede todos os campos do endereço; complemento opcional; botão desligado vazio', () => {
    const html = render(
      React.createElement(DadosFiscaisForm, {
        enviando: false,
        erro: null,
        onSalvar: nada,
        onCancelar: nada,
      }),
    );
    for (const r of [
      'CEP',
      'Rua / avenida',
      'Número',
      'Complemento (opcional)',
      'Bairro',
      'Cidade',
      'UF',
      'Código IBGE do município',
    ]) {
      expect(html).toContain(r);
    }
    expect(html).toContain('endereço do titular');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>salvar e continuar<\/button>/);
  });

  it('preenchido: botão ligado; erro do servidor aparece', () => {
    const html = render(
      React.createElement(DadosFiscaisForm, {
        inicial: completo,
        enviando: false,
        erro: 'Código IBGE do município não pertence à UF informada',
        onSalvar: nada,
        onCancelar: nada,
      }),
    );
    expect(html).toMatch(/<button type="submit" class="ex-btn-green">salvar e continuar<\/button>/);
    expect(html).toContain('não pertence à UF');
  });

  it('enderecoPreenchido exige CEP 8 dígitos, UF válida e IBGE 7 dígitos', () => {
    expect(enderecoPreenchido(completo)).toBe(true);
    expect(enderecoPreenchido(ENDERECO_VAZIO)).toBe(false);
    expect(enderecoPreenchido({ ...completo, uf: 'XX' })).toBe(false);
    expect(enderecoPreenchido({ ...completo, codigoMunicipioIbge: '310620' })).toBe(false);
    expect(enderecoPreenchido({ ...completo, cep: '3013001' })).toBe(false);
  });
});

describe('cadastros incompletos (admin)', () => {
  const lista = [
    {
      campanhaId: 'c1',
      campanhaTitulo: 'Chá da Ana, "a melhor"',
      responsaveis: [
        { nome: 'Ana', email: 'ana@exemplo.com' },
        { nome: 'Bia', email: 'bia@exemplo.com' },
      ],
      taxaCents: 12345,
      motivos: ['cpf_invalido', 'sem_endereco'] as const,
    },
    {
      campanhaId: 'c2',
      campanhaTitulo: '=HYPERLINK("x")',
      responsaveis: [],
      taxaCents: 50,
      motivos: ['sem_recebedor'] as const,
    },
  ];

  it('CSV com BOM, cabeçalho, aspas escapadas e fórmula neutralizada', () => {
    const csv = csvCadastrosIncompletos(lista as never);
    expect(
      csv.startsWith('﻿campanha,id_campanha,responsaveis,emails,taxa_reais,pendencias\r\n'),
    ).toBe(true);
    expect(csv).toContain(
      '"Chá da Ana, ""a melhor""",c1,"Ana; Bia","ana@exemplo.com; bia@exemplo.com",123.45,"CPF ausente ou inválido; sem endereço"',
    );
    expect(csv).toContain(`"'=HYPERLINK(""x"")",c2,,,0.50,sem dados de recebimento`);
  });

  it('tabela mostra lista, responsáveis, taxa e o que falta; vazia diz que não há pendência', () => {
    const html = render(
      React.createElement(TabelaCadastrosIncompletos, { lista, onBaixarCsv: nada }),
    );
    expect(html).toContain('2 lista(s) com taxa no mês e cadastro fiscal incompleto.');
    expect(html).toContain('ana@exemplo.com');
    expect(html).toContain('R$ 123,45');
    expect(html).toContain('CPF ausente ou inválido, sem endereço');
    expect(html).toContain('Baixar CSV');
    expect(
      render(React.createElement(TabelaCadastrosIncompletos, { lista: [], onBaixarCsv: nada })),
    ).toContain('Nenhuma lista com taxa neste mês está com cadastro incompleto.');
  });
});
