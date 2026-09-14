import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface LegacyListClient {
  readonly admin: {
    readonly usuarios: {
      readonly legado: {
        readonly listPaginated: {
          mutate(input: {
            readonly query: string;
            readonly cursor: string;
            readonly limit: number;
          }): Promise<unknown>;
        };
      };
    };
  };
}

describe('admin legacy-user installed tRPC client transport', () => {
  it('sends this read-only mutation by POST without input or cursor in the URL', async () => {
    const requireFromServerApp = createRequire(
      new URL('../../../apps/eunenem-server/package.json', import.meta.url),
    );
    const installedClientEntry = requireFromServerApp.resolve('@trpc/client');
    const { createTRPCClient, httpBatchLink } = await import(
      pathToFileURL(installedClientEntry).href
    );
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const client = createTRPCClient({
      links: [
        httpBatchLink({
          url: 'https://app.example.test/api/trpc',
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            requests.push({
              url: request.url,
              method: request.method,
              body: await request.text(),
            });
            return new Response(
              JSON.stringify([
                {
                  result: {
                    data: {
                      json: {
                        items: [],
                        nextCursor: null,
                        totalCount: 0,
                        counts: {
                          somente_legado: 0,
                          conta_2_0: 0,
                          perfil_2_0: 0,
                          evidencia_inconsistente: 0,
                        },
                      },
                    },
                  },
                },
              ]),
              { headers: { 'content-type': 'application/json' } },
            );
          },
        }),
      ],
    }) as LegacyListClient;

    const query = 'customer-email-filter-canary';
    const cursor = 'opaque-cursor-canary';
    await client.admin.usuarios.legado.listPaginated.mutate({ query, cursor, limit: 25 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toContain('/api/trpc/admin.usuarios.legado.listPaginated');
    expect(requests[0]?.url).not.toContain(query);
    expect(requests[0]?.url).not.toContain(encodeURIComponent(query));
    expect(requests[0]?.url).not.toContain(cursor);
    expect(requests[0]?.body).toContain(query);
    expect(requests[0]?.body).toContain(cursor);
  });
});
