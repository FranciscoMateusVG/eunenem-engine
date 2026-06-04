// aperture-xjwc — mock data for /painel/[slug]/presentes ("Presentes recebidos").
//
// In-memory, no persistence — a fictional statement for the "chá da Mari".
// Incoming gifts and outgoing redemptions live in ONE statement, newest first.
// All amounts are BRL cents (so the cents render is exact and there is no
// float drift) and are formatted at render time. Mirrors the design export's
// data.jsx so the page reproduces the same totals shown in the mockups.

export type PresentesStatus =
  | "aguardando"
  | "disponivel"
  | "estornado"
  | "resgatado"
  | "tSolicitada"
  | "tEnviada";

export interface PresentesTx {
  id: string;
  /** ISO date in 2026 (yyyy-mm-dd). */
  d: string;
  /** Time of day, hh:mm. */
  t: string;
  /** "in" = gift received, "out" = resgate/transferência. Sign is implied. */
  type: "in" | "out";
  /** Giver (in) or destination (out). */
  guest: string;
  item: string;
  note: string;
  /** Amount in centavos — positive; the sign comes from `type`. */
  amount: number;
  status: PresentesStatus;
  /**
   * ISO timestamp — when the row's funds become available for transfer.
   * Populated from the wire's ExtratoRowDTO.liberacaoPrevistaEm only when
   * liberacao === 'aguardando_liberacao' AND parent pagamento has a
   * known balanceTransactionAvailableOn. Null otherwise (already
   * disponivel / transferido / cancelado / orphan-window).
   *
   * Optional in this shape because the mock data shipped pre-wire
   * doesn't have it; live wire data always provides string | null per
   * Rex's locked ExtratoRowDTOSchema.
   */
  liberacaoPrevistaEm?: string | null;
  /**
   * Optional image for the gift — emoji glyph (e.g. "🍼") OR a hosted URL.
   * Populated from the wire's ExtratoRowDTO.contribuicaoImagemUrl when the
   * contribuição has an image. Null/absent when the contribuição has no
   * image OR was deleted between pagamento and read.
   *
   * Wire shape (aperture-k6fbz, locked with Rex 2026-06-04): `string | null`.
   * Mock data doesn't carry images — optional in the type so the adapter
   * can populate from the wire without breaking pre-wire mock seeds.
   */
  itemImagemUrl?: string | null;
}

// Account opens with a prior balance so the running saldo stays positive
// through the history even though older outgoing > older incoming.
export const OPENING_BALANCE_CENTS = 320000; // R$ 3.200,00

/** Status palette — bg tint, accent stripe, ink, pt-BR label.
 *
 * Labels match operator vocabulary as of aperture-yspfw (folded with the
 * filter-dropdown scope-repair, 2026-06-04). The row badge label, the
 * filter chip label, and the drawer status label all read the SAME
 * vocabulary across the surface — single-vocabulary mental model. Old
 * "transf. enviada" / "transf. solicitada" / "estornado" labels read as
 * mock-era abbreviations; the wire's plain "transferido" / "solicitado" /
 * "cancelado" are what the operator says out loud.
 *
 * Color call: solicitado uses the existing lilac/purple palette — the
 * mock UI shipped this color for "admin pipeline pending" from day one,
 * which matches the wire's `solicitado` semantic exactly (aperture-1ut92).
 */
export const STATUS_TINT: Record<
  PresentesStatus,
  { bg: string; stripe: string; ink: string; label: string }
> = {
  disponivel: { bg: "#E5EFCF", stripe: "#7FA32E", ink: "#42620C", label: "disponível" },
  aguardando: { bg: "#F7E8A5", stripe: "#D2A82A", ink: "#7A5B0D", label: "aguardando liberação" },
  resgatado: { bg: "#F4D6CE", stripe: "#B7503C", ink: "#7B2A1A", label: "resgatado" },
  estornado: { bg: "#E6E1DA", stripe: "#9C928A", ink: "#5B544D", label: "cancelado" },
  tSolicitada: { bg: "#E2D7EE", stripe: "#7E5BA8", ink: "#492F70", label: "solicitado" },
  tEnviada: { bg: "#D2E4DD", stripe: "#4F7B69", ink: "#244C3D", label: "transferido" },
};

/** Filter-pill options, in display order — matches the 5 wire liberacao
 *  states (aperture-1ut92): aguardando_liberacao / disponivel / solicitado /
 *  transferido / cancelado. The mock's `resgatado` state never surfaces
 *  in wire row data (the wire ships lancamento-grain only; account-level
 *  resgate is summary-only), so it's dropped from the filter set —
 *  zero-count clutter on a filter chip is operator confusion.
 *
 *  Labels match the STATUS_TINT row-badge labels above so the chip
 *  vocabulary and the row vocabulary read the same. */
