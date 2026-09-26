import { describe, expect, it } from 'vitest';
import {
  agregarTotaisAdmin,
  BUCKETS_ELEGIVEIS_RECEBIDO,
  classificarBucketAdmin,
  elegivelParaRecebido,
  type FatosLancamentoAdmin,
} from '../../../apps/eunenem-server/server/extrato/classificador-admin.js';

/**
 * aperture-5jk8y — matriz do classificador admin (plano owmqs A1.3, contrato
 * revisado após QA lgcgzk/uj1r5f e decisão root tyc1uv).
 *
 * Grão = linha do ledger `credito_saldo_recebedor`. Precedência EXCLUSIVA,
 * primeira regra vence:
 *   1 transferido ∧ cancelado        → anomalia (fora do recebido)
 *   2 cancelado                      → estornado (fora)
 *   3 pagamento ausente/≠ aprovado   → anomalia (fora)
 *   4 transferido                    → transferido
 *   5 estornoAtivo                   → estorno_em_andamento (vence repasse e available_on)
 *   6 id_repasse por status          → inconsistente | transferencia_falhou | enviado_ao_banco | aguardando_transferencia
 *   7 available_on null | futuro     → aguardando_liberacao
 *   8 disponivelCanonico = false     → inconsistente (guarda canônica)
 *   9 senão                          → disponivel
 */

const NOW = new Date('2026-09-26T12:00:00.000Z');
const PAST = new Date('2026-09-20T12:00:00.000Z');
const FUTURE = new Date('2026-10-02T12:00:00.000Z');

function fatos(overrides: Partial<FatosLancamentoAdmin> = {}): FatosLancamentoAdmin {
  return {
    idLancamento: overrides.idLancamento ?? 'l-1',
    amountCents: 1000,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
    repasseStatus: null,
    pagamentoStatus: 'aprovado',
    availableOn: PAST,
    estornoAtivo: false,
    disponivelCanonico: true,
    ...overrides,
  };
}

describe('elegivelParaRecebido — independente do bucket', () => {
  it('aprovado sem cancelamento é elegível', () => {
    expect(elegivelParaRecebido(fatos())).toBe(true);
  });
  it.each([
    ['pendente', PAST],
    ['processing', PAST],
    ['rejeitado', PAST],
    ['estornado', PAST],
    [null, PAST],
  ] as const)('pagamento %s não é elegível', (pagamentoStatus) => {
    expect(elegivelParaRecebido(fatos({ pagamentoStatus }))).toBe(false);
  });
  it('cancelado_em torna inelegível mesmo aprovado', () => {
    expect(elegivelParaRecebido(fatos({ canceladoEm: PAST }))).toBe(false);
  });
  it('estornoAtivo NÃO remove elegibilidade (dinheiro ainda no ledger)', () => {
    expect(elegivelParaRecebido(fatos({ estornoAtivo: true }))).toBe(true);
  });
});

