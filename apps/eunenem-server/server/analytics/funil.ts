import type { ServerDeps } from '../auth/setup.js';

/**
 * aperture-ai8vg — pure prop builders for the creator-funnel server events
 * (cadastro → lista → personalização → convite → convidados). One place, one
 * schema per event, unit-tested without routers. Rules (root-binding):
 *   - every event sits on a DURABLE row and carries its stable id as the
 *     sink's insertKey; the row's own timestamp is the business time;
 *   - opaque ids only — never names, titles, slugs, emails, phones;
 *   - nothing is inferred: an unknown fact is omitted (metodo) or reported as
 *     'unknown' (legacy classification), never guessed.
 */

export interface ClassificacaoLegado {
  /** true/false against the versioned snapshot; 'unknown' when undecidable. */
  readonly migrado_1_0: boolean | 'unknown';
  /** Content hash of the legacy list the classification was made against. */
  readonly legado_snapshot: string;
}

export interface ContaCriadaFacts {
  readonly idPlataforma: string;
  readonly legado: ClassificacaoLegado;
  /** BetterAuth users.created_at — the signup OCCURRENCE (emission is lazy). */
  readonly signupAt?: Date | undefined;
  /** The default list auto-created with the account, when resolvable. */
  readonly idCampanhaPadrao?: string | undefined;
}

export function propsContaCriada(f: ContaCriadaFacts): Record<string, unknown> {
  return {
    idPlataforma: f.idPlataforma,
    migrado_1_0: f.legado.migrado_1_0,
    legado_snapshot: f.legado.legado_snapshot,
    ...(f.idCampanhaPadrao ? { id_campanha_padrao: f.idCampanhaPadrao } : {}),
    ...(f.signupAt ? { signup_at: f.signupAt.toISOString() } : {}),
  };
}

/** Explicit create only — the signup default list is part of the cadastro fact. */
export function propsCampanhaCriada(idCampanha: string): Record<string, unknown> {
  return { idCampanha, origem: 'explicita' };
}

export interface ListaItemCriadoFacts {
  readonly idCampanha: string;
  readonly items: ReadonlyArray<{ readonly quantidade?: number | undefined }>;
}

/** Per write: how many lines/units this call added. No first-item claim here. */
export function propsListaItemCriado(f: ListaItemCriadoFacts): Record<string, unknown> {
  return {
    id_campanha: f.idCampanha,
    linhas: f.items.length,
    quantidade_itens: f.items.reduce((total, it) => total + (it.quantidade ?? 1), 0),
  };
}

/**
 * Earliest row among a set (criadaEm, then id as a total tie-break). Used to
 * take the PERSISTED criadaEm of the rows a write just created as the
 * event's business time. Pure — unit-tested. It is NOT used to claim a
 * "first item" fact (root decision: that step is derived in the funnel and
 * by DB MIN(criada_em), never emitted).
 */
export function maisAntigo<T extends { readonly id: string; readonly criadaEm: Date }>(
  linhas: ReadonlyArray<T>,
): T | undefined {
  let primeiro: T | undefined;
  for (const it of linhas) {
    if (
      primeiro === undefined ||
      it.criadaEm.getTime() < primeiro.criadaEm.getTime() ||
      (it.criadaEm.getTime() === primeiro.criadaEm.getTime() && it.id < primeiro.id)
    ) {
      primeiro = it;
    }
  }
  return primeiro;
}

export interface PerfilCampanhaSalvoFacts {
  readonly idCampanha: string;
  /** The saved content — only COUNTED here, values never leave. */
  readonly conteudo: Record<string, unknown>;
}

function preenchido(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/**
 * No `primeira_vez` here: a pre-upsert "row absent" read is not authoritative
 * under concurrency (two first saves can both see absence). The funnel step
 * "personalização" is the DB fact perfil_campanhas.criado_em (SQL §4c); the
 * event only reports what this save contained.
 */
export function propsPerfilCampanhaSalvo(f: PerfilCampanhaSalvoFacts): Record<string, unknown> {
  const nomeBebe = f.conteudo.nomeBebe;
  return {
    id_campanha: f.idCampanha,
    nomeado: typeof nomeBebe === 'string' && nomeBebe.trim().length > 0,
    campos_preenchidos: Object.values(f.conteudo).filter(preenchido).length,
  };
}

/**
 * The durable perfil row AFTER an upsert, re-read from the repository. The
 * upsert helper mints a candidate id for a new row, but Postgres' ON CONFLICT
 * (id_campanha) keeps the WINNER's id — a concurrent loser's returned object
 * carries a transient id that was never persisted. Only the re-read row's id
 * and atualizadoEm are used as the event's dedup key and time. Returns
 * undefined when the row cannot be read (event is then skipped).
 */
export async function fatoPerfilSalvo(
  repo: {
    findByIdCampanha(
      idCampanha: never,
    ): Promise<{ id: string; criadoEm: Date; atualizadoEm: Date } | undefined>;
  },
  idCampanha: string,
): Promise<{ insertKey: string; occurredAt: Date } | undefined> {
  try {
    const row = await repo.findByIdCampanha(idCampanha as never);
    if (!row) return undefined;
    return { insertKey: `${row.id}:${row.atualizadoEm.toISOString()}`, occurredAt: row.atualizadoEm };
  } catch {
    return undefined;
  }
}

export function propsConviteCriado(f: {
  readonly idCampanha: string;
  readonly idEvento: string;
  readonly modelo: string;
}): Record<string, unknown> {
  return { id_campanha: f.idCampanha, id_evento: f.idEvento, modelo: f.modelo };
}

export function propsConvidadoCriado(f: {
  readonly idCampanha: string;
  readonly idLista: string;
  readonly totalConvidados: number;
}): Record<string, unknown> {
  return { id_campanha: f.idCampanha, id_lista: f.idLista, total_convidados: f.totalConvidados };
}

/**
 * BetterAuth `users.created_at` for the account being provisioned — the
 * signup OCCURRENCE, as opposed to the lazy domain provisioning that emits
 * conta_criada. Read-only, guarded: any failure yields undefined and the
 * prop is simply omitted (analytics never fails a request).
 */
export async function lerSignupAt(
  db: ServerDeps['db'],
  idUsuario: string,
): Promise<Date | undefined> {
  try {
    const row = await db
      .selectFrom('users')
      .select('created_at')
      .where('id', '=', idUsuario)
      .executeTakeFirst();
    const at = row?.created_at;
    return at instanceof Date ? at : undefined;
  } catch {
    return undefined;
  }
}
