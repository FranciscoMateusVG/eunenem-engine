import { AuthServiceMemoria } from '../../../src/adapters/usuario/auth-service.memory.js';
import { describeAuthServiceConformance } from '../../helpers/auth-service.conformance.js';

/**
 * AuthServiceMemoria conformance (aperture-g7f68). Same suite drives
 * the BetterAuth adapter via tests/integration/auth-service.better-auth.postgres.test.ts.
 */
describeAuthServiceConformance('Memory', {
  factory: () => new AuthServiceMemoria(),
});
