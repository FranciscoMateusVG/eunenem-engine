import { describe, expect, it } from 'vitest';
import {
  criarEvento,
  eventoComCamposAtualizados,
  eventoComTipo,
} from '../../../src/domain/evento/entities/evento.js';
import { DataHoraEventoSchema } from '../../../src/domain/evento/value-objects/data-hora-evento.js';
import { EnderecoEventoSchema } from '../../../src/domain/evento/value-objects/endereco-evento.js';
import { ModalidadeEventoSchema } from '../../../src/domain/evento/value-objects/modalidade-evento.js';
import { TipoEventoSchema } from '../../../src/domain/evento/value-objects/tipo-evento.js';

const fixedDate = new Date('2026-06-15T18:00:00.000Z');
const idEvento = '11111111-1111-4111-8111-111111111111';
const idCampanha = '22222222-2222-4222-8222-222222222222';

describe('criarEvento (dominio)', () => {
  it('creates an event snapshot', () => {
    const evento = criarEvento({
      id: idEvento,
      idCampanha,
      tipoEvento: 'cha-bebe',
      modalidade: 'presencial',
      dataHora: fixedDate,
      endereco: 'Rua das Flores, 10',
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });

    expect(evento.id).toBe(idEvento);
    expect(evento.idCampanha).toBe(idCampanha);
    expect(evento.tipoEvento).toBe('cha-bebe');
    expect(evento.modalidade).toBe('presencial');
    expect(evento.endereco).toBe('Rua das Flores, 10');
  });
});

describe('evento factories', () => {
  it('eventoComTipo updates tipo and atualizadoEm', () => {
    const base = criarEvento({
      id: idEvento,
      idCampanha,
      tipoEvento: 'cha-bebe',
      modalidade: 'online',
      dataHora: fixedDate,
      endereco: null,
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });
    const later = new Date('2026-06-16T10:00:00.000Z');
    const updated = eventoComTipo(base, 'aniversario', later);
    expect(updated.tipoEvento).toBe('aniversario');
    expect(updated.atualizadoEm).toEqual(later);
    expect(updated.criadoEm).toEqual(fixedDate);
  });

  it('eventoComCamposAtualizados replaces mutable fields', () => {
    const base = criarEvento({
      id: idEvento,
      idCampanha,
      tipoEvento: 'batizado',
      modalidade: 'presencial',
      dataHora: fixedDate,
      endereco: null,
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });
    const newDataHora = new Date('2026-07-01T12:00:00.000Z');
    const updated = eventoComCamposAtualizados(
      base,
      {
        tipoEvento: 'cha-revelacao',
        modalidade: 'online',
        dataHora: newDataHora,
        endereco: null,
      },
      newDataHora,
    );
    expect(updated.tipoEvento).toBe('cha-revelacao');
    expect(updated.modalidade).toBe('online');
    expect(updated.dataHora).toEqual(newDataHora);
  });
});

describe('schemas', () => {
  it('rejects invalid tipo', () => {
    expect(TipoEventoSchema.safeParse('festa-surpresa').success).toBe(false);
  });

  it('rejects invalid modalidade', () => {
    expect(ModalidadeEventoSchema.safeParse('hibrido').success).toBe(false);
  });

  it('rejects invalid Date for dataHora', () => {
    expect(DataHoraEventoSchema.safeParse(new Date('invalid')).success).toBe(false);
  });

  it('accepts valid endereco', () => {
    expect(EnderecoEventoSchema.safeParse('  Salão Central  ').success).toBe(true);
  });
});