export const FILTER_OPTIONS: { key: PresentesStatus; label: string; color: string }[] = [
  { key: "aguardando", label: "aguardando liberação", color: "#D2A82A" },
  { key: "disponivel", label: "disponível", color: "#7FA32E" },
  { key: "tSolicitada", label: "solicitado", color: "#7E5BA8" },
  { key: "tEnviada", label: "transferido", color: "#4F7B69" },
  { key: "estornado", label: "cancelado", color: "#9C928A" },
];

export const PRESENTES_TX: PresentesTx[] = [
  // 22 mai (hoje)
  { id: "t35", d: "2026-05-22", t: "14:32", type: "in", guest: "Mariana Souza", item: "Carrinho 3 em 1", note: "cota completa", amount: 35000, status: "aguardando" },
  { id: "t34", d: "2026-05-22", t: "11:18", type: "in", guest: "Camila Ribeiro", item: "Berço Montessoriano", note: "cota completa", amount: 28000, status: "aguardando" },
  { id: "t33", d: "2026-05-22", t: "09:47", type: "in", guest: "Vovó Lurdes", item: "Enxoval Premium", note: "cota completa, com cartão", amount: 80000, status: "aguardando" },

  // 21 mai (ontem)
  { id: "t32", d: "2026-05-21", t: "22:14", type: "in", guest: "Patrícia Andrade", item: "Kit mamadeiras anti-cólica", note: "", amount: 14500, status: "aguardando" },
  { id: "t31", d: "2026-05-21", t: "18:50", type: "in", guest: "Fernanda Lima", item: "Termômetro digital", note: "", amount: 8990, status: "disponivel" },
  { id: "t30", d: "2026-05-21", t: "16:33", type: "in", guest: "Beatriz Oliveira", item: "Babá eletrônica c/ câmera", note: "modelo full HD", amount: 85000, status: "disponivel" },
  { id: "t29", d: "2026-05-21", t: "11:05", type: "in", guest: "Juliana Castro", item: "Banheira ergonômica", note: "", amount: 18990, status: "disponivel" },

  // 20 mai
  { id: "t28", d: "2026-05-20", t: "20:11", type: "in", guest: "Renata Almeida", item: "Naninha de tricô", note: "feita à mão", amount: 7500, status: "disponivel" },
  { id: "t27", d: "2026-05-20", t: "14:27", type: "in", guest: "Carolina Mendes", item: "Almofada de amamentação", note: "", amount: 15900, status: "disponivel" },
  { id: "t26", d: "2026-05-20", t: "09:18", type: "in", guest: "Aline Pereira", item: "Pacote de fraldas RN", note: "3 unidades", amount: 12000, status: "disponivel" },

  // 19 mai
  { id: "t25", d: "2026-05-19", t: "16:00", type: "out", guest: "Banco Inter · ag. 0001 · c/c 12345-6", item: "Transferência enviada", note: "TED para conta corrente", amount: 150000, status: "tEnviada" },
  { id: "t24", d: "2026-05-19", t: "10:42", type: "in", guest: "Larissa Cardoso", item: "Cadeirinha de alimentação", note: "", amount: 29900, status: "disponivel" },
  { id: "t23", d: "2026-05-19", t: "08:55", type: "in", guest: "Gabriela Martins", item: "Móbile musical", note: "", amount: 11990, status: "disponivel" },

  // 18 mai
  { id: "t22", d: "2026-05-18", t: "21:30", type: "in", guest: "Luana Ferreira", item: "Kit higiene em porcelana", note: "", amount: 22000, status: "disponivel" },
  { id: "t21", d: "2026-05-18", t: "15:12", type: "in", guest: "Isabela Costa", item: "Tapete de atividades", note: "", amount: 18900, status: "disponivel" },
  { id: "t20", d: "2026-05-18", t: "11:47", type: "in", guest: "Vovô Antônio", item: "Berço Premium", note: "cota cheia (4ª de 5)", amount: 100000, status: "disponivel" },
  { id: "t19", d: "2026-05-18", t: "09:33", type: "in", guest: "Natália Rocha", item: "Body manga longa", note: "kit com 5", amount: 9500, status: "estornado" },

  // 17 mai
  { id: "t18", d: "2026-05-17", t: "19:08", type: "in", guest: "Bruna Carvalho", item: "Macacão de plush", note: "", amount: 8500, status: "disponivel" },
  { id: "t17", d: "2026-05-17", t: "14:22", type: "in", guest: "Tia Cláudia", item: "Carrinho de bebê", note: "2ª cota de 3", amount: 70000, status: "disponivel" },
  { id: "t16", d: "2026-05-17", t: "10:15", type: "in", guest: "Letícia Barbosa", item: "Aspirador nasal elétrico", note: "", amount: 15990, status: "disponivel" },

  // 15 mai
  { id: "t15", d: "2026-05-15", t: "17:44", type: "in", guest: "Amanda Nogueira", item: "Kit toalhas de banho", note: "", amount: 17500, status: "disponivel" },
  { id: "t14", d: "2026-05-15", t: "12:30", type: "in", guest: "Vanessa Pinto", item: "Esterilizador de mamadeiras", note: "elétrico", amount: 58000, status: "disponivel" },
  { id: "t13", d: "2026-05-15", t: "09:00", type: "out", guest: "Banco Inter · ag. 0001 · c/c 12345-6", item: "Transferência solicitada", note: "agendada para 26/mai", amount: 80000, status: "tSolicitada" },

  // 13 mai
  { id: "t12", d: "2026-05-13", t: "21:55", type: "in", guest: "Priscila Moreira", item: "Trocador com almofada", note: "", amount: 21000, status: "disponivel" },
  { id: "t11", d: "2026-05-13", t: "13:18", type: "in", guest: "Tatiana Reis", item: "Sapatinhos", note: "kit 3 pares", amount: 11000, status: "disponivel" },
  { id: "t10", d: "2026-05-13", t: "08:42", type: "in", guest: "Daniela Macedo", item: "Enxoval", note: "1ª cota de 4", amount: 50000, status: "disponivel" },

  // 12 mai
  { id: "t09", d: "2026-05-12", t: "11:23", type: "out", guest: "Loja Bemglô", item: "Resgate em compra", note: "cômoda + colchão", amount: 189000, status: "resgatado" },
  { id: "t08", d: "2026-05-12", t: "09:00", type: "in", guest: "Cristina Vieira", item: "Chocalhos sensoriais", note: "", amount: 6500, status: "disponivel" },

  // 10 mai
  { id: "t07", d: "2026-05-10", t: "16:30", type: "in", guest: "Sophia Brandão", item: "Mamadeiras de vidro", note: "kit com 4", amount: 16900, status: "disponivel" },
  { id: "t06", d: "2026-05-10", t: "10:11", type: "in", guest: "Prima Helena", item: "Carrinho de bebê", note: "1ª cota de 3", amount: 70000, status: "disponivel" },

  // 07 mai
  { id: "t05", d: "2026-05-07", t: "14:00", type: "in", guest: "Tio Roberto", item: "Cinta puerpério", note: "", amount: 14500, status: "estornado" },
  { id: "t04", d: "2026-05-07", t: "09:40", type: "in", guest: "Vovó Lurdes", item: "Sling ergonômico", note: "", amount: 32000, status: "disponivel" },

  // 04 mai
  { id: "t03", d: "2026-05-04", t: "15:20", type: "out", guest: "Loja Lillo", item: "Resgate em compra", note: "bolsa maternidade", amount: 48000, status: "resgatado" },
  { id: "t02", d: "2026-05-04", t: "11:00", type: "in", guest: "Mariana Souza", item: "Pomada para assaduras", note: "kit com 3", amount: 4990, status: "disponivel" },

  // 28 abr
  { id: "t01", d: "2026-04-28", t: "18:33", type: "out", guest: "Banco Inter · ag. 0001 · c/c 12345-6", item: "Transferência solicitada", note: "cancelada pelo banco", amount: 60000, status: "tSolicitada" },
];

