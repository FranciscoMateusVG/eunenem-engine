import { confirmarPresencaHref } from './painelRoutes.js';

/** Limit is checked post-encodeURIComponent, matching wa.me's practical cap. */
export const WHATSAPP_MESSAGE_MAX_LENGTH = 4000;

export function defaultConviteMessage(nomeConvidado: string, eventTypeLabel: string): string {
  return `Oi, ${nomeConvidado}! Gostaria de convidá-lo(a) para o meu ${eventTypeLabel}. Sua presença é muito importante para nós! Por favor, utilize o link abaixo desta mensagem para confirmar sua presença.`;
}

export function buildConfirmarPresencaShareUrl(
  origin: string,
  slug: string,
  idConvidado: string,
): string {
  return new URL(confirmarPresencaHref(slug, idConvidado), origin).toString();
}

/** Strips everything but digits; rejects numbers too short to be real, and
 * assumes a bare 10-11 digit number is Brazilian (adds the "55" DDI). */
export function formatPhoneForWhatsapp(numeroCelular: string): string | undefined {
  const digits = numeroCelular.replace(/\D/g, '');
  if (digits.length < 10) {
    return undefined;
  }
  if (digits.length <= 11) {
    return `55${digits}`;
  }
  return digits;
}

export function buildWhatsappMessage(userText: string, confirmationUrl: string): string {
  return `${userText}\n\nConfirme sua presença por aqui:\n${confirmationUrl}\n\nResponda com apenas um clique!`;
}

export function buildWaUrl(phone: string | undefined, text: string): string {
  return `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`;
}

export function buildFallbackWhatsappMessage(userText: string): string {
  return `${userText}\n\n(não consegui gerar o link automático de confirmação — combine a presença diretamente por aqui ♡)`;
}

export type WhatsappSendPlan =
  | { kind: 'single'; url: string }
  | { kind: 'split'; firstUrl: string; secondMessage: string };

/** wa.me can only open one message at a time — when the full text (invite +
 * confirmation link) doesn't fit, split into the invite text (opened via
 * wa.me) and a second "confirme sua presença" block the caller copies to the
 * clipboard for the user to paste as a follow-up message. */
export function buildWhatsappSendPlan(
  phone: string | undefined,
  userText: string,
  confirmationUrl: string,
): WhatsappSendPlan {
  const fullMessage = buildWhatsappMessage(userText, confirmationUrl);
  if (encodeURIComponent(fullMessage).length <= WHATSAPP_MESSAGE_MAX_LENGTH) {
    return { kind: 'single', url: buildWaUrl(phone, fullMessage) };
  }

  return {
    kind: 'split',
    firstUrl: buildWaUrl(phone, userText),
    secondMessage: `*CONFIRME SUA PRESENÇA*\n${confirmationUrl}`,
  };
}

/** Opens a wa.me URL via a synthetic <a> click instead of window.open, which
 * some browsers pop-up-block when not called synchronously from the
 * triggering event. */
export function openWhatsappUrl(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
