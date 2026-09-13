import { describe, expect, it } from 'vitest';
import { renderMagicLinkEmail } from '../../../apps/eunenem-server/server/auth/magic-link-email.js';

// Synthetic bearer token only; never import an email/screenshot or follow a URL.
const MAGIC_URL =
  'https://staging.eunenem.com/api/auth/magic-link/verify?token=fictitious-token-only' +
  '&callbackURL=https%3A%2F%2Fstaging.eunenem.com%2F%3Foauth%3D1%26tab%3Dgift' +
  '&newUserCallbackURL=%2Fwelcome%3Fstep%3D1&errorCallbackURL=%2F%3Ferror%3D1';

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function anchors(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) =>
    decodeHtml(match[1] ?? ''),
  );
}

describe('magic-link email direct URL contract', () => {
  it('keeps the complete input URL in both explicit anchors and the plain-text line', () => {
    const message = renderMagicLinkEmail('recipient@example.invalid', MAGIC_URL);
    expect(anchors(message.html)).toEqual([MAGIC_URL, MAGIC_URL]);
    expect(message.html.match(/<a\b/g)).toHaveLength(2);
    const fallback = message.html.match(/<a\b[^>]*>(https:[^<]*)/);
    expect(decodeHtml(fallback?.[1] ?? '')).toBe(MAGIC_URL);
    expect(message.text?.split('\n').filter((line) => line.startsWith('https:'))).toEqual([
      MAGIC_URL,
    ]);
    expect(message.html).toContain('&amp;callbackURL=');
    expect(message.html).not.toContain('&amp;amp;callbackURL=');
    expect(new URL(anchors(message.html)[1] ?? '').searchParams.get('callbackURL')).toBe(
      'https://staging.eunenem.com/?oauth=1&tab=gift',
    );
    expect(message.disableClickTracking).toBe(true);
  });

  it('escapes quotes, ampersands and markup in href and visible fallback independently', () => {
    const url = `${MAGIC_URL}&note="'><img src=x onerror=alert(1)>&encoded=%26%22%27`;
    const message = renderMagicLinkEmail('recipient@example.invalid', url);
    expect(anchors(message.html)).toEqual([url, url]);
    expect(message.html).not.toContain('<img src=x');
    expect(message.html).toContain('&amp;note=&quot;&#39;&gt;&lt;img');
    const fallback = message.html.match(/<a\b[^>]*>(https:[^<]*)/);
    expect(decodeHtml(fallback?.[1] ?? '')).toBe(url);
    expect(message.text?.split('\n')).toContain(url);
  });

  it('does not replace a server-chosen callback, origin or percent encoding', () => {
    const url =
      'https://eunenem.com/api/auth/magic-link/verify?callbackURL=%2F%3Foauth%3D1' +
      '&token=fictitious%2Btoken%2Fonly&errorCallbackURL=%2Flogin';
    const message = renderMagicLinkEmail('recipient@example.invalid', url);
    expect(anchors(message.html)).toEqual([url, url]);
    expect(message.text?.split('\n')).toContain(url);
    expect(message.html).toContain('https://eunenem.com/public/logo-landing.png');
    expect(message.html).toContain('5 minutos');
    expect(message.html).toContain('só pode ser usado uma vez');
  });
});
