import { expect, it } from 'vitest';
import { createPixPollingPolicy } from '../../../apps/eunenem-server/pages/lib/pixPolling.js';

it('polls at 5s, backs off errors to 30s, resets on success and never extends 12min', () => {
  let now = 0;
  const poll = createPixPollingPolicy(() => now);
  expect(poll({ revision: 0 })).toBe(5000);
  expect(poll({ revision: 1, failed: true })).toBe(5000);
  expect(poll({ revision: 1, failed: true })).toBe(5000);
  expect(poll({ revision: 2, failed: true })).toBe(10000);
  expect(poll({ revision: 3, failed: true })).toBe(20000);
  expect(poll({ revision: 4, failed: true })).toBe(30000);
  expect(poll({ revision: 5, failed: true })).toBe(30000);
  expect(poll({ revision: 6, status: 'pendente' })).toBe(5000);
  now = 719000;
  expect(poll({ revision: 7, failed: true })).toBe(1000);
  now = 720000;
  expect(poll({ revision: 8 })).toBe(false);
});
it.each(['confirmado', 'expirado', 'rejeitado'])('stops on terminal %s', (status) => {
  expect(createPixPollingPolicy(() => 0)({ revision: 1, status })).toBe(false);
});
