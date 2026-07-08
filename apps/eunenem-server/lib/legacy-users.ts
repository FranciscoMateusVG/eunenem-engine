// aperture-mebax — Typed loader + matcher for the legacy EuNeném 1.0 user
// snapshot (multicampanha migration bridge POC, epic aperture-7hm2g).
//
// WHY: legacy (1.0) users must see their old campaign(s) on the new /campanhas
// page. Detection is a STATIC git-versioned snapshot (design spec §4 — no
// runtime query of the legacy PlanetScale DB): the server matches the
// authenticated user's email against `seed-data/legacy-1.0-users.json`.
//
// Follows the `lib/templates/index.ts` conventions:
//   - JSON imported at module evaluation (tsx evaluates server-side at boot;
//     esbuild would inline it into a client bundle — this module is only
//     imported server-side by the campanhas router).
//   - Shape validation runs ONCE at module evaluation and throws LOUD if the
//     JSON drifts (typo in a hand-edit, malformed entry in a future export).
//     The server crashes at boot rather than silently dropping legacy cards.
//
// POC seed: exactly one entry (the operator's email). The real 6-month legacy
// export drops in later at the same path with the same shape — NO code change
// (tracked as a separate bead; see spec §10).

import { readFileSync } from 'node:fs';
import { z } from 'zod/v4';
import legacyUsersJson from './seed-data/legacy-1.0-users.json';

/**
 * One object per LEGACY CAMPAIGN (spec §4). A user with several 1.0 campaigns
 * appears in multiple entries sharing the same email — the matcher returns
 * ALL of them.
 */
export const LegacyUserEntrySchema = z.object({
  /**
   * Match key against the authenticated user's email (case-insensitive).
   * `.trim()` BEFORE `.min(1)` so a whitespace-only email in a future export
   * row dies at module load instead of becoming a match-anything entry
   * (Izzy adversarial item #1 — belt; the matcher's empty-query short-circuit
   * is the suspenders).
   */
  email: z.string().trim().min(1, 'legacy entry email must be non-empty'),
  /**
   * Legacy campaign slug (`persons.utm`) for a future deep-link
   * (`https://eunenem.com/{utm}`). UNUSED by the POC redirect, which goes to
   * `/minha-area` (Clerk resolves the user by email — spec §5).
   */
  utm: z.string().min(1).nullable().optional().default(null),
  /** Card title. Server-side fallback applied when absent (see DTO below). */
  nome: z.string().min(1).nullable().optional().default(null),
  /** Mimo count for the card. `null` → the card hides the count. */
  mimos: z.number().int().nonnegative().nullable().optional().default(null),
});

export type LegacyUserEntry = z.infer<typeof LegacyUserEntrySchema>;

/**
 * Card DTO for a matched legacy campaign — the `legado[]` element of the
 * `campanhas.list` contract (frozen on epic aperture-7hm2g notes).
 * `nome` is NEVER empty: the generic-label fallback is applied HERE,
 * server-side, so the frontend never invents copy.
 */
export interface CampanhaLegadoDTO {
  readonly email: string;
  readonly nome: string;
  readonly utm: string | null;
  readonly mimos: number | null;
}

/** Generic card title when the snapshot entry carries no `nome` (spec §4). */
export const NOME_FALLBACK_LEGADO = 'Minha lista (EuNeném 1.0)';

/**
 * Load + validate the legacy-user snapshot (aperture-op09b / 791lz).
 *
 * The REAL customer list can't be committed — the Dokploy deploy mirror is
 * PUBLIC. So the real file is mounted at runtime OUTSIDE the git tree (Cipher
 * ses0u condition: a path outside `/app` so a Dockerfile `COPY` can never bake
 * it) and its path is passed via `LEGACY_USERS_PATH`:
 *   - LEGACY_USERS_PATH set + non-empty → read + Zod-validate THAT file.
 *   - unset / empty → the committed 1-email stub (unchanged; stays a stub
 *     forever — the PR carries zero real data).
 * SAME shape validation both ways.
 *
 * FAIL-LOUD by design: a missing / unreadable / invalid-JSON / shape-drifted
 * file throws HERE, at module load → the server crashes at boot (Peppy verifies
 * post-deploy) rather than silently serving the stub or an empty list. We keep
 * the DEFAULT ZodError (no custom handler that could dump row VALUES into logs)
 * and never log the parsed list — it's customer PII.
 *
 * `env` is injectable for tests; the module-level `LEGACY_USERS_SEED` calls it
 * with the real `process.env` once at import.
 */
