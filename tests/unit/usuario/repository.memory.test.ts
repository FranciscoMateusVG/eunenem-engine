import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { describeUsuarioRepositoryConformance } from '../../helpers/usuario-repository.conformance.js';

/**
 * Memory adapter conformance (aperture-xyhjr — replaces the standalone
 * file from aperture-ibbet). The actual test cases live in the shared
 * conformance suite so memory + postgres adapters are verified against
 * exactly the same expectations.
 */
describeUsuarioRepositoryConformance('Memory', {
  factory: () => new UsuarioRepositoryMemory(),
});
