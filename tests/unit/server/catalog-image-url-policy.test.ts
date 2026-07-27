import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isCatalogImageUrlReadable,
  isCatalogImageUrlWritable,
} from '../../../apps/eunenem-server/server/lib/security/catalog-image-url.js';
import {
  isIpLiteralHostname,
  isPrivateOrSpecialIpHostname,
} from '../../../apps/eunenem-server/server/lib/security/network-address.js';
import { ObjectStorageMinio } from '../../../src/adapters/storage/object-storage.minio.js';

const storage = new ObjectStorageMinio({
  endpoint: 'https://storage.eunenem.example',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  bucket: 'catalog-test',
});

const PRODUCT_UUID = '123e4567-e89b-42d3-a456-426614174000';
const MANAGED_KEY = `catalogo/produtos/${PRODUCT_UUID}.webp`;
const MANAGED_URL = storage.urlPublica(MANAGED_KEY);

describe('catalog image URL policy', () => {
  it.each([
    '/products/carrinho.jpg',
    '/listas-prontas/cha-de-bebe.png',
    `/catalogo/produtos/${PRODUCT_UUID}.webp`,
  ])('accepts an owned root-relative catalog path: %s', (url) => {
    expect(isCatalogImageUrlReadable(url, storage)).toBe(true);
    expect(isCatalogImageUrlWritable(url, storage)).toBe(true);
  });

  it('accepts only the exact canonical object-storage URL for a managed catalog key', () => {
    expect(isCatalogImageUrlReadable(MANAGED_URL, storage)).toBe(true);
    expect(isCatalogImageUrlWritable(MANAGED_URL, storage)).toBe(true);

    expect(isCatalogImageUrlReadable(`${MANAGED_URL}?download=1`, storage)).toBe(false);
    expect(isCatalogImageUrlReadable(`${MANAGED_URL}#preview`, storage)).toBe(false);
    expect(
      isCatalogImageUrlReadable(
        `https://storage.eunenem.example/catalog-test/${MANAGED_URL}`,
        storage,
      ),
    ).toBe(false);
    expect(
      isCatalogImageUrlReadable(
        storage.urlPublica(`catalogo/produtos/${PRODUCT_UUID}.gif`),
        storage,
      ),
    ).toBe(false);
  });

  it.each([
    'https://http2.mlstatic.com/D_NQ_NP_123456-MLB99999999999_012026-O.webp',
    'https://rihappy.vteximg.com.br/arquivos/produto.jpg?v=638735414000000000',
  ])('grandfathers the exact legacy vendor URL for reads only: %s', (url) => {
    expect(isCatalogImageUrlReadable(url, storage)).toBe(true);
    expect(isCatalogImageUrlWritable(url, storage)).toBe(false);
  });

  it('keeps every migration-045 backfill image renderable', () => {
    const products = JSON.parse(
      readFileSync(
        new URL('../../../migrations/seed/20260727_045_catalog.json', import.meta.url),
        'utf8',
      ),
    ) as { imageUrl: string }[];

    expect(products).toHaveLength(501);
    expect(
      products.filter((product) => !isCatalogImageUrlReadable(product.imageUrl, storage)),
    ).toEqual([]);
  });

  it.each([
    'https://images.example.com/product.jpg',
    'https://http2.mlstatic.com.evil.example/product.jpg',
    'https://127.0.0.1/product.jpg',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/product.jpg',
    'https://[fc00::1]/product.jpg',
    'https://[fe80::1]/product.jpg',
    'https://user:password@http2.mlstatic.com/product.jpg',
    'https://http2.mlstatic.com/product.jpg#tracking',
    'https://http2.mlstatic.com/product.jpg?tracking=1',
    'https://rihappy.vteximg.com.br/product.jpg',
    'https://rihappy.vteximg.com.br/product.jpg?v=',
    'https://rihappy.vteximg.com.br/product.jpg?v=1&v=2',
    'https://rihappy.vteximg.com.br/product.jpg?utm_source=admin',
    '//http2.mlstatic.com/product.jpg',
    '/products/../secrets.jpg',
    '/products/nested/../../secrets.jpg',
    '/products/%2e%2e/secrets.jpg',
    '/products/nested%2fsecrets.jpg',
    '/products/nested%5csecrets.jpg',
    '/products/product.jpg?tracking=1',
    '/products/product.jpg#tracking',
  ])('rejects a non-owned or mutable image URL: %s', (url) => {
    expect(isCatalogImageUrlReadable(url, storage)).toBe(false);
    expect(isCatalogImageUrlWritable(url, storage)).toBe(false);
  });
});

describe('numeric public-origin address classification', () => {
  it.each([
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.1.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
  ])('classifies private/special IP literal %s', (hostname) => {
    expect(isIpLiteralHostname(hostname)).toBe(true);
    expect(isPrivateOrSpecialIpHostname(hostname)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
  ])('does not misclassify public IP literal %s', (hostname) => {
    expect(isIpLiteralHostname(hostname)).toBe(true);
    expect(isPrivateOrSpecialIpHostname(hostname)).toBe(false);
  });

  it('does not classify DNS names as numeric IP literals', () => {
    expect(isIpLiteralHostname('storage.eunenem.example')).toBe(false);
    expect(isPrivateOrSpecialIpHostname('storage.eunenem.example')).toBe(false);
  });
});
