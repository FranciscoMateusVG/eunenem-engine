/**
 * aperture-bqvb5 — thank-you email rendered on behalf of the list owner.
 */
import { describe, expect, it } from 'vitest';
import {
  MENSAGEM_AGRADECIMENTO_SUGERIDA,
  personalizarMensagemAgradecimento,
  renderAgradecimentoEmail,
} from '../../../apps/eunenem-server/server/auth/agradecimento-email.js';

const base = {
  para: { nome: 'Ana Souza', email: 'ana@example.com' },
  titular: { nome: 'Helena Martins', email: 'helena@example.com' },
  tituloLista: 'Chá da Maria',
};

describe('personalizarMensagemAgradecimento', () => {
  it('replaces every {nome} with the giver first name', () => {
    expect(personalizarMensagemAgradecimento('Oi, {nome}! {nome} ♡', '  Ana  Souza ')).toBe(
      'Oi, Ana! Ana ♡',
    );
  });

  it('falls back to a neutral greeting when the name is blank', () => {
    expect(personalizarMensagemAgradecimento('Oi, {nome}!', '   ')).toBe('Oi, tudo bem!');
  });

  it('the suggested default greets by first name', () => {
    expect(personalizarMensagemAgradecimento(MENSAGEM_AGRADECIMENTO_SUGERIDA, 'Bia Lima')).toMatch(
      /^Oi, Bia!/,
    );
  });
});

describe('renderAgradecimentoEmail', () => {
  it('addresses the giver, replies to the owner and signs with her name', () => {
    const msg = renderAgradecimentoEmail({ ...base, mensagem: 'Obrigada, {nome}!' });
    expect(msg.to).toBe('ana@example.com');
    expect(msg.replyTo).toBe('helena@example.com');
    expect(msg.subject).toBe('Um agradecimento de Helena Martins ♡');
    expect(msg.text).toContain('Obrigada, Ana!');
    expect(msg.text).toContain('Helena Martins');
    expect(msg.text).toContain('Chá da Maria');
    expect(msg.html).toContain('Obrigada, Ana!');
  });

  it('escapes HTML from the owner message, giver name and list title; keeps line breaks', () => {
    const msg = renderAgradecimentoEmail({
      para: { nome: '<b>Ana</b>', email: 'ana@example.com' },
      titular: { nome: 'Helena "H" & cia', email: 'helena@example.com' },
      tituloLista: '<i>Chá</i>',
      mensagem: 'Linha 1 <script>alert(1)</script>\nLinha 2, {nome}',
    });
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).not.toContain('<b>Ana</b>');
    expect(msg.html).not.toContain('<i>Chá</i>');
    expect(msg.html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;<br>Linha 2, &lt;b&gt;Ana&lt;/b&gt;',
    );
    expect(msg.html).toContain('Helena &quot;H&quot; &amp; cia');
  });

  it('strips CR/LF from header-bound values', () => {
    const msg = renderAgradecimentoEmail({
      ...base,
      titular: { nome: 'Helena\r\nBcc: x@example.com', email: 'helena@example.com' },
      mensagem: 'oi',
    });
    expect(msg.subject).not.toMatch(/[\r\n]/);
  });
});
