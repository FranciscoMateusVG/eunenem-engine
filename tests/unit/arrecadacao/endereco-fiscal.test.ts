import { describe, expect, it } from 'vitest';
import {
  EnderecoFiscalSchema,
  ufDoCodigoIbge,
} from '../../../src/domain/arrecadacao/value-objects/endereco-fiscal.js';

/**
 * aperture-xdylg — endereço fiscal do recebedor (tomador da NFS-e). Limites
 * do leiaute DPS (TCEndereco/endNac): CEP 8 dígitos, cMun IBGE 7 dígitos
 * coerente com a UF, logradouro ≤255, número ≤60, complemento ≤156,
 * bairro ≤60, Latin-1 sem espaço nas pontas.
 */

const valido = {
  cep: '30130-010',
  logradouro: 'Av. Afonso Pena',
  numero: '1000',
  complemento: 'Apto 12',
  bairro: 'Centro',
  cidade: 'Belo Horizonte',
  uf: 'MG',
  codigoMunicipioIbge: '3106200',
};

describe('EnderecoFiscalSchema', () => {
  it('normaliza CEP para dígitos e apara espaços', () => {
    const r = EnderecoFiscalSchema.parse({ ...valido, logradouro: '  Av. Afonso Pena ', uf: 'mg' });
    expect(r).toEqual({ ...valido, cep: '30130010' });
  });

  it('complemento é opcional (vazio vira null)', () => {
    expect(EnderecoFiscalSchema.parse({ ...valido, complemento: '' }).complemento).toBeNull();
    expect(EnderecoFiscalSchema.parse({ ...valido, complemento: null }).complemento).toBeNull();
  });

  it.each([
    ['CEP curto', { cep: '3013001' }],
    ['CEP com letras', { cep: '3013001a' }],
    ['IBGE com 6 dígitos', { codigoMunicipioIbge: '310620' }],
    ['IBGE de outra UF (SP em MG)', { codigoMunicipioIbge: '3550308' }],
    ['UF inexistente', { uf: 'XX' }],
    ['logradouro vazio', { logradouro: '   ' }],
    ['número vazio', { numero: '' }],
    ['bairro vazio', { bairro: '' }],
    ['cidade vazia', { cidade: '' }],
    ['logradouro > 255', { logradouro: 'a'.repeat(256) }],
    ['número > 60', { numero: '1'.repeat(61) }],
    ['bairro > 60', { bairro: 'b'.repeat(61) }],
    ['complemento > 156', { complemento: 'c'.repeat(157) }],
    ['fora do Latin-1', { logradouro: 'Rua 🚀' }],
  ])('recusa: %s', (_nome, patch) => {
    expect(EnderecoFiscalSchema.safeParse({ ...valido, ...patch }).success).toBe(false);
  });

  it('aceita acentos (Latin-1)', () => {
    expect(EnderecoFiscalSchema.safeParse({ ...valido, bairro: 'São João Batista' }).success).toBe(
      true,
    );
  });
});

describe('ufDoCodigoIbge', () => {
  it('mapeia os 2 primeiros dígitos para a UF', () => {
    expect(ufDoCodigoIbge('3106200')).toBe('MG');
    expect(ufDoCodigoIbge('3550308')).toBe('SP');
    expect(ufDoCodigoIbge('5300108')).toBe('DF');
    expect(ufDoCodigoIbge('9900000')).toBeNull();
  });
});
