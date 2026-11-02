import { z } from 'zod';
import { analyticsPeriod, type AnalyticsBucket, type AnalyticsMonths } from './admin-analytics.js';

const TIMEZONE = 'America/Los_Angeles';
const AVISO = 'Dias no fuso de Mixpanel (Pacífico). Visualizações e eventos de cadastro, não sessões nem funil de conversão. Fontes: UTM do evento (até 50 valores; restante não detalhado).';
const HOSTS = { US: 'mixpanel.com', EU: 'eu.mixpanel.com', IN: 'in.mixpanel.com' } as const;
const SUCCESS_TTL = 20 * 60_000;
const FAILURE_TTL = 5 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SegmentationSchema = z.object({ data: z.object({
  values: z.record(z.string(), z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))),
}) });
type Values = z.infer<typeof SegmentationSchema>['data']['values'];
export interface TrafficConfig {
  MIXPANEL_PROJECT_ID?: string; MIXPANEL_SERVICE_ACCOUNT_USERNAME?: string;
  MIXPANEL_SERVICE_ACCOUNT_SECRET?: string; MIXPANEL_API_REGION?: string;
}
interface TrafficData { views: Values; signups: Values; viewSources: Values; signupSources: Values }
interface TrafficCache { updatedAt: string; data: TrafficData | null; motivo?: string }
export interface TrafficMetrics { visitas: number; visitantes: null; cadastros: number; conversaoPct: null }

function periodFor(now: Date, months: AnalyticsMonths) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  // Reuse calendar arithmetic, replacing only the local day (not converting daily totals to SP).
  return { ...analyticsPeriod(new Date(`${day}T15:00:00Z`), months), snapshotAt: now.toISOString() };
}
function count(values: Values, de: string, ate: string) {
  let total = 0;
  for (const series of Object.values(values)) for (const [day, value] of Object.entries(series)) {
    if (day >= de && day < ate) total += value;
  }
  if (!Number.isSafeInteger(total)) throw new Error('Invalid count');
  return total;
}
/** Finite source labels: UTM is user input, not a channel for returning arbitrary text/PII. */
function sourceLabel(source: string) {
  const value = source.toLowerCase().trim();
  if (['google', 'google_ads', 'googleads', 'adwords'].includes(value)) return 'Google';
  if (['facebook', 'fb', 'meta'].includes(value)) return 'Facebook / Meta';
  if (['instagram', 'ig'].includes(value)) return 'Instagram';
  if (['bing', 'microsoft'].includes(value)) return 'Bing';
  if (['tiktok', 'youtube', 'pinterest'].includes(value)) return value;
  if (['', 'undefined', 'null', '(not set)', '$undefined'].includes(value)) return 'Não informada';
  return 'Outras';
}
async function boundedJson(response: Response) {
  if (!response.ok || !response.body) throw new Error('Mixpanel unavailable');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Response too large');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return SegmentationSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).data.values;
}

/** One production instance per process. Four bounded read-only requests for a 12-month
 * snapshot shared by all selectors; single-flight + success/failure TTL prevent stampedes.
 * No credentials, URLs, upstream errors or raw source labels ever enter the response/logs.
 */
export class AdminTrafficReader {
  private cache: { key: string; expiresAt: number; value: TrafficCache } | undefined;
  private inflight: Promise<TrafficCache> | undefined;
  constructor(private readonly config: TrafficConfig, private readonly http: typeof fetch = fetch) {}

  private async read(now: Date): Promise<TrafficCache> {
    const period = periodFor(now, 12);
    const key = period.periodo.de;
    if (this.cache?.key === key && this.cache.expiresAt > now.getTime()) return this.cache.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchSnapshot(period.periodo.de, period.hoje, now).then(value => {
      this.cache = { key, value, expiresAt: now.getTime() + (value.data ? SUCCESS_TTL : FAILURE_TTL) };
      return value;
    }).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async fetchSnapshot(from: string, to: string, now: Date): Promise<TrafficCache> {
    const updatedAt = now.toISOString();
    const config = this.config;
    const region = config.MIXPANEL_API_REGION as keyof typeof HOSTS;
    const host = Object.hasOwn(HOSTS, region) ? HOSTS[region] : undefined;
    if (!host || !/^\d+$/.test(config.MIXPANEL_PROJECT_ID ?? '') || !config.MIXPANEL_SERVICE_ACCOUNT_USERNAME || !config.MIXPANEL_SERVICE_ACCOUNT_SECRET) {
      return { updatedAt, data: null, motivo: 'Mixpanel indisponível: configuração ausente ou inválida.' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const query = async (event: string, sources = false) => {
      const url = new URL(`https://${host}/api/query/segmentation`);
      url.search = new URLSearchParams({ project_id: config.MIXPANEL_PROJECT_ID ?? '', event,
        from_date: from, to_date: to, unit: 'day', type: 'general',
        ...(sources ? { on: 'properties["utm_source"]', limit: '50' } : {}),
      }).toString();
      const authorization = Buffer.from(`${config.MIXPANEL_SERVICE_ACCOUNT_USERNAME}:${config.MIXPANEL_SERVICE_ACCOUNT_SECRET}`).toString('base64');
      const response = await this.http(url, { headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
      return boundedJson(response);
    };
    try {
      const [views, signups, viewSources, signupSources] = await Promise.all([
        query('page_view_custom'), query('conta_criada'), query('page_view_custom', true), query('conta_criada', true),
      ]);
      for (const values of [views, signups, viewSources, signupSources]) count(values, '0000-01-01', '9999-12-31');
      return { updatedAt, data: { views, signups, viewSources, signupSources } };
    } catch {
      controller.abort();
      return { updatedAt, data: null, motivo: 'Mixpanel indisponível no momento. Tente novamente mais tarde.' };
    } finally { clearTimeout(timer); }
  }

  async load(now: Date, months: AnalyticsMonths) {
    const period = periodFor(now, months);
    const result = await this.read(now);
    const data = result.data;
    const metrics = (de: string, ate: string): TrafficMetrics => ({
      visitas: data ? count(data.views, de, ate) : 0, cadastros: data ? count(data.signups, de, ate) : 0,
      visitantes: null, conversaoPct: null,
    });
    const bucket = (b: AnalyticsBucket) => ({ ...b, ...metrics(b.de < period.periodo.de ? period.periodo.de : b.de, b.ate < period.periodo.ate ? b.ate : period.periodo.ate) });
    const fontes = new Map<string, { fonte: string; visitas: number; cadastros: number }>();
    if (data) for (const [values, field] of [[data.viewSources, 'visitas'], [data.signupSources, 'cadastros']] as const) {
      for (const [source, days] of Object.entries(values)) {
        const label = sourceLabel(source); const row = fontes.get(label) ?? { fonte: label, visitas: 0, cadastros: 0 };
        row[field] += count({ series: days }, period.periodo.de, period.periodo.ate); fontes.set(label, row);
      }
    }
    return { ...period, timezone: TIMEZONE, aviso: AVISO, disponivel: data !== null,
      motivo: result.motivo, atualizadoEm: result.updatedAt,
      totais: metrics(period.periodo.de, period.periodo.ate), meses: period.meses.map(bucket), semanas: period.semanas.map(bucket),
      fontes: [...fontes.values()].sort((a, b) => b.visitas - a.visitas || a.fonte.localeCompare(b.fonte)),
    };
  }
}
