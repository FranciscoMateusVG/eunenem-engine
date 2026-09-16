/**
 * aperture-n1b34 — painel tutorial reopened on every return after
 * CONCLUIR / ENCERRAR. Node-env pins for the fix:
 *
 *   1. `noStoreFetch` — every tRPC request bypasses the HTTP cache (the
 *      reproduced root cause: browser Back answered the batched
 *      `usuario.tutorialStatus` GET from disk cache with the stale
 *      `completado:false` body; reload / re-entry were already correct).
 *   2. `shouldAutoOpenTutorial` — the remount / reload / Back / unsettled /
 *      dismissed / deep-link matrix, and that another account's status is
 *      read from the wire (pure function of the CURRENT status), never a
 *      shared flag.
 *   3. `stripTutorialDeepLink` — `?tutorial=open` dropped after closing.
 *   4. Source-level guards on TrpcProvider / PainelPage wiring: the
 *      mutation result is written to the cache, the mutation never fires
 *      from the mount effect, the wrapper is the link's fetch.
 *
 * The Back-navigation disk-cache behaviour itself is REAL-BROWSER evidence
 * (CDP fromDiskCache on the local fixture run, recorded on the bead + Izzy);
 * these tests pin the logic and wiring, not Chromium's cache policy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { noStoreFetch } from '../../../apps/eunenem-server/pages/lib/trpc-fetch.js';
import {
  shouldAutoOpenTutorial,
  stripTutorialDeepLink,
  tutorialDeepLinkRequested,
} from '../../../apps/eunenem-server/pages/lib/tutorial-gate.js';

const APP = join(__dirname, '../../../apps/eunenem-server');
const src = (rel: string) => readFileSync(join(APP, rel), 'utf8');

describe('n1b34 noStoreFetch — tRPC transport never served from the HTTP cache', () => {
  it('forces cache:"no-store" and preserves method/headers/body/signal', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const controller = new AbortController();
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      signal: controller.signal,
    };
    const res = await noStoreFetch(base)('/api/trpc/usuario.completarTutorial?batch=1', init);
    expect(await res.text()).toBe('ok');
    expect(base).toHaveBeenCalledTimes(1);
    const [url, passed] = base.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/trpc/usuario.completarTutorial?batch=1');
    expect(passed).toMatchObject({ ...init, cache: 'no-store' });
    expect(passed.signal).toBe(controller.signal);
  });

  it('overrides a caller-supplied cache mode (no request can opt back in)', async () => {
    const base = vi.fn(async () => new Response(''));
    await noStoreFetch(base)('/api/trpc/x', { cache: 'force-cache' });
    expect((base.mock.calls[0] as unknown as [string, RequestInit])[1].cache).toBe('no-store');
  });

  it('works with no init at all (plain batched GET)', async () => {
    const base = vi.fn(async () => new Response(''));
    await noStoreFetch(base)('/api/trpc/usuario.tutorialStatus?batch=1&input=%7B%7D');
    expect((base.mock.calls[0] as unknown as [string, RequestInit])[1]).toEqual({
      cache: 'no-store',
    });
  });

  it('resolves the runtime global fetch at call time when no base is given', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => new Response('g'));
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const wrapped = noStoreFetch();
      await wrapped('/api/trpc/y');
      expect(spy).toHaveBeenCalledWith('/api/trpc/y', { cache: 'no-store' });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('n1b34 shouldAutoOpenTutorial — remount / reload / Back / account matrix', () => {
  const base = { dismissedThisSession: false, search: '' };

  it('first eligible visit (server says not completed) → opens', () => {
    expect(shouldAutoOpenTutorial({ ...base, status: { completado: false } })).toBe(true);
  });

  it('server says completed → stays closed on reload / Back / remount', () => {
    expect(shouldAutoOpenTutorial({ ...base, status: { completado: true } })).toBe(false);
  });

  it('status not yet known (query unsettled or errored) → no transient overlay', () => {
    expect(shouldAutoOpenTutorial({ ...base, status: undefined })).toBe(false);
    expect(shouldAutoOpenTutorial({ ...base, status: null })).toBe(false);
  });

  it('dismissed this session outranks a stale completado:false on the wire', () => {
    expect(
      shouldAutoOpenTutorial({
        status: { completado: false },
        dismissedThisSession: true,
        search: '',
      }),
    ).toBe(false);
  });

  it('?tutorial=open replays even when completed, but not after dismissal in-session', () => {
    expect(
      shouldAutoOpenTutorial({
        status: { completado: true },
        dismissedThisSession: false,
        search: '?tutorial=open',
      }),
    ).toBe(true);
    expect(
      shouldAutoOpenTutorial({
        status: { completado: true },
        dismissedThisSession: true,
        search: '?tutorial=open',
      }),
    ).toBe(false);
    expect(tutorialDeepLinkRequested('tutorial=open&x=1')).toBe(true);
    expect(tutorialDeepLinkRequested('?tutorial=closed')).toBe(false);
  });

  it('is a pure function of the CURRENT session status — account B on the same browser gets its own verdict', () => {
    // Same client-side inputs, different server truth per logged-in user.
    const accountA = shouldAutoOpenTutorial({ ...base, status: { completado: true } });
    const accountB = shouldAutoOpenTutorial({ ...base, status: { completado: false } });
    expect(accountA).toBe(false);
    expect(accountB).toBe(true);
  });
});

describe('n1b34 stripTutorialDeepLink', () => {
  it('removes only the tutorial=open param and keeps the rest of the URL', () => {
    expect(stripTutorialDeepLink('https://eunenem.com/painel/mari?tutorial=open')).toBe(
      '/painel/mari',
    );
    expect(stripTutorialDeepLink('https://eunenem.com/painel/mari?a=1&tutorial=open&b=2#top')).toBe(
      '/painel/mari?a=1&b=2#top',
    );
  });

  it('returns null when there is nothing to strip (caller skips replaceState)', () => {
    expect(stripTutorialDeepLink('https://eunenem.com/painel/mari')).toBeNull();
    expect(stripTutorialDeepLink('https://eunenem.com/painel/mari?tutorial=other')).toBeNull();
  });
});

describe('n1b34 wiring guards (source-level)', () => {
  it('TrpcProvider hands the no-store wrapper to httpBatchLink', () => {
    const provider = src('pages/lib/TrpcProvider.tsx');
    expect(provider).toMatch(/import \{ noStoreFetch \} from '\.\/trpc-fetch\.js'/);
    expect(provider).toMatch(/httpBatchLink\(\{[\s\S]*?fetch: noStoreFetch\(\),[\s\S]*?\}\)/);
  });

  it('PainelPage gates via shouldAutoOpenTutorial and writes the mutation result to the cache', () => {
    const page = src('pages/PainelPage.tsx');
    expect(page).toMatch(/shouldAutoOpenTutorial\(\{\s*status: tutorialStatus\.data,/);
    expect(page).toMatch(
      /onSuccess: \(persisted\) => \{[\s\S]*?tutorialStatus\.setData\(undefined, persisted\)/,
    );
    expect(page).not.toMatch(/tutorialStatus\.refetch\(\)/);
  });

  it('PainelPage never marks the tutorial complete from the mount effect — only from user handlers', () => {
    const page = src('pages/PainelPage.tsx');
    const effect = page.match(
      /useEffect\(\(\) => \{[\s\S]*?\}, \[tutorialStatus\.data, dismissedThisSession\]\);/,
    );
    expect(effect, 'auto-open effect present').not.toBeNull();
    expect(effect?.[0]).not.toMatch(/mutate\(/);
    // Exactly one persistence call site, shared by CONCLUIR and ENCERRAR/Esc.
    expect(page.match(/completarTutorial\.mutate\(\)/g)).toHaveLength(1);
    expect(page).toMatch(/const handleComplete = \(\) => persistTutorialClosed\(\);/);
    expect(page).toMatch(/const handleDismiss = \(\) => persistTutorialClosed\(\);/);
    expect(page).toMatch(/stripTutorialDeepLink\(window\.location\.href\)/);
  });
});
