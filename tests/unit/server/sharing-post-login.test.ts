import { expect, it } from 'vitest';
import { postLoginTarget } from '../../../apps/eunenem-server/pages/lib/post-login-route.js';

it('new invited users land directly on the explicit shared campaign, not their own wizard', () => {
  expect(
    postLoginTarget({
      slug: 'convidada',
      onboardingProprioPendente: true,
      idCampanhaCompartilhada: 'shared-id',
    }),
  ).toBe('/painel/convidada/c/shared-id');
});

it('onboarded users retain the campaign chooser even with shared memberships', () => {
  expect(
    postLoginTarget({
      slug: 'convidada',
      onboardingProprioPendente: false,
      idCampanhaCompartilhada: 'shared-id',
    }),
  ).toBe('/campanhas');
});
