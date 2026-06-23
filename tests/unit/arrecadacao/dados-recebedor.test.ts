import { describe, expect, it } from 'vitest';
import {
  cnpjValido,
  cpfValido,
  DadosRecebedorSchema,
  telefoneBrValido,
} from '../../../src/domain/arrecadacao/value-objects/dados-recebedor.js';

/**
 * DadosRecebedor discriminated-union VO (aperture-mcvyw): checksum validators
 * + union accept/reject for both pix and conta variants.
 */

const PIX_VALIDO = {
  metodo: 'pix' as const,
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
};

const CONTA_VALIDA = {
  metodo: 'conta' as const,
  nomeTitular: 'Joao Santos',
  cpfTitular: '52998224725', // valid CPF checksum
  celularTitular: '11987654321',
  codigoBanco: '237',
  agencia: '1234',
  agenciaDigito: null,
  conta: '56789',
  contaDigito: '0',
  tipoConta: 'cc' as const,
};

describe('cpfValido', () => {
  it('accepts valid CPFs', () => {
    expect(cpfValido('52998224725')).toBe(true);
    expect(cpfValido('111.444.777-35')).toBe(true); // masked input
  });

  it('rejects bad-checksum and all-same-digit CPFs', () => {
    expect(cpfValido('12345678901')).toBe(false);
    expect(cpfValido('11111111111')).toBe(false);
    expect(cpfValido('00000000000')).toBe(false);
    expect(cpfValido('123')).toBe(false); // wrong length
  });
});

describe('cnpjValido', () => {
  it('accepts a valid CNPJ', () => {
    expect(cnpjValido('11222333000181')).toBe(true);
    expect(cnpjValido('11.222.333/0001-81')).toBe(true); // masked input
  });

  it('rejects bad-checksum and all-same-digit CNPJs', () => {
    expect(cnpjValido('11222333000180')).toBe(false);
    expect(cnpjValido('11111111111111')).toBe(false);
    expect(cnpjValido('123')).toBe(false);
  });
});

describe('telefoneBrValido', () => {
  it('accepts 10–13 digit numbers and rejects others', () => {
    expect(telefoneBrValido('11987654321')).toBe(true);
    expect(telefoneBrValido('5511987654321')).toBe(true);
    expect(telefoneBrValido('123')).toBe(false);
  });
});

describe('DadosRecebedorSchema', () => {
  it('accepts a valid pix variant', () => {
    expect(DadosRecebedorSchema.safeParse(PIX_VALIDO).success).toBe(true);
  });

  it('accepts a valid conta variant', () => {
    expect(DadosRecebedorSchema.safeParse(CONTA_VALIDA).success).toBe(true);
  });

  it('rejects a pix variant with an invalid key for its type', () => {
    const r = DadosRecebedorSchema.safeParse({ ...PIX_VALIDO, chavePix: 'nao-e-email' });
    expect(r.success).toBe(false);
  });

  it('rejects a conta variant with a bad-checksum CPF', () => {
    const r = DadosRecebedorSchema.safeParse({ ...CONTA_VALIDA, cpfTitular: '12345678901' });
    expect(r.success).toBe(false);
  });

  it('rejects a conta variant with an out-of-range phone', () => {
    const r = DadosRecebedorSchema.safeParse({ ...CONTA_VALIDA, celularTitular: '123' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown metodo discriminator', () => {
    const r = DadosRecebedorSchema.safeParse({ ...PIX_VALIDO, metodo: 'boleto' });
    expect(r.success).toBe(false);
  });
});
