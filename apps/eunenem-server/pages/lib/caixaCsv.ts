// aperture-zoxel — CSV do Fluxo de caixa. Função pura sobre o mesmo read
// model da tela: o arquivo nunca discorda do que está na página.

import { addDays } from "./receitaPeriodo.js";

/** Formato mínimo que o CSV precisa do painel (o painel completo satisfaz). */
export interface CaixaCsvEntrada {
  readonly presenteCents: number;
  readonly taxaCents: number;
  readonly adicionalCartaoCents: number;
  readonly brutoCents: number;
  readonly estornosCents: number;
  readonly liquidoCents: number;
}

interface Contagem {
  readonly cents: number;
  readonly repasses: number;
}

export interface CaixaCsvPainel {
  readonly periodo: { readonly de: string; readonly ate: string; readonly granularidade: string };
  readonly entradas: CaixaCsvEntrada & {
    readonly pagamentos: number;
    readonly porMetodo: Readonly<Record<string, CaixaCsvEntrada>>;
  };
  readonly saidas: {
    readonly totalCents: number;
    readonly repasses: number;
    readonly porMetodo: Readonly<Record<string, { readonly cents: number; readonly repasses: number }>>;
  };
  readonly pendentes: {
    readonly aprovadosNaoTransferidos: Contagem;
    readonly emVerificacao: Contagem;
    readonly semComprovante: Contagem;
  };
  readonly conciliacao: {
    readonly totalPagoDosPagamentosCents: number;
    readonly totalDosRepassesCents: number;
    readonly diferencas: {
      readonly entradasBrutasCents: number;
      readonly estornosCents: number;
      readonly saidasCents: number;
      readonly totalPagoCents: number;
      readonly repassesCents: number;
    };
  };
  readonly saldoCents: number;
  readonly serie: ReadonlyArray<{
    readonly inicio: string;
    readonly fim: string;
    readonly entradasBrutasCents: number;
    readonly estornosCents: number;
    readonly saidasCents: number;
    readonly saldoCents: number;
  }>;
}

