import nodemailer, { type SendMailOptions } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { renderCampaignInviteEmail } from '../../../apps/eunenem-server/server/auth/campaign-invite-email.js';
import { renderMagicLinkEmail } from '../../../apps/eunenem-server/server/auth/magic-link-email.js';
import { EmailTransportNodemailer } from '../../../src/adapters/email/email-transport.nodemailer.js';

describe('transactional link SMTP MIME policy', () => {
  it('emits the same per-message no-tracking header for invite and magic link, not receipts', async () => {
    const transport = new EmailTransportNodemailer({
      host: 'smtp.sendgrid.net',
      port: 587,
      user: 'synthetic',
      pass: 'synthetic',
      from: 'sender@example.invalid',
      secure: false,
    });
    // Exercise Nodemailer's real MIME serialization without an external send.
    // The recording decorator delegates to a real stream transport, not a mock.
    const mimeTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const messages: string[] = [];
    Object.assign(transport, {
      transporter: {
        sendMail: async (options: SendMailOptions) => {
          const result = await mimeTransport.sendMail(options);
          messages.push(result.message.toString());
          return result;
        },
      },
    });

    const invite = renderCampaignInviteEmail(
      'member@example.invalid',
      'https://staging.eunenem.com',
    );
    const magic = renderMagicLinkEmail(
      'member@example.invalid',
      'https://staging.eunenem.com/api/auth/magic-link/verify?token=synthetic&callbackURL=%2F',
    );
    try {
      await transport.enviar(invite);
      await transport.enviar(magic);
      await transport.enviar({
        to: 'member@example.invalid',
        subject: 'receipt',
        html: '<p>Receipt</p>',
      });

      for (const mime of messages.slice(0, 2)) {
        const unfolded = mime.replace(/\r?\n[ \t]+/g, ' ');
        const header = /^X-SMTPAPI: (.+)$/im.exec(unfolded)?.[1];
        expect(
          header,
          'outbound MIME must disable SendGrid HTML and text click tracking',
        ).toBeDefined();
        // Nodemailer may RFC 2047 Q-encode and fold this structured header.
        const decoded = (header ?? '{}')
          .replace(/\?=\s+=\?/g, '?==?')
          .replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_word, value: string) =>
            value
              .replace(/_/g, ' ')
              .replace(/=([0-9A-F]{2})/gi, (_hex, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
          );
        expect(JSON.parse(decoded)).toEqual({
          filters: { clicktrack: { settings: { enable: 0, enable_text: false } } },
        });
      }
      expect(messages[2]).not.toMatch(/^X-SMTPAPI:/im);
      expect(invite.html).toContain('href="https://staging.eunenem.com/login"');
      expect(invite.text).toContain('https://staging.eunenem.com/login');
    } finally {
      mimeTransport.close();
    }
  });
});