describe('classificarBucketAdmin — precedência exclusiva A1.3', () => {
  it('1: transferido ∧ cancelado → anomalia transferido_e_cancelado (nunca transferido)', () => {
    const c = classificarBucketAdmin(fatos({ transferidoEm: PAST, canceladoEm: PAST }), NOW);
    expect(c).toEqual({
      bucket: 'anomalia',
      motivo: 'transferido_e_cancelado',
      elegivelRecebido: false,
    });
  });

  it('2: cancelado → estornado (fora do recebido)', () => {
    const c = classificarBucketAdmin(fatos({ canceladoEm: PAST }), NOW);
    expect(c.bucket).toBe('estornado');
    expect(c.elegivelRecebido).toBe(false);
  });

  it('2 vence 5: cancelado com estornoAtivo continua estornado (estorno já efetivado)', () => {
    const c = classificarBucketAdmin(fatos({ canceladoEm: PAST, estornoAtivo: true }), NOW);
    expect(c.bucket).toBe('estornado');
  });

  describe('3: pagamento não aprovado → anomalia, mesmo com carimbos posteriores', () => {
    it.each([
      ['transferido', { transferidoEm: PAST }],
      ['estornoAtivo', { estornoAtivo: true }],
      ['id_repasse solicitado', { idRepasse: 'r-1', repasseStatus: 'solicitado' }],
      ['available_on passado', {}],
    ] as const)('pendente + %s', (_label, extra) => {
      const c = classificarBucketAdmin(fatos({ pagamentoStatus: 'pendente', ...extra }), NOW);
      expect(c).toEqual({
        bucket: 'anomalia',
        motivo: 'pagamento_nao_aprovado',
        elegivelRecebido: false,
      });
    });
    it('pagamento ausente → anomalia pagamento_ausente', () => {
      const c = classificarBucketAdmin(fatos({ pagamentoStatus: null }), NOW);
      expect(c).toEqual({
        bucket: 'anomalia',
        motivo: 'pagamento_ausente',
        elegivelRecebido: false,
      });
    });
  });

  it('4: transferido → transferido, ignora status do repasse (só glosa)', () => {
    const c = classificarBucketAdmin(
      fatos({ transferidoEm: PAST, idRepasse: 'r-1', repasseStatus: 'verificando' }),
      NOW,
    );
    expect(c).toEqual({ bucket: 'transferido', motivo: null, elegivelRecebido: true });
  });

  describe('5: estornoAtivo vence repasse e available_on', () => {
    it.each([
      ['sem repasse, available_on passado', {}],
      ['com repasse solicitado', { idRepasse: 'r-1', repasseStatus: 'solicitado' }],
      ['com repasse falhou', { idRepasse: 'r-1', repasseStatus: 'falhou' }],
      ['com repasse enviado_ao_banco', { idRepasse: 'r-1', repasseStatus: 'enviado_ao_banco' }],
      ['available_on null', { availableOn: null }],
      ['available_on futuro', { availableOn: FUTURE }],
      ['guarda canônica false', { disponivelCanonico: false }],
    ] as const)('%s → estorno_em_andamento', (_label, extra) => {
      const c = classificarBucketAdmin(
        fatos({ estornoAtivo: true, disponivelCanonico: false, ...extra }),
        NOW,
      );
      expect(c).toEqual({
        bucket: 'estorno_em_andamento',
        motivo: null,
        elegivelRecebido: true,
      });
    });
  });

  describe('6: id_repasse por status do repasse', () => {
    it.each([
      ['solicitado', 'aguardando_transferencia', null],
      ['aprovado', 'aguardando_transferencia', null],
      ['transferindo', 'aguardando_transferencia', null],
      ['verificando', 'aguardando_transferencia', null],
      ['enviado_ao_banco', 'enviado_ao_banco', null],
      ['falhou', 'transferencia_falhou', null],
      ['pago', 'inconsistente', 'repasse_pago_sem_transferido'],
      ['cancelado', 'inconsistente', 'repasse_cancelado_com_vinculo'],
      ['status_novo_qualquer', 'inconsistente', 'repasse_status_desconhecido'],
    ] as const)('repasse %s → %s', (repasseStatus, bucket, motivo) => {
      const c = classificarBucketAdmin(
        fatos({ idRepasse: 'r-1', repasseStatus, disponivelCanonico: false }),
        NOW,
      );
      expect(c).toEqual({ bucket, motivo, elegivelRecebido: true });
    });
    it('repasse vinculado mas ausente → inconsistente repasse_ausente (nunca disponível)', () => {
      const c = classificarBucketAdmin(
        fatos({ idRepasse: 'r-1', repasseStatus: null, disponivelCanonico: true }),
        NOW,
      );
      expect(c).toEqual({
        bucket: 'inconsistente',
        motivo: 'repasse_ausente',
        elegivelRecebido: true,
      });
    });
  });

  describe('7: available_on null ou futuro → aguardando_liberacao', () => {
    it('null NÃO prova disponibilidade', () => {
      const c = classificarBucketAdmin(
        fatos({ availableOn: null, disponivelCanonico: false }),
        NOW,
      );
      expect(c.bucket).toBe('aguardando_liberacao');
    });
    it('futuro', () => {
      const c = classificarBucketAdmin(
        fatos({ availableOn: FUTURE, disponivelCanonico: false }),
        NOW,
      );
      expect(c.bucket).toBe('aguardando_liberacao');
    });
    it('exatamente agora conta como liberado', () => {
      const c = classificarBucketAdmin(fatos({ availableOn: NOW }), NOW);
      expect(c.bucket).toBe('disponivel');
    });
  });

  it('8: candidato excluído pela guarda canônica sem estorno conhecido → inconsistente (não disponível)', () => {
    const c = classificarBucketAdmin(fatos({ disponivelCanonico: false }), NOW);
    expect(c).toEqual({
      bucket: 'inconsistente',
      motivo: 'excluido_pela_guarda_canonica',
      elegivelRecebido: true,
    });
  });

  it('9: disponível', () => {
    expect(classificarBucketAdmin(fatos(), NOW)).toEqual({
      bucket: 'disponivel',
      motivo: null,
      elegivelRecebido: true,
    });
  });

  it('elegibilidade e bucket são coerentes: buckets fora do recebido ⇔ inelegível', () => {
    const casos: FatosLancamentoAdmin[] = [
      fatos(),
      fatos({ transferidoEm: PAST }),
      fatos({ canceladoEm: PAST }),
      fatos({ transferidoEm: PAST, canceladoEm: PAST }),
      fatos({ pagamentoStatus: 'pendente' }),
      fatos({ estornoAtivo: true, disponivelCanonico: false }),
      fatos({ idRepasse: 'r', repasseStatus: 'pago' }),
      fatos({ availableOn: null }),
      fatos({ disponivelCanonico: false }),
    ];
    for (const f of casos) {
      const c = classificarBucketAdmin(f, NOW);
      expect(c.elegivelRecebido).toBe(elegivelParaRecebido(f));
      expect(BUCKETS_ELEGIVEIS_RECEBIDO.has(c.bucket)).toBe(c.elegivelRecebido);
    }
  });
});

