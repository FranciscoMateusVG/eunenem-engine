import { describe, expect, it } from 'vitest';
import { sessaoExpirada } from '../../../src/domain/usuario/entities/sessao.js';
import { contaTemPermissao } from '../../../src/domain/usuario/entities/usuario.js';
import { EmailUsuarioSchema } from '../../../src/domain/usuario/value-objects/email-usuario.js';

describe('contaTemPermissao', () => {
  it('returns true when permission is present', () => {
    const conta = {
      id: '00000000-0000-4000-8000-000000000001',
      idUsuario: '00000000-0000-4000-8000-000000000002',
      permissoes: ['campaign:admin'] as const,
      criadaEm: new Date(),
    };
    expect(contaTemPermissao(conta, 'campaign:admin')).toBe(true);
  });

  it('returns false when permission is missing', () => {
    const conta = {
      id: '00000000-0000-4000-8000-000000000001',
      idUsuario: '00000000-0000-4000-8000-000000000002',
      permissoes: [] as readonly 'campaign:admin'[],
      criadaEm: new Date(),
    };
    expect(contaTemPermissao(conta, 'campaign:admin')).toBe(false);
  });
});

describe('sessaoExpirada', () => {
  it('returns false before expiraEm', () => {
    const sessao = {
      token: 'x'.repeat(32),
      idConta: '00000000-0000-4000-8000-000000000001',
      expiraEm: new Date('2026-06-01T00:00:00.000Z'),
    };
    expect(sessaoExpirada(sessao, new Date('2026-05-01T00:00:00.000Z'))).toBe(false);
  });

  it('returns true at or after expiraEm', () => {
    const sessao = {
      token: 'x'.repeat(32),
      idConta: '00000000-0000-4000-8000-000000000001',
      expiraEm: new Date('2026-05-01T00:00:00.000Z'),
    };
    expect(sessaoExpirada(sessao, new Date('2026-05-01T00:00:00.000Z'))).toBe(true);
    expect(sessaoExpirada(sessao, new Date('2026-06-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('EmailUsuarioSchema', () => {
  it('normalizes email to lowercase', () => {
    expect(EmailUsuarioSchema.parse('  Test@Example.COM ')).toBe('test@example.com');
  });
});
