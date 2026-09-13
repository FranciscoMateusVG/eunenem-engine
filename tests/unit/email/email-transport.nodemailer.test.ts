import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderMagicLinkEmail } from '../../../apps/eunenem-server/server/auth/magic-link-email.js';
import { EmailTransportNodemailer } from '../../../src/adapters/email/email-transport.nodemailer.js';
import { createTestObservability } from '../../helpers/observability.js';

const telemetry = createTestObservability();

afterAll(async () => telemetry.shutdown());

describe('EmailTransportNodemailer telemetry', () => {
  it('does not attach recipient-bearing SMTP exception content to telemetry', async () => {
    telemetry.reset();
    const sentinel = 'sentinel-payer@example.invalid';
    const smtpError = Object.assign(new Error(`RCPT TO <${sentinel}> rejected`), {
      code: 'EENVELOPE',
      stack: `Error: recipient ${sentinel}\n at smtp`,
    });
    const transport = new EmailTransportNodemailer({
      host: 'smtp.example.invalid',
      port: 587,
      user: 'test',
      pass: 'test',
      from: 'sender@example.invalid',
      secure: false,
    });
    const sendMail = vi.fn().mockRejectedValue(smtpError);
    Object.assign(transport as unknown as { transporter: unknown }, {
      transporter: { sendMail },
    });

    await expect(
      transport.enviar({
        to: sentinel,
        subject: 'receipt',
        html: '<p>receipt</p>',
      }),
    ).rejects.toBe(smtpError);

    const serialized = JSON.stringify(
      telemetry.getSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(smtpError.message);
    expect(serialized).not.toContain(smtpError.stack);

    const span = telemetry.getSpans().find((candidate) => candidate.name === 'email.enviar');
    expect(span?.events).toEqual([
      expect.objectContaining({
        name: 'email.send_failed',
        attributes: { 'error.type': 'EENVELOPE' },
      }),
    ]);
  });
});

describe('EmailTransportNodemailer per-auth-message click tracking', () => {
  function captureTransport(host = 'smtp.sendgrid.net') {
    const transport = new EmailTransportNodemailer({
      host,
      port: 587,
      user: 'fictitious-user',
      pass: 'fictitious-password',
      from: 'sender@example.invalid',
      secure: false,
    });
    const sendMail = vi.fn().mockResolvedValue({ accepted: ['recipient@example.invalid'] });
    // Existing mock boundary: no SMTP connect, verify or email delivery.
    Object.assign(transport as unknown as { transporter: unknown }, {
      transporter: { sendMail },
    });
    return { transport, sendMail };
  }

  it.each([
    'smtp.sendgrid.net',
    'SMTP.SENDGRID.NET',
  ])('captures the constant SMTP API override and complete rendered magic link on %s', async (host) => {
    const { transport, sendMail } = captureTransport(host);
    const url =
      'https://staging.eunenem.com/api/auth/magic-link/verify?token=fictitious-token' +
      '&callbackURL=https%3A%2F%2Fstaging.eunenem.com%2F%3Foauth%3D1';
    const message = renderMagicLinkEmail('recipient@example.invalid', url);
    await transport.enviar(message);
    expect(sendMail).toHaveBeenCalledExactlyOnceWith({
      from: 'sender@example.invalid',
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: {
        'X-SMTPAPI': JSON.stringify({
          filters: { clicktrack: { settings: { enable: 0, enable_text: false } } },
        }),
      },
    });
    expect(message.html.match(/href="https:[^"]*&amp;callbackURL=/g)).toHaveLength(2);
    expect(message.text?.split('\n')).toContain(url);
  });

  it.each([undefined, false])('leaves non-auth payload unchanged (opt-out=%s)', async (optOut) => {
    const { transport, sendMail } = captureTransport();
    const message = {
      to: 'recipient@example.invalid',
      subject: 'ordinary receipt',
      html: 'ordinary receipt',
      text: 'ordinary receipt',
      ...(optOut === undefined ? {} : { disableClickTracking: optOut }),
    };
    await transport.enviar(message);
    expect(sendMail).toHaveBeenCalledExactlyOnceWith({
      from: 'sender@example.invalid',
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  });

  it.each([
    'smtp.example.invalid',
    'smtp.sendgrid.net.example.invalid',
    'proxy.sendgrid.net',
  ])('fails before SMTP send when the required policy is unsupported on %s', async (host) => {
    const { transport, sendMail } = captureTransport(host);
    await expect(
      transport.enviar(
        renderMagicLinkEmail(
          'recipient@example.invalid',
          'https://staging.eunenem.com/api/auth/magic-link/verify?token=fictitious&callbackURL=%2F',
        ),
      ),
    ).rejects.toThrow('Email click-tracking policy unsupported by this SMTP host');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('does not retain the authentication override for the next ordinary message', async () => {
    const { transport, sendMail } = captureTransport();
    await transport.enviar(
      renderMagicLinkEmail(
        'recipient@example.invalid',
        'https://staging.eunenem.com/api/auth/magic-link/verify?token=fictitious&callbackURL=%2F',
      ),
    );
    const ordinary = { to: 'recipient@example.invalid', subject: 'receipt', html: 'receipt' };
    await transport.enviar(ordinary);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail).toHaveBeenNthCalledWith(2, { from: 'sender@example.invalid', ...ordinary });
  });

  it('keeps generic SMTP usable for messages without an opt-out requirement', async () => {
    const { transport, sendMail } = captureTransport('smtp.example.invalid');
    await transport.enviar({
      to: 'recipient@example.invalid',
      subject: 'ordinary',
      html: 'ordinary',
    });
    expect(sendMail).toHaveBeenCalledExactlyOnceWith({
      from: 'sender@example.invalid',
      to: 'recipient@example.invalid',
      subject: 'ordinary',
      html: 'ordinary',
    });
  });
});
