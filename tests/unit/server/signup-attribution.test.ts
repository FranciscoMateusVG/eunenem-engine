import { expect, it } from 'vitest';
import { captureFirstTouch } from '../../../apps/eunenem-server/pages/lib/signup-attribution.js';

function browser(url: string, referrer = '') {
  const values = new Map<string, string>();
  return {
    location: new URL(url),
    localStorage: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
    },
    document: { referrer, cookie: '' },
  };
}
it('captures any entry and never overwrites the real first touch, even direct', () => {
  const b = browser(
    'https://eunenem.com/faq?utm_source=ads&gclid=abc',
    'https://search.example/search?q=private#token',
  );
  const first = captureFirstTouch(b);
  expect(first).toMatchObject({
    utm_source: 'ads',
    gclid: 'abc',
    landing_path: '/faq',
    referrer: 'https://search.example/search',
  });
  b.location = new URL('https://eunenem.com/?utm_source=other');
  expect(captureFirstTouch(b)).toEqual(first);
  const direct = browser('https://eunenem.com/taxas-e-prazos');
  const initial = captureFirstTouch(direct);
  direct.location = new URL('https://eunenem.com/?utm_source=ads');
  expect(captureFirstTouch(direct)).toEqual(initial);
  expect(initial?.utm_source).toBeNull();
});
it('captures all campaign and click fields, never raw query/hash or unsafe referrers', () => {
  const b = browser(
    'https://eunenem.com/login?utm_source=s&utm_medium=m&utm_campaign=c&utm_term=t&utm_content=x&gclid=g&gbraid=b&wbraid=w&token=secret#secret',
    'javascript:secret',
  );
  expect(captureFirstTouch(b)).toMatchObject({
    utm_source: 's',
    utm_medium: 'm',
    utm_campaign: 'c',
    utm_term: 't',
    utm_content: 'x',
    gclid: 'g',
    gbraid: 'b',
    wbraid: 'w',
    landing_path: '/login',
    referrer: null,
  });
  expect(b.document.cookie).not.toContain('secret');
});
it('survives unavailable storage, bounds Unicode cookies and accepts literal percent UTM', () => {
  const b = browser(
    `https://eunenem.com/faq?utm_campaign=${encodeURIComponent('50% off')}&utm_source=${'😀'.repeat(300)}`,
  );
  b.localStorage.getItem = () => {
    throw new Error('blocked');
  };
  b.localStorage.setItem = () => {
    throw new Error('blocked');
  };
  const first = captureFirstTouch(b);
  expect(first?.utm_campaign).toBe('50% off');
  expect(b.document.cookie.length).toBeLessThan(4000);
  b.location = new URL('https://eunenem.com/?utm_source=overwrite');
  expect(captureFirstTouch(b)).toEqual(first);
});

it('does not invent acquisition from an auth callback without first-touch state', () => {
  expect(
    captureFirstTouch(browser('https://eunenem.com/?oauth=1', 'https://accounts.google.com/')),
  ).toBeNull();
});
