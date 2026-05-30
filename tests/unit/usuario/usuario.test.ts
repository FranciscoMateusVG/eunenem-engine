import { describe, expect, it } from 'vitest';
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

describe('EmailUsuarioSchema', () => {
  it('normalizes email to lowercase', () => {
    expect(EmailUsuarioSchema.parse('  Test@Example.COM ')).toBe('test@example.com');
  });
});

// `sessaoExpirada` tests removed (aperture-ibbet) — the Sessao entity +
// predicate were deleted; session expiry is now adapter-internal (handled
// by AuthServiceMemoria.validarSessao, which auto-revokes expired tokens).
// Session expiry behavior is covered end-to-end by casos-de-uso.test.ts.
