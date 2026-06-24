import { z } from 'zod/v4';

/**
 * Value object: the user's public URL-segment slug (e.g. /painel/helena).
 *
 * Constraints (aperture-khbow):
 *   - Lowercase only
 *   - 3-30 characters
 *   - Alphanumeric + hyphens
 *   - MUST start with a letter (no leading digit/hyphen; avoids slugs that
 *     look like ids or that path-collide with future reserved prefixes)
 *
 * Uniqueness is composite `(idPlataforma, slug)`, enforced at the repository
 * layer — same multi-tenancy boundary as email. The same slug can exist on
 * eunenem AND eucasei without collision.
 */
export const SLUG_USUARIO_REGEX = /^[a-z][a-z0-9-]{2,29}$/;

/**
 * Reserved path-words a vanity slug MUST NOT claim (aperture-vd1do).
 *
 * A user-chosen slug becomes a public URL segment (`/painel/<slug>`,
 * `/pagina/<slug>`). If we let someone register a slug that equals a
 * top-level app route, their page would path-collide with that route. The
 * picker would happily hand out e.g. `admin` or `api` and then `/pagina/api`
 * (and worse, any future bare `/admin` reuse) becomes ambiguous.
 *
 * The set has two parts:
 *   1. REAL top-level route segments grepped from the SSR router
 *      (apps/eunenem-server/server.tsx + pages/App.tsx resolveRoute):
 *        api, public, products, listas-prontas, healthz, admin, pagina,
 *        painel, trpc-smoke, auth-demo, webhooks
 *   2. Standard reserved words / likely-future segments (auth flows, marketing,
 *      infra, JS literals) kept defensively so the namespace stays clean even
 *      before those routes exist.
 *
 * Entries are all lowercase; the schema lowercase-normalises nothing itself
 * (the regex already forbids uppercase), so callers compare the trimmed value
 * directly. Matching is exact (whole-slug), not prefix — `apize` is fine,
 * `api` is not.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // --- real top-level routes (grepped from the SSR router) ---
  'api',
  'public',
  'products',
  'listas-prontas',
  'healthz',
  'admin',
  'pagina',
  'painel',
  'trpc-smoke',
  'auth-demo',
  'webhooks',
  // --- standard reserved words + likely-future segments ---
  'health',
  'paginas',
  'sucesso',
  'auth',
  'login',
  'logout',
  'signup',
  'signin',
  'sign-in',
  'sign-up',
  'cadastro',
  'entrar',
  'app',
  'www',
  'static',
  'assets',
  'favicon',
  'robots',
  'sitemap',
  '_next',
  'next',
  'checkout',
  'pagamento',
  'pagamentos',
  'recebedor',
  'contribuicao',
  'me',
  'conta',
  'config',
  'configuracoes',
  'settings',
  'dashboard',
  'onboarding',
  'null',
  'undefined',
  'true',
  'false',
  'root',
  'support',
  'ajuda',
  'sobre',
  'termos',
  'privacidade',
]);

export const SlugUsuarioSchema = z
  .string()
  .trim()
  .regex(
    SLUG_USUARIO_REGEX,
    'Slug deve ter 3-30 caracteres, começar com letra, conter apenas letras minúsculas, dígitos ou hífens',
  )
  // Reserved-words denylist (aperture-vd1do). Runs AFTER the regex: a value
  // that reaches here is already trimmed + lowercase + regex-valid, so an
  // exact membership check is sufficient.
  .refine((value) => !RESERVED_SLUGS.has(value), {
    message: 'Esse endereço é reservado e não pode ser usado',
  });

export type SlugUsuario = z.infer<typeof SlugUsuarioSchema>;