/** 12345 → "123,45"; -5 → "-0,05". Inteiro puro, sem ponto flutuante. */
export function centavosParaReais(cents: number): string {
  const sinal = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sinal}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function campo(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

function linha(secao: string, item: string, cents: number | null): string {
  if (cents === null) return [secao, campo(item), "", ""].join(",");
  return [secao, campo(item), String(cents), campo(centavosParaReais(cents))].join(",");
}

const NOME_METODO: Record<string, string> = {
  pix: "pix",
  credit_card: "cartao",
  nao_registrado: "metodo_nao_registrado",
  inter: "inter_automatico",
  manual: "manual",
};

export function caixaParaCsv(painel: CaixaCsvPainel): string {
  const out: string[] = ["secao,item,centavos,reais"];
  // Datas viajam como texto: linhas de período não têm valor em centavos.
  out.push(`periodo,de,,${painel.periodo.de}`);
  out.push(`periodo,ate_exclusivo,,${painel.periodo.ate}`);
  out.push(`periodo,granularidade,,${painel.periodo.granularidade}`);

  const e = painel.entradas;
  out.push(linha("entradas", "presente", e.presenteCents));
  out.push(linha("entradas", "taxa_eunenem", e.taxaCents));
  out.push(linha("entradas", "adicional_cartao", e.adicionalCartaoCents));
  out.push(linha("entradas", "bruto", e.brutoCents));
  out.push(linha("entradas", "estornos", e.estornosCents));
  out.push(linha("entradas", "liquido", e.liquidoCents));
  for (const [metodo, m] of Object.entries(e.porMetodo)) {
    const nome = NOME_METODO[metodo] ?? metodo;
    out.push(linha("entradas_por_metodo", `${nome}:presente`, m.presenteCents));
    out.push(linha("entradas_por_metodo", `${nome}:taxa_eunenem`, m.taxaCents));
    out.push(linha("entradas_por_metodo", `${nome}:adicional_cartao`, m.adicionalCartaoCents));
    out.push(linha("entradas_por_metodo", `${nome}:bruto`, m.brutoCents));
    out.push(linha("entradas_por_metodo", `${nome}:estornos`, m.estornosCents));
    out.push(linha("entradas_por_metodo", `${nome}:liquido`, m.liquidoCents));
  }

  out.push(linha("saidas", "repasses_transferidos", painel.saidas.totalCents));
  for (const [metodo, m] of Object.entries(painel.saidas.porMetodo)) {
    out.push(linha("saidas_por_metodo", NOME_METODO[metodo] ?? metodo, m.cents));
  }

  // Pendentes são fotografia de agora e NÃO entram no saldo.
  out.push(
    linha(
      "pendentes_nao_contam_como_saida",
      "aprovados_ainda_nao_transferidos",
      painel.pendentes.aprovadosNaoTransferidos.cents,
    ),
  );
  out.push(
    linha("pendentes_nao_contam_como_saida", "em_verificacao", painel.pendentes.emVerificacao.cents),
  );

  out.push(
    linha(
      "pendentes_nao_contam_como_saida",
      "marcados_transferidos_sem_comprovante",
      painel.pendentes.semComprovante.cents,
    ),
  );

  out.push(linha("saldo", "saldo_do_periodo", painel.saldoCents));

  // Mesmas contagens que a tela mostra.
  const n = (item: string, valor: number) => `contagens,${item},${valor},`;
  out.push(n("pagamentos_aprovados", e.pagamentos));
  out.push(n("repasses_transferidos", painel.saidas.repasses));
  for (const [metodo, m] of Object.entries(painel.saidas.porMetodo)) {
    out.push(n(`repasses_${NOME_METODO[metodo] ?? metodo}`, m.repasses));
  }
  out.push(n("pendentes_aprovados_nao_transferidos_repasses", painel.pendentes.aprovadosNaoTransferidos.repasses));
  out.push(n("pendentes_em_verificacao_repasses", painel.pendentes.emVerificacao.repasses));
  out.push(n("pendentes_sem_comprovante_repasses", painel.pendentes.semComprovante.repasses));

  // Conferência com o livro: diferença ≠ 0 nunca fica escondida.
  const c = painel.conciliacao;
  out.push(linha("conciliacao", "total_pago_dos_pagamentos", c.totalPagoDosPagamentosCents));
  out.push(linha("conciliacao", "total_dos_repasses", c.totalDosRepassesCents));
  out.push(linha("conciliacao", "diferenca_entradas_brutas", c.diferencas.entradasBrutasCents));
  out.push(linha("conciliacao", "diferenca_estornos", c.diferencas.estornosCents));
  out.push(linha("conciliacao", "diferenca_saidas", c.diferencas.saidasCents));
  out.push(linha("conciliacao", "diferenca_total_pago", c.diferencas.totalPagoCents));
  out.push(linha("conciliacao", "diferenca_repasses", c.diferencas.repassesCents));

  for (const b of painel.serie) {
    const chave = `${b.inicio}|${b.fim}`;
    out.push(linha("serie", `${chave}|entradas_brutas`, b.entradasBrutasCents));
    out.push(linha("serie", `${chave}|estornos`, b.estornosCents));
    out.push(linha("serie", `${chave}|saidas`, b.saidasCents));
    out.push(linha("serie", `${chave}|saldo`, b.saldoCents));
  }
  // BOM para o Excel abrir acentos corretamente.
  return `﻿${out.join("\r\n")}\r\n`;
}

/** Nome do arquivo: período inclusivo (ate − 1 dia). */
export function nomeArquivoCaixa(periodo: { de: string; ate: string }): string {
  return `fluxo-de-caixa_${periodo.de}_a_${addDays(periodo.ate, -1)}.csv`;
}
