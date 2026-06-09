import { describe, expect, it } from 'vitest';
import {
  conviteComCamposAtualizados,
  criarConvite,
} from '../../../src/domain/evento/entities/convite.js';
import { FonteConviteSchema } from '../../../src/domain/evento/value-objects/fonte-convite.js';
import { ImagemUrlConviteSchema } from '../../../src/domain/evento/value-objects/imagem-url-convite.js';
import { MensagemConviteSchema } from '../../../src/domain/evento/value-objects/mensagem-convite.js';
import { ModeloConviteSchema } from '../../../src/domain/evento/value-objects/modelo-convite.js';
import { NomeExibidoConviteSchema } from '../../../src/domain/evento/value-objects/nome-exibido-convite.js';
import { PaletaConviteSchema } from '../../../src/domain/evento/value-objects/paleta-convite.js';

const fixedDate = new Date('2026-06-15T18:00:00.000Z');
const idConvite = '11111111-1111-4111-8111-111111111111';
const idEvento = '22222222-2222-4222-8222-222222222222';

describe('criarConvite (dominio)', () => {
  it('creates an invite snapshot', () => {
    const convite = criarConvite({
      id: idConvite,
      idEvento,
      nomeExibido: 'Maria Helena',
      mensagem: 'Vem celebrar esse momento com a gente.',
      paleta: 'lilas',
      fonte: 'patrick',
      modelo: 'scrapbook',
      imagemUrl: 'https://cdn.example.com/convites/maria-helena.png',
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });

    expect(convite.id).toBe(idConvite);
    expect(convite.idEvento).toBe(idEvento);
    expect(convite.nomeExibido).toBe('Maria Helena');
    expect(convite.paleta).toBe('lilas');
    expect(convite.modelo).toBe('scrapbook');
    expect(convite.imagemUrl).toBe('https://cdn.example.com/convites/maria-helena.png');
  });
});

describe('convite factories', () => {
  it('conviteComCamposAtualizados replaces mutable fields', () => {
    const base = criarConvite({
      id: idConvite,
      idEvento,
      nomeExibido: 'Maria Helena',
      mensagem: 'Mensagem original',
      paleta: 'lilas',
      fonte: 'patrick',
      modelo: 'scrapbook',
      imagemUrl: 'https://cdn.example.com/convites/original.jpg',
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });
    const later = new Date('2026-06-16T10:00:00.000Z');

    const updated = conviteComCamposAtualizados(
      base,
      {
        nomeExibido: 'Theo',
        mensagem: 'Nova mensagem do convite',
        paleta: 'surpresa',
        fonte: 'caveat',
        modelo: 'safari',
        imagemUrl: 'https://cdn.example.com/convites/theo.png',
      },
      later,
    );

    expect(updated.nomeExibido).toBe('Theo');
    expect(updated.mensagem).toBe('Nova mensagem do convite');
    expect(updated.paleta).toBe('surpresa');
    expect(updated.fonte).toBe('caveat');
    expect(updated.modelo).toBe('safari');
    expect(updated.imagemUrl).toBe('https://cdn.example.com/convites/theo.png');
    expect(updated.atualizadoEm).toEqual(later);
    expect(updated.criadoEm).toEqual(fixedDate);
  });
});

describe('schemas', () => {
  it('rejects empty nomeExibido', () => {
    expect(NomeExibidoConviteSchema.safeParse('   ').success).toBe(false);
  });

  it('rejects empty mensagem', () => {
    expect(MensagemConviteSchema.safeParse('').success).toBe(false);
  });

  it('rejects invalid paleta', () => {
    expect(PaletaConviteSchema.safeParse('coral').success).toBe(false);
  });

  it('rejects invalid fonte', () => {
    expect(FonteConviteSchema.safeParse('arial').success).toBe(false);
  });

  it('rejects invalid modelo', () => {
    expect(ModeloConviteSchema.safeParse('clean').success).toBe(false);
  });

  it('accepts png/jpg image references', () => {
    expect(
      ImagemUrlConviteSchema.safeParse('https://cdn.example.com/convites/maria.png').success,
    ).toBe(true);
    expect(
      ImagemUrlConviteSchema.safeParse('https://cdn.example.com/maria.jpg?size=lg').success,
    ).toBe(true);
  });

  it('rejects non-url image references', () => {
    expect(ImagemUrlConviteSchema.safeParse('/convites/maria.png').success).toBe(false);
  });

  it('rejects invalid image format', () => {
    expect(
      ImagemUrlConviteSchema.safeParse('https://cdn.example.com/convites/maria.pdf').success,
    ).toBe(false);
  });
});
