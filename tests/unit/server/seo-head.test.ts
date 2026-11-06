/**
 * aperture-4nnys — SSR <head> SEO/branding. Google showed "eunenem · /" with a
 * generic globe: the title was the raw pathname and no icons/site name existed.
 * seoHead() is the pure per-route head that server.tsx interpolates.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../../apps/eunenem-server/pages/App.js';
import {
  SITE_NAME,
  seoHead,
  seoMetaForRoute,
  WEB_MANIFEST,
} from '../../../apps/eunenem-server/server/seo.js';

const SITE = 'https://eunenem.com';

function head(pathname: string): string {
  return seoHead(resolveRoute(pathname), pathname, SITE);
}

describe('seoMetaForRoute', () => {
  it('landing has the branded pt-BR title and is indexable', () => {
    const meta = seoMetaForRoute(resolveRoute('/'));
    expect(meta.title).toBe('EuNeném · Lista de chá de bebê online');
    expect(meta.description).toMatch(/lista de chá de bebê/i);
    expect(meta.noindex).toBe(false);
  });

  it('never uses the pathname as the title', () => {
    for (const p of [
      '/',
      '/faq',
      '/pagina/maria',
      '/pagina/maria/sucesso',
      '/painel/maria',
      '/admin',
      '/nao-existe-xyz/a/b',
    ]) {
      const { title } = seoMetaForRoute(resolveRoute(p));
      expect(title).toContain(SITE_NAME);
      expect(title).not.toContain(p);
    }
  });

  it('public pages are indexable; private/transactional ones are noindex', () => {
    for (const p of ['/', '/faq', '/taxas-e-prazos', '/termos-de-uso', '/pagina/maria']) {
      expect(seoMetaForRoute(resolveRoute(p)).noindex, p).toBe(false);
    }
    for (const p of [
      '/pagina/maria/sucesso',
      '/painel/maria',
      '/campanhas',
      '/admin',
      '/login',
      '/nao/existe/x',
    ]) {
      expect(seoMetaForRoute(resolveRoute(p)).noindex, p).toBe(true);
    }
  });
});

describe('seoHead', () => {
  it('emits title, description, og/twitter tags, icons and manifest', () => {
    const html = head('/faq');
    expect(html).toContain('<title>Perguntas frequentes · EuNeném</title>');
    expect(html).toContain('<meta name="description" content="');
    expect(html).toContain('<meta property="og:site_name" content="EuNeném" />');
    expect(html).toContain('<meta property="og:title" content="Perguntas frequentes · EuNeném" />');
    expect(html).toContain('<meta property="og:locale" content="pt_BR" />');
    expect(html).toContain('<meta property="og:url" content="https://eunenem.com/faq" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain('<link rel="canonical" href="https://eunenem.com/faq" />');
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
    expect(html).not.toContain('noindex');
  });

  it('landing carries WebSite JSON-LD naming the site EuNeném', () => {
    const html = head('/');
    const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
    expect(match).not.toBeNull();
    const data = JSON.parse(match?.[1] ?? '{}');
    expect(data).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'EuNeném',
      url: 'https://eunenem.com/',
    });
    expect(html).toContain('<link rel="canonical" href="https://eunenem.com/" />');
  });

  it('only the landing carries the WebSite JSON-LD', () => {
    expect(head('/faq')).not.toContain('application/ld+json');
  });

  it('noindex routes say so and omit the canonical', () => {
    const html = head('/painel/maria');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toContain('rel="canonical"');
  });

  it('escapes the path it echoes into attributes', () => {
    const html = head('/pagina/maria"><script>');
    expect(html).not.toContain('"><script>');
  });

  it('drops a trailing slash on the configured site URL', () => {
    expect(seoHead(resolveRoute('/faq'), '/faq', 'https://eunenem.com/')).toContain(
      'href="https://eunenem.com/faq"',
    );
  });
});

describe('gil3l public-list metadata and PNGs', () => {
  it('uses the public baby name in SSR title/description, escaped', () => {
    const html = seoHead(resolveRoute('/pagina/maria'), '/pagina/maria', SITE, {
      nomeBebe: 'Lia & <Lua>',
      creatorName: 'Maria',
    });
    expect(html).toContain('<title>Lista de presentes de Lia &amp; &lt;Lua&gt; · EuNeném</title>');
    expect(html).toContain(
      'content="Presenteie Lia &amp; &lt;Lua&gt; pela lista de chá de bebê no EuNeném. Escolha um mimo e pague com Pix ou cartão."',
    );
    expect(html).not.toContain('<Lua>');
  });
  it('falls back to the public creator name, never the URL slug', () => {
    expect(
      seoHead(resolveRoute('/pagina/private-slug'), '/pagina/private-slug', SITE, {
        nomeBebe: '  ',
        creatorName: 'Maria',
      }),
    ).toContain('<title>Lista de presentes de Maria · EuNeném</title>');
  });
  it('does not personalize private routes or produce an empty name', () => {
    expect(
      seoHead(resolveRoute('/faq'), '/faq', SITE, { nomeBebe: 'Lia', creatorName: 'Maria' }),
    ).not.toContain('Lia');
    expect(
      seoHead(resolveRoute('/pagina/maria'), '/pagina/maria', SITE, {
        nomeBebe: null,
        creatorName: ' ',
      }),
    ).toContain('<title>Lista de presentes · EuNeném</title>');
  });
  for (const size of [48, 96, 192]) {
    it(`links a real ${size}px PNG on public pages and in the manifest`, () => {
      const src = `/favicon-${size}.png`;
      for (const path of ['/', '/faq', '/pagina/maria']) {
        expect(head(path)).toContain(
          `<link rel="icon" href="${src}" type="image/png" sizes="${size}x${size}" />`,
        );
      }
      expect(WEB_MANIFEST.icons).toContainEqual({
        src,
        sizes: `${size}x${size}`,
        type: 'image/png',
      });
      const png = readFileSync(`apps/eunenem-server/public${src}`);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    });
  }
});
