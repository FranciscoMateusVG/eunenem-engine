import { describe, expect, it } from 'vitest';
import {
  criarListaDeConvidados,
  listaDeConvidadosComCamposAtualizados,
  listaDeConvidadosComPresencaAlterada,
} from '../../../src/domain/evento/entities/lista-de-convidados.js';
import { LinkConfirmacaoSchema } from '../../../src/domain/evento/value-objects/link-confirmacao-lista.js';
import { NomeConvidadoSchema } from '../../../src/domain/evento/value-objects/nome-convidado.js';
import { NumeroCelularConvidadoSchema } from '../../../src/domain/evento/value-objects/numero-celular-convidado.js';
import { StatusPresencaConvidadoSchema } from '../../../src/domain/evento/value-objects/status-presenca-convidado.js';

const fixedDate = new Date('2026-06-15T18:00:00.000Z');
const idLista = '11111111-1111-4111-8111-111111111111';
const idEvento = '22222222-2222-4222-8222-222222222222';
const idConvidado = '33333333-3333-4333-8333-333333333333';

describe('criarListaDeConvidados (dominio)', () => {
  it('creates a guest list snapshot', () => {
    const lista = criarListaDeConvidados({
      id: idLista,
      idEvento,
      linkConfirmacao: 'https://eunenem.app/rsvp/abc123',
      convidados: [
        {
          id: idConvidado,
          nome: 'Mariana',
          numeroCelular: '+55 11 99999-9999',
          presenca: 'talvez',
        },
      ],
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });

    expect(lista.id).toBe(idLista);
    expect(lista.idEvento).toBe(idEvento);
    expect(lista.linkConfirmacao).toBe('https://eunenem.app/rsvp/abc123');
    expect(lista.convidados).toHaveLength(1);
    expect(lista.convidados[0]?.nome).toBe('Mariana');
  });
});

describe('listaDeConvidados factories', () => {
  it('replaces mutable fields', () => {
    const base = criarListaDeConvidados({
      id: idLista,
      idEvento,
      linkConfirmacao: 'https://eunenem.app/rsvp/original',
      convidados: [],
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });
    const later = new Date('2026-06-16T10:00:00.000Z');

    const updated = listaDeConvidadosComCamposAtualizados(
      base,
      {
        linkConfirmacao: 'https://eunenem.app/rsvp/novo',
        convidados: [
          {
            id: idConvidado,
            nome: 'Theo',
            numeroCelular: '+55 11 98888-7777',
            presenca: 'sim',
          },
        ],
      },
      later,
    );

    expect(updated.linkConfirmacao).toBe('https://eunenem.app/rsvp/novo');
    expect(updated.convidados).toHaveLength(1);
    expect(updated.atualizadoEm).toEqual(later);
  });

  it('alters only the guest presence', () => {
    const base = criarListaDeConvidados({
      id: idLista,
      idEvento,
      linkConfirmacao: 'https://eunenem.app/rsvp/base',
      convidados: [
        {
          id: idConvidado,
          nome: 'Mariana',
          numeroCelular: '+55 11 99999-9999',
          presenca: 'talvez',
        },
      ],
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });
    const later = new Date('2026-06-17T10:00:00.000Z');

    const updated = listaDeConvidadosComPresencaAlterada(base, idConvidado, 'sim', later);

    expect(updated.convidados[0]?.presenca).toBe('sim');
    expect(updated.convidados[0]?.nome).toBe('Mariana');
    expect(updated.atualizadoEm).toEqual(later);
  });
});

describe('schemas', () => {
  it('rejects invalid presence status', () => {
    expect(StatusPresencaConvidadoSchema.safeParse('pendente').success).toBe(false);
  });

  it('rejects invalid phone number', () => {
    expect(NumeroCelularConvidadoSchema.safeParse('abc').success).toBe(false);
  });

  it('rejects empty guest name', () => {
    expect(NomeConvidadoSchema.safeParse('   ').success).toBe(false);
  });

  it('accepts valid confirmation link', () => {
    expect(LinkConfirmacaoSchema.safeParse('https://eunenem.app/rsvp/abc123').success).toBe(true);
  });
});
