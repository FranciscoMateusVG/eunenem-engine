import type { ArrecadacaoRepositoryContext } from '../../adapters/arrecadacao/repository-context.js';

export type ExecutarTransacaoArrecadacao = <T>(
  operation: (context: ArrecadacaoRepositoryContext) => Promise<T>,
) => Promise<T>;

export const executarTransacaoSequencial: ExecutarTransacaoArrecadacao = async (operation) =>
  operation({});
