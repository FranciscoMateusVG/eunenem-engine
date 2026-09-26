/**
 * Rótulos e formatadores do detalhe financeiro do usuário no admin
 * (aperture-5jk8y). Valores persistidos/wire nunca viram copy: tudo passa
 * por aqui. Nenhum valor "estimado" é inventado — o que não existe no
 * ledger aparece como "não disponível".
 */

export type BucketAdmin =
  | "disponivel"
  | "aguardando_liberacao"
  | "aguardando_transferencia"
  | "transferencia_falhou"
  | "enviado_ao_banco"
  | "transferido"
  | "estorno_em_andamento"
  | "inconsistente"
  | "estornado"
  | "anomalia";

export const BUCKET_ORDER: readonly BucketAdmin[] = [
  "disponivel",
  "aguardando_liberacao",
  "aguardando_transferencia",
  "transferencia_falhou",
  "enviado_ao_banco",
  "transferido",
  "estorno_em_andamento",
  "inconsistente",
  "estornado",
  "anomalia",
];

export const BUCKET_LABEL: Record<BucketAdmin, string> = {
  disponivel: "Disponível",
  aguardando_liberacao: "Aguardando liberação",
  aguardando_transferencia: "Aguardando transferência",
  transferencia_falhou: "Transferência falhou",
  enviado_ao_banco: "Enviado ao banco",
  transferido: "Transferido",
  estorno_em_andamento: "Estorno em andamento",
  inconsistente: "Inconsistente",
  estornado: "Estornado",
  anomalia: "Anomalia",
};

/** Gloss curto para o operador (tooltip/title e legenda). */
export const BUCKET_GLOSS: Record<BucketAdmin, string> = {
  disponivel: "aprovado, liberado pelo provedor e ainda não reivindicado por repasse",
  aguardando_liberacao: "aprovado; o provedor ainda não liberou o valor (ou data desconhecida)",
  aguardando_transferencia: "reivindicado por um repasse em fila/aprovação/transferência",
  transferencia_falhou: "repasse falhou — nenhum valor foi movido; requer resolução",
  enviado_ao_banco: "solicitação aceita e entregue ao banco",
  transferido: "carimbo de transferência no ledger — resgate concluído",
  estorno_em_andamento: "estorno em andamento; valor ainda não estornado",
  inconsistente: "fatos contraditórios entre ledger e repasse — pendente de conferência",
  estornado: "cancelamento persistido; fora do total recebido",
  anomalia: "linha sem pagamento aprovado por trás, ou carimbos contraditórios — fora do recebido",
};

/** Classes do pill por bucket (tokens do admin + paleta utilitária já usada nas páginas admin). */
export const BUCKET_PILL_CLASS: Record<BucketAdmin, string> = {
  disponivel: "border-emerald-200 bg-emerald-50 text-emerald-800",
  aguardando_liberacao: "border-line bg-cream-2 text-ink-soft",
  aguardando_transferencia: "border-sky-200 bg-sky-50 text-sky-800",
  transferencia_falhou: "border-red-200 bg-red-50 text-red-800",
  enviado_ao_banco: "border-sky-200 bg-sky-50 text-sky-800",
  transferido: "border-line bg-paper text-ink",
  estorno_em_andamento: "border-amber-200 bg-amber-50 text-amber-900",
  inconsistente: "border-amber-200 bg-amber-50 text-amber-900",
  estornado: "border-line bg-cream-2 text-ink-mute line-through decoration-ink-mute/60",
  anomalia: "border-red-200 bg-red-50 text-red-800",
};

export const MOTIVO_LABEL: Record<string, string> = {
  transferido_e_cancelado: "transferido e cancelado ao mesmo tempo",
  pagamento_ausente: "pagamento não encontrado",
  pagamento_nao_aprovado: "pagamento não aprovado",
  repasse_pago_sem_transferido: "repasse pago sem carimbo de transferência",
  repasse_ausente: "repasse vinculado não encontrado",
  repasse_cancelado_com_vinculo: "repasse cancelado mas ainda vinculado",
  repasse_status_desconhecido: "status de repasse não reconhecido",
  excluido_pela_guarda_canonica: "excluído pela guarda de disponibilidade sem estorno conhecido",
};

export type EstadoExtrato =
  | "aguardando_aprovacao"
  | "em_transferencia"
  | "enviado_ao_banco"
  | "concluido"
  | "falhou"
  | "cancelado"
  | "inconsistente";

export const ESTADO_EXTRATO_LABEL: Record<EstadoExtrato, string> = {
  aguardando_aprovacao: "Aguardando aprovação",
  em_transferencia: "Em transferência",
  enviado_ao_banco: "Enviado ao banco",
  concluido: "Concluído",
  falhou: "Falhou",
  cancelado: "Cancelado",
  inconsistente: "Pendente de conferência",
};

export const ESTADO_EXTRATO_PILL_CLASS: Record<EstadoExtrato, string> = {
  aguardando_aprovacao: "border-line bg-cream-2 text-ink-soft",
  em_transferencia: "border-sky-200 bg-sky-50 text-sky-800",
  enviado_ao_banco: "border-sky-200 bg-sky-50 text-sky-800",
  concluido: "border-emerald-200 bg-emerald-50 text-emerald-800",
  falhou: "border-red-200 bg-red-50 text-red-800",
  cancelado: "border-line bg-cream-2 text-ink-mute",
  inconsistente: "border-amber-200 bg-amber-50 text-amber-900",
};

export const METODO_LABEL: Record<"pix" | "credit_card", string> = {
  pix: "PIX",
  credit_card: "Cartão",
};

const SAO_PAULO = "America/Sao_Paulo";

/** `DD/MM/YYYY, HH:MM` em America/Sao_Paulo; fallback determinístico UTC. */
export function formatDateTimeBR(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      timeZone: SAO_PAULO,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm} UTC`;
  }
}

/** `DD/MM/YYYY` em America/Sao_Paulo. */
export function formatDateBR(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString("pt-BR", {
      timeZone: SAO_PAULO,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
