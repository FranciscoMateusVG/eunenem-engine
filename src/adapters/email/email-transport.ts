/**
 * Email transport port (aperture-lwx2k).
 *
 * The single outbound-email seam for the engine. Built ONCE, securely, and
 * SHARED by every email sender: the magic-link sign-in (Camada C), the
 * contribuição thank-you (c0a5s), and future password-reset / email-verify
 * flows. Keeping one port means transport config, retries, and the FROM
 * identity live in exactly one place.
 *
 * Implementations:
 *   - `EmailTransportNodemailer` — real SMTP (prod/staging), reusing the
 *     legacy eunenem SMTP creds via env.
 *   - `EmailTransportNoop` — boot-safe fallback when SMTP env is absent
 *     (dev/CI). Never throws; the magicLink plugin is conditionally-spread
 *     OFF in that posture, so no real send is ever attempted.
 *
 * SECURITY (Cipher token/abuse posture lives at the call sites, not here):
 * this port carries NO per-email logging of address→token or address→status;
 * callers pass already-rendered, already-rate-limited messages. The transport
 * just delivers.
 */
export interface EmailMessage {
  /** Recipient address. Validated/normalized by the caller. */
  readonly to: string;
  readonly subject: string;
  /** Rendered HTML body. */
  readonly html: string;
  /** Optional plain-text alternative (deliverability / no-HTML clients). */
  readonly text?: string;
}

export interface EmailTransport {
  /**
   * Deliver one message. Resolves on accepted-for-delivery; rejects on a
   * hard transport failure so the caller can decide (magic-link send keeps
   * its response UNIFORM regardless, to avoid an account-enumeration oracle).
   */
  enviar(message: EmailMessage): Promise<void>;
}