export interface PresentesSummary {
  disponivel: number;
  aguardando: number;
  recebido: number;
  resgatado: number;
  presentes: number;
  opening: number;
}

// disponível = opening + (incoming.disponivel) − (all outgoing in any state)
// aguardando = sum incoming.aguardando
// recebido   = sum incoming (any state except estornado)
// resgatado  = sum outgoing (any state)
// presentes  = count incoming (any state except estornado)
export function summarize(txs: PresentesTx[]): PresentesSummary {
  let disponivel = OPENING_BALANCE_CENTS;
  let aguardando = 0;
  let recebido = 0;
  let resgatado = 0;
  let presentes = 0;
  for (const x of txs) {
    if (x.type === "in") {
      if (x.status === "estornado") continue;
      recebido += x.amount;
      presentes += 1;
      if (x.status === "aguardando") aguardando += x.amount;
      if (x.status === "disponivel") disponivel += x.amount;
    } else {
      resgatado += x.amount;
      disponivel -= x.amount;
    }
  }
  return { disponivel, aguardando, recebido, resgatado, presentes, opening: OPENING_BALANCE_CENTS };
}

// ── Formatters ─────────────────────────────────────────────────────────────
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const fmtMoney = (cents: number): string => BRL.format(cents / 100);

const MONTHS_FULL = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** "22/mai" — used in the ticket row meta. */
export function dateShort(iso: string): string {
  const d = parseISO(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${MONTHS_SHORT[d.getMonth()]}`;
}

/** "22 de maio de 2026" — used in the resgatado modal. */
export function dateLong(iso: string): string {
  const d = parseISO(iso);
  return `${d.getDate()} de ${MONTHS_FULL[d.getMonth()]} de ${d.getFullYear()}`;
}
