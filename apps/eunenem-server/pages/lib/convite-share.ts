import { painelConvitePreviewHref } from './painelRoutes.js';

export type ConviteShareResult = 'shared' | 'copied' | 'cancelled';
export const CONVITE_SHARE_PRODUCTION_ORIGIN = 'https://eunenem.pocketsoftware.com.br/';
export const CONVITE_SHARE_DEVELOPMENT_ORIGIN = 'http://localhost:3001/';


export function buildConvitePreviewShareUrl(origin: string, slug: string): string {
  return new URL(painelConvitePreviewHref(slug), origin).toString();
}

export function getDefaultConviteShareOrigin(): string {
  const nodeEnv = typeof process !== 'undefined' ? process.env.NODE_ENV : undefined;

  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return CONVITE_SHARE_DEVELOPMENT_ORIGIN;
  }

  return CONVITE_SHARE_PRODUCTION_ORIGIN;
}

export interface ShareConvitePreviewOptions {
  origin?: string;
  slug: string;
  text?: string;
  title?: string;
}

/**
 * Uses the current preview route as the shared destination. This is tied to the
 * temporary preview/bypass flow and will need revisiting when that rollback lands.
 */
export async function shareConvitePreview({
  origin = getDefaultConviteShareOrigin(),
  slug,
  text = 'Quero te mostrar este convite.',
  title = 'Convite',
}: ShareConvitePreviewOptions): Promise<ConviteShareResult> {
  const url = buildConvitePreviewShareUrl(origin, slug);
  const shareData = { title, text, url };

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share(shareData);
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return 'cancelled';
      }
    }
  }

  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(url);
    return 'copied';
  }

  throw new Error('Seu navegador nao suporta compartilhamento nativo nem copia de link.');
}
