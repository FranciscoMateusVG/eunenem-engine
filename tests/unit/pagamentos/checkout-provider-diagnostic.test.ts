import { expect, it } from 'vitest';
import {
  attachCheckoutProviderDiagnostic,
  readCheckoutProviderDiagnostic,
  readPersistedCheckoutProviderDiagnostic,
} from '../../../src/adapters/pagamentos/checkout-provider-diagnostic.js';

it('never copies raw error messages, arbitrary titles/details or credential fields', () => {
  const original = new Error('raw token SECRET');
  expect(readCheckoutProviderDiagnostic(original)).toMatchObject({
    httpStatus: null,
    title: null,
    detail: null,
  });
  const safe = attachCheckoutProviderDiagnostic(new Error('safe'), '/pix/v2/cob/:txid', 500, {
    title: 'Ana da Silva',
    detail: 'Bearer TOKEN; cpf=12345678901; email=a@example.com',
    headers: { authorization: 'SECRET' },
  });
  expect(readCheckoutProviderDiagnostic(safe)).toEqual({
    endpoint: '/pix/v2/cob/:txid',
    httpStatus: 500,
    title: '[redacted]',
    detail: '[redacted]',
  });
  expect(JSON.stringify(readCheckoutProviderDiagnostic(safe))).not.toMatch(
    /Ana|TOKEN|12345678901|example|SECRET/,
  );
  expect(JSON.stringify(safe)).toBe('{}');
});
it('only finite valid HTTP status and generic phrases survive', () => {
  const error = attachCheckoutProviderDiagnostic(new Error('safe'), '/v1/checkout/sessions', 500, {
    title: 'Internal Server Error',
    message: 'Service temporarily unavailable',
  });
  expect(readCheckoutProviderDiagnostic(error)).toMatchObject({
    httpStatus: 500,
    title: 'Internal Server Error',
    detail: 'Service temporarily unavailable',
  });
  expect(
    readCheckoutProviderDiagnostic(
      attachCheckoutProviderDiagnostic(new Error('safe'), 'unknown', '500', { title: [] }),
    ).httpStatus,
  ).toBeNull();
});

it('retains non-JSON responses verbatim but excludes known request auth even if echoed', () => {
  const body = '<html>upstream unavailable</html>\n';
  const e = attachCheckoutProviderDiagnostic(new Error('safe'), '/pix/v2/cob/:txid', 502, body);
  expect(readPersistedCheckoutProviderDiagnostic(e).body).toBe(body);
  const echo = attachCheckoutProviderDiagnostic(
    new Error('safe'),
    '/pix/v2/cob/:txid',
    500,
    '{"detail":"Bearer OUR_TOKEN","title":"Erro interno."}',
    ['OUR_TOKEN'],
  );
  expect(readPersistedCheckoutProviderDiagnostic(echo).detail).toBe('Bearer [our-auth-redacted]');
  expect(JSON.stringify(readPersistedCheckoutProviderDiagnostic(echo))).not.toContain('OUR_TOKEN');
  expect(JSON.stringify(echo)).toBe('{}');
});