export function carregarLegacyUsersSeed(
  env: NodeJS.ProcessEnv = process.env,
): readonly LegacyUserEntry[] {
  const path = env.LEGACY_USERS_PATH?.trim();
  // Server-controlled path (Dokploy env), never user input → no traversal risk.
  const raw: unknown = path ? lerArquivoLegacy(path) : legacyUsersJson;
  // Zod validation is PII-safe (default errors carry the field PATH, not the
  // row VALUE) — kept loud on both branches.
  return z.array(LegacyUserEntrySchema).parse(raw);
}

/**
 * Read + JSON-parse the mounted legacy file, re-throwing a SANITIZED error
 * (Cipher ses0u residual). A raw `JSON.parse` SyntaxError on a malformed REAL
 * export can embed a ~10-char snippet of the bad region (Node/V8) — potentially
 * a PII fragment of an email/name — which would land in the boot-crash log →
 * Loki. In the exact feature built to keep customer PII out of the repo AND
 * logs, we surface only the path + error code (fs errors carry `.code`;
 * JSON.parse has none → 'PARSE_ERROR'), never the file contents. Stays
 * fail-loud (throws → boot crash → Peppy's deploy verify catches it).
 */
function lerArquivoLegacy(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const code =
      typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'PARSE_ERROR';
    throw new Error(`legacy-users: failed to load ${path} (${code})`);
  }
}

/**
 * The validated snapshot, resolved once at import. Malformed source (committed
 * stub OR the runtime-mounted real file) crashes the server AT BOOT — never a
 * silently-missing 1.0 card in prod.
 */
export const LEGACY_USERS_SEED: readonly LegacyUserEntry[] = carregarLegacyUsersSeed();

/**
 * Normalize an email for matching: trim + default-locale `toLowerCase()`.
 * Deliberately NO locale argument — deterministic default Unicode lowering
 * across runtimes (declared to Izzy for the adversarial-edge suite; a
 * Turkish dotted-İ folds per the default algorithm and we accept that).
 */
function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * PURE matcher: all legacy campaigns whose `email` matches the given one
 * case-insensitively. `entries` is injectable for tests (defaults to the
 * validated snapshot); returns `CampanhaLegadoDTO`s with the `nome` fallback
 * already applied.
 */
export function buscarCampanhasLegado(
  email: string,
  entries: readonly LegacyUserEntry[] = LEGACY_USERS_SEED,
): readonly CampanhaLegadoDTO[] {
  const alvo = normalizarEmail(email);
  // Empty-after-trim query NEVER matches (even a malformed whitespace-only
  // entry that slipped past schema validation via test injection) — one bad
  // export row must not match every anonymous-ish caller (Izzy item #1).
  if (alvo.length === 0) return [];
  return entries
    .filter((entry) => normalizarEmail(entry.email) === alvo)
    .map((entry) => ({
      email: entry.email,
      // Fallback covers absent AND present-but-blank (nome: '' or whitespace
      // only) — an export row with an empty title must not render an empty
      // card (Izzy item #2). NOTE: `?? / ||` would miss whitespace-only.
      nome:
        entry.nome !== null && entry.nome.trim().length > 0
          ? entry.nome
          : NOME_FALLBACK_LEGADO,
      // Direct passthrough — deliberately NOT `|| null`: mimos of 0 is a real
      // count and must survive as 0 (falsy-zero trap).
      utm: entry.utm,
      mimos: entry.mimos,
    }));
}
