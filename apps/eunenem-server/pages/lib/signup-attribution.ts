import {
  parseSignupAttribution,
  SIGNUP_ATTRIBUTION_COOKIE,
  SIGNUP_ATTRIBUTION_KEY,
  type SignupAttribution,
} from '../../../../src/domain/usuario/signup-attribution.js';

type Browser = {
  location: Pick<Location, 'search' | 'pathname' | 'protocol'>;
  localStorage: Pick<Storage, 'getItem' | 'setItem'>;
  document: Pick<Document, 'cookie' | 'referrer'>;
};
function fromCookie(cookie: string): SignupAttribution | null {
  try {
    const value = cookie
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${SIGNUP_ATTRIBUTION_COOKIE}=`))
      ?.slice(SIGNUP_ATTRIBUTION_COOKIE.length + 1);
    return parseSignupAttribution(value ? decodeURIComponent(value) : null);
  } catch {
    return null;
  }
}
export function readFirstTouch(b: Browser): SignupAttribution | null {
  try {
    const stored = parseSignupAttribution(b.localStorage.getItem(SIGNUP_ATTRIBUTION_KEY));
    if (stored) return stored;
  } catch {
    /* Storage disabled: cookie fallback. */
  }
  try {
    return fromCookie(b.document.cookie);
  } catch {
    return null;
  }
}
export function captureFirstTouch(b: Browser): SignupAttribution | null {
  let value = readFirstTouch(b);
  if (!value) {
    const params = new URLSearchParams(b.location.search);
    // Auth callback is not an acquisition entry when the original browser state is absent.
    if (params.get('oauth') === '1' || b.location.pathname.startsWith('/api/auth/')) return null;
    const field = (key: string) => bounded(params.get(key) ?? '', 160, 200) || null;
    let referrer: string | null = null;
    try {
      const url = new URL(b.document.referrer);
      if (['http:', 'https:'].includes(url.protocol))
        referrer = bounded(`${url.origin}${url.pathname}`, 400, 500);
    } catch {
      /* No valid HTTP referrer. */
    }
    value = parseSignupAttribution(
      JSON.stringify({
        utm_source: field('utm_source'),
        utm_medium: field('utm_medium'),
        utm_campaign: field('utm_campaign'),
        utm_term: field('utm_term'),
        utm_content: field('utm_content'),
        gclid: field('gclid'),
        gbraid: field('gbraid'),
        wbraid: field('wbraid'),
        referrer,
        landing_path: bounded(b.location.pathname, 400, 500),
        captured_at: new Date().toISOString(),
      }),
    );
  }
  if (!value) return null;
  const serialized = JSON.stringify(value);
  try {
    b.localStorage.setItem(SIGNUP_ATTRIBUTION_KEY, serialized);
  } catch {
    /* Best effort, no signup dependency. */
  }
  // Host-only, no broad Domain. Lax survives the top-level OAuth/magic-link return.
  // Bound the encoded cookie below the browser limit, including multi-byte input.
  const encoded = encodeURIComponent(serialized);
  try {
    if (encoded.length < 3600)
      b.document.cookie = `${SIGNUP_ATTRIBUTION_COOKIE}=${encoded}; Path=/; Max-Age=31536000; SameSite=Lax${b.location.protocol === 'https:' ? '; Secure' : ''}`;
  } catch {
    /* Cookies blocked: local storage still preserves first touch. */
  }
  return value;
}

function bounded(value: string, chars: number, encodedBytes: number): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)) continue;
    if ((result + char).length > chars || encodeURIComponent(result + char).length > encodedBytes)
      break;
    result += char;
  }
  return result;
}
