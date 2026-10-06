// aperture-9bpre — período da aba Receita EuNeném (módulo puro, sem I/O).
//
// Única fonte para: datas locais America/Sao_Paulo, semana ISO (seg–dom), mês
// calendário, intervalo [de, ate) e a lista de buckets da série. Usado pelo
// servidor (validação + preenchimento da série) e pela página (painel 1b, via
// receitaPainel.ts), para que os dois nunca discordem sobre onde um período
// começa.
//
// Datas locais viajam como "YYYY-MM-DD". A aritmética usa `Date.UTC` apenas
// como calendário (sem fuso): o instante real de cada corte é resolvido no
// SQL com `AT TIME ZONE`.

export const RECEITA_TIMEZONE = "America/Sao_Paulo";
export const RECEITA_MAX_BUCKETS = 120;

export const GRANULARIDADES = ["semana", "mes"] as const;
export type Granularidade = (typeof GRANULARIDADES)[number];

export interface PeriodoReceita {
  /** Data local SP, inclusiva. */
  readonly de: string;
  /** Data local SP, exclusiva. */
  readonly ate: string;
  readonly granularidade: Granularidade;
}

export interface BucketReceita {
  /** Início calendário do bucket (segunda-feira ou dia 1). */
  readonly inicio: string;
  /** Fim calendário do bucket, exclusivo. */
  readonly fim: string;
  /** True quando o período escolhido cobre só parte do bucket. */
  readonly parcial: boolean;
}

export type PeriodoInvalido =
  | "data_invalida"
  | "intervalo_vazio"
  | "buckets_demais";

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function toCalendar(value: string): number | null {
  const match = LOCAL_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

function fromCalendar(ms: number): string {
  const date = new Date(ms);
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isLocalDate(value: string): boolean {
  return toCalendar(value) !== null;
}

function requireCalendar(value: string): number {
  const ms = toCalendar(value);
  if (ms === null) throw new Error("receita_data_invalida");
  return ms;
}

export function addDays(date: string, days: number): string {
  return fromCalendar(requireCalendar(date) + days * DAY_MS);
}

/** Soma meses a uma data que já é dia 1. */
export function addMonthsToMonthStart(date: string, months: number): string {
  const current = new Date(requireCalendar(date));
  return fromCalendar(
    Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + months, 1),
  );
}

/** Segunda-feira da semana ISO que contém `date`. */
export function startOfIsoWeek(date: string): string {
  const ms = requireCalendar(date);
  const weekday = new Date(ms).getUTCDay(); // 0 = domingo
  const sinceMonday = (weekday + 6) % 7;
  return fromCalendar(ms - sinceMonday * DAY_MS);
}

export function startOfMonth(date: string): string {
  const current = new Date(requireCalendar(date));
  return fromCalendar(
    Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1),
  );
}

function startOfBucket(date: string, granularidade: Granularidade): string {
  return granularidade === "semana" ? startOfIsoWeek(date) : startOfMonth(date);
}

function nextBucket(inicio: string, granularidade: Granularidade): string {
  return granularidade === "semana"
    ? addDays(inicio, 7)
    : addMonthsToMonthStart(inicio, 1);
}

/** Data local em São Paulo do instante `now`. */
export function localDateInSaoPaulo(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: RECEITA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function semanaAtual(now: Date): { de: string; ate: string } {
  const de = startOfIsoWeek(localDateInSaoPaulo(now));
  return { de, ate: addDays(de, 7) };
}

export function mesAtual(now: Date): { de: string; ate: string } {
  const de = startOfMonth(localDateInSaoPaulo(now));
  return { de, ate: addMonthsToMonthStart(de, 1) };
}

export function bucketsDoPeriodo(
  periodo: PeriodoReceita,
): { ok: true; buckets: BucketReceita[] } | { ok: false; erro: PeriodoInvalido } {
  const de = toCalendar(periodo.de);
  const ate = toCalendar(periodo.ate);
  if (de === null || ate === null) return { ok: false, erro: "data_invalida" };
  if (de >= ate) return { ok: false, erro: "intervalo_vazio" };

  const buckets: BucketReceita[] = [];
  let inicio = startOfBucket(periodo.de, periodo.granularidade);
  while (requireCalendar(inicio) < ate) {
    if (buckets.length >= RECEITA_MAX_BUCKETS) {
      return { ok: false, erro: "buckets_demais" };
    }
    const fim = nextBucket(inicio, periodo.granularidade);
    buckets.push({
      inicio,
      fim,
      parcial: requireCalendar(inicio) < de || requireCalendar(fim) > ate,
    });
    inicio = fim;
  }
  return { ok: true, buckets };
}

export function formatLocalDate(date: string): string {
  const match = LOCAL_DATE.exec(date);
  if (!match) return date;
  return `${match[3]}/${match[2]}/${match[1]}`;
}
