import { describe, expect, it } from 'vitest';
import { TRPCClientError } from '../../../apps/eunenem-server/node_modules/@trpc/client';
import {
  contribuicaoErrorMessage,
  toContribuicaoError,
} from '../../../apps/eunenem-server/pages/lib/contribuicao.js';

function error(code: string, message: string) {
  return TRPCClientError.from({ error: { code: -32603, message, data: { code } } });
}

describe('gift errors distinguish server rejection from transport failure', () => {
  it('does not describe an HTTP 500 as a connection failure', () => {
    const mapped = toContribuicaoError(error('INTERNAL_SERVER_ERROR', 'database constraint'));
    expect(mapped.kind).toBe('server');
    expect(contribuicaoErrorMessage(mapped)).not.toContain('conexão');
    expect(contribuicaoErrorMessage(mapped)).not.toContain('database');
  });
  it('keeps the approved-payment explanation', () => {
    const mapped = toContribuicaoError(error('BAD_REQUEST', 'contribuicao_locked'));
    expect(mapped.kind).toBe('locked');
    expect(contribuicaoErrorMessage(mapped)).toContain('já foi comprado');
  });
  it('only transport failures get the connection message', () => {
    expect(toContribuicaoError(new Error('Failed to fetch'))).toEqual({ kind: 'network' });
    expect(toContribuicaoError(error('FORBIDDEN', 'permission denied'))).toEqual({
      kind: 'unauthorized',
    });
  });
});