describe('agregarTotaisAdmin — partição exaustiva e cross-check', () => {
  const linhas: FatosLancamentoAdmin[] = [
    fatos({ idLancamento: 'a', amountCents: 100 }), // disponivel
    fatos({ idLancamento: 'b', amountCents: 200, availableOn: FUTURE, disponivelCanonico: false }), // aguardando_liberacao
    fatos({
      idLancamento: 'c',
      amountCents: 300,
      idRepasse: 'r1',
      repasseStatus: 'aprovado',
      disponivelCanonico: false,
    }), // aguardando_transferencia
    fatos({
      idLancamento: 'd',
      amountCents: 400,
      idRepasse: 'r2',
      repasseStatus: 'falhou',
      disponivelCanonico: false,
    }), // transferencia_falhou
    fatos({
      idLancamento: 'e',
      amountCents: 500,
      idRepasse: 'r3',
      repasseStatus: 'enviado_ao_banco',
      disponivelCanonico: false,
    }), // enviado_ao_banco
    fatos({ idLancamento: 'f', amountCents: 600, transferidoEm: PAST, disponivelCanonico: false }), // transferido
    fatos({ idLancamento: 'g', amountCents: 700, estornoAtivo: true, disponivelCanonico: false }), // estorno_em_andamento
    fatos({
      idLancamento: 'h',
      amountCents: 800,
      idRepasse: 'r4',
      repasseStatus: 'pago',
      disponivelCanonico: false,
    }), // inconsistente
    fatos({ idLancamento: 'i', amountCents: 900, canceladoEm: PAST, disponivelCanonico: false }), // estornado (fora)
    fatos({
      idLancamento: 'j',
      amountCents: 1100,
      transferidoEm: PAST,
      canceladoEm: PAST,
      disponivelCanonico: false,
    }), // anomalia (fora)
    fatos({
      idLancamento: 'k',
      amountCents: 1300,
      pagamentoStatus: 'pendente',
      estornoAtivo: true,
      disponivelCanonico: false,
    }), // anomalia (fora) — estorno ativo sobre pagamento não aprovado NÃO infla recebido
  ];

  const totais = agregarTotaisAdmin(linhas, NOW);

  it('recebidoConfirmado = Σ amount das linhas elegíveis, calculado sem olhar buckets', () => {
    const esperado = linhas.filter(elegivelParaRecebido).reduce((s, l) => s + l.amountCents, 0);
    expect(esperado).toBe(100 + 200 + 300 + 400 + 500 + 600 + 700 + 800);
    expect(totais.recebidoConfirmadoCents).toBe(esperado);
  });

  it('invariante: recebido = Σ buckets elegíveis (partição exaustiva e exclusiva)', () => {
    const soma =
      totais.disponivelCents +
      totais.aguardandoLiberacaoCents +
      totais.aguardandoTransferenciaCents +
      totais.transferenciaFalhouCents +
      totais.enviadoAoBancoCents +
      totais.transferidoCents +
      totais.estornoEmAndamentoCents +
      totais.inconsistenteCents;
    expect(soma).toBe(totais.recebidoConfirmadoCents);
  });

  it('buckets individuais', () => {
    expect(totais.disponivelCents).toBe(100);
    expect(totais.aguardandoLiberacaoCents).toBe(200);
    expect(totais.aguardandoTransferenciaCents).toBe(300);
    expect(totais.transferenciaFalhouCents).toBe(400);
    expect(totais.emTransferenciaCents).toBe(700);
    expect(totais.enviadoAoBancoCents).toBe(500);
    expect(totais.transferidoCents).toBe(600);
    expect(totais.resgatadoConcluidoCents).toBe(600);
    expect(totais.estornoEmAndamentoCents).toBe(700);
    expect(totais.inconsistenteCents).toBe(800);
    expect(totais.pendenteConferenciaCents).toBe(1500);
  });

  it('estornado e anomalias ficam FORA do recebido mas visíveis', () => {
    expect(totais.estornadoCents).toBe(900);
    expect(totais.estornadoCount).toBe(1);
    expect(totais.anomaliaCents).toBe(1100 + 1300);
    expect(totais.anomaliaCount).toBe(2);
    expect(totais.lancamentosCount).toBe(11);
  });

  it('resgatado não soma a linha transferido+cancelado', () => {
    expect(totais.resgatadoConcluidoCents).toBe(600);
  });

  it('lançamento repetido (mesmo id) conta uma vez', () => {
    const dup = agregarTotaisAdmin(
      [linhas[0] as FatosLancamentoAdmin, linhas[0] as FatosLancamentoAdmin],
      NOW,
    );
    expect(dup.lancamentosCount).toBe(1);
    expect(dup.recebidoConfirmadoCents).toBe(100);
  });

  it('vazio → tudo zero', () => {
    const z = agregarTotaisAdmin([], NOW);
    expect(z.recebidoConfirmadoCents).toBe(0);
    expect(z.lancamentosCount).toBe(0);
    expect(z.anomaliaCount).toBe(0);
  });
});
