import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { RecebedorRepository } from '../../adapters/arrecadacao/recebedor-repository.js';
import type { PlataformaRepository } from '../../adapters/plataforma/repository.js';
import type { AuthService } from '../../adapters/usuario/auth-service.js';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { Campanha } from '../../domain/arrecadacao/entities/campanha.js';
import type {
  IdCampanha,
  IdOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { Conta, Usuario } from '../../domain/usuario/entities/usuario.js';
import { deriveSlugBase, slugWithSuffix } from '../../domain/usuario/slug-derivation.js';
import { EmailUsuarioSchema } from '../../domain/usuario/value-objects/email-usuario.js';
import type { IdContaUsuario } from '../../domain/usuario/value-objects/ids.js';
import {
  IdContaUsuarioSchema,
  IdPlataformaReferenciaSchema,
  IdUsuarioSchema,
} from '../../domain/usuario/value-objects/ids.js';
import { NomeExibicaoUsuarioSchema } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import { PERMISSOES_PADRAO } from '../../domain/usuario/value-objects/permissao.js';
import type { SlugUsuario } from '../../domain/usuario/value-objects/slug-usuario.js';
import { UsuarioEmailJaExisteError } from '../../errors/usuario/email-ja-existe.error.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import { UsuarioPlataformaNaoEncontradaError } from '../../errors/usuario/plataforma-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';
import { adicionarOpcaoContribuicao } from '../arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../arrecadacao/criar-campanha.js';

/**
 * Defensive cap on slug-collision retries (aperture-khbow). 50 is well past
 * any realistic congestion ("francisco", "francisco-2", … "francisco-50")
 * but bounded so a pathological loop can't run forever. If we ever hit it,
 * something is wrong with the derivation or the repo lookup.
 */
const MAX_SLUG_COLLISION_ATTEMPTS = 50;

export const RegistrarContaUsuarioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  idPlataforma: IdPlataformaReferenciaSchema,
  idConta: IdContaUsuarioSchema,
  email: EmailUsuarioSchema,
  nomeExibicao: NomeExibicaoUsuarioSchema,
  /**
   * Plain-text password. Forwarded directly to `AuthService.criarConta`.
   * The field name stays `senhaSimulada` for backward compatibility with
   * existing consumers (integration tests, examples) — the "simulated" vs
   * "real" choice is now an adapter-level decision, not a use-case one.
   */
  senhaSimulada: z.string().min(1, 'Senha nao pode ser vazia').max(200, 'Senha e longa demais'),
});

export type RegistrarContaUsuarioInput = z.infer<typeof RegistrarContaUsuarioInputSchema>;

/**
 * Input for the EXTRACTED domain-only provisioning step
 * (`provisionarContaUsuarioDominio`, aperture-6wo1f). Everything the saga
 * needs to build the domain Usuario aggregate + default Campanha, but NOT
 * the auth credential — the auth principal is owned by the caller
 * (email+password: `AuthService.criarConta`; OAuth: BetterAuth's native
 * adapter create). `idConta` is OPTIONAL: the email+password saga supplies
 * its caller-controlled UUID for backward-compat; the OAuth self-heal omits
 * it and lets the provisioner mint one (consistent with Campanha/Opcao ids,
 * which are generated here).
 */
export const ProvisionarContaUsuarioDominioInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
  idPlataforma: IdPlataformaReferenciaSchema,
  email: EmailUsuarioSchema,
  nome: NomeExibicaoUsuarioSchema,
  idConta: IdContaUsuarioSchema.optional(),
});

export type ProvisionarContaUsuarioDominioInput = z.infer<
  typeof ProvisionarContaUsuarioDominioInputSchema
>;

/**
 * Deps for the extracted domain provisioner. Strict subset of
 * `RegistrarContaUsuarioDeps` — NO `authService` (the auth side is the
 * caller's responsibility), so the self-heal path can reuse the exact
 * domain logic without dragging in the BetterAuth adapter.
 */
export interface ProvisionarContaUsuarioDominioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly plataformaRepository: PlataformaRepository;
  readonly campanhaRepository: CampanhaRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly clock: () => Date;
  /** Optional override for deterministic id generation in tests. */
  readonly gerarIdConta?: () => IdContaUsuario;
  /** Optional override for deterministic id generation in tests. */
  readonly gerarIdCampanha?: () => IdCampanha;
  /** Optional override for deterministic id generation in tests. */
  readonly gerarIdOpcao?: () => IdOpcaoContribuicao;
  readonly observability: Observability;
}

export interface RegistrarContaUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly plataformaRepository: PlataformaRepository;
  readonly campanhaRepository: CampanhaRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly authService: AuthService;
  readonly clock: () => Date;
  /** Optional override for deterministic id generation in tests. */
  readonly gerarIdCampanha?: () => IdCampanha;
  /** Optional override for deterministic id generation in tests. */
  readonly gerarIdOpcao?: () => IdOpcaoContribuicao;
  readonly observability: Observability;
}

export interface RegistrarContaUsuarioResult {
  readonly usuario: Usuario;
  readonly conta: Conta;
  /**
   * The default "Lista de presentes" Campanha auto-created for this user
   * (aperture-p8i01). Always present post-saga — every new user owns
   * exactly one campanha with one OpcaoContribuicao of tipo 'presente'.
   * Recebedor is null at creation; the user adds bank info later through
   * a separate flow.
   */
  readonly campanha: Campanha;
}

/**
 * Regista utilizador, conta administrativa (1:1), perfil inicial,
 * credencial via `AuthService`, e a Campanha padrão "Lista de <nome>"
 * com uma OpcaoContribuicao do tipo 'presente'. Escopado à plataforma
 * informada.
 *
 * **Saga shape** (aperture-ibbet + aperture-p8i01 — bakes the T3
 * compensation discipline from monorepo-incluir's BetterAuth prod usage,
 * see recon aperture-q2i8l §8 #3): BetterAuth's connection commits on
 * its own outside any wrapping Kysely transaction. The only safe undo
 * path is compensation. We honor that discipline ACROSS all five mutating
 * steps via a LIFO compensation list — each successful step pushes its
 * own undo onto the list; any subsequent failure walks the list in
 * reverse and runs every undo (best-effort, logged-but-not-rethrown).
 *
 * Flow:
 *   1. Validate input + plataforma exists.
 *   2. **Pre-check** `findUsuarioByEmail(idPlataforma, email)` — if a
 *      domain Usuario already exists for the composite key, throw
 *      `UsuarioEmailJaExisteError` BEFORE touching the auth side. Spares
 *      the auth adapter a doomed write + compensation cycle.
 *   3. `authService.criarConta(...)` → push undo: `authService.removerConta`
 *   4. `usuarioRepository.saveRegistroDomain(...)` → push undo:
 *      `usuarioRepository.removeRegistroDomain`
 *   5. `criarCampanha(...)` (no Recebedor — user has no PIX yet) → push
 *      undo: `campanhaRepository.delete`
 *   6. `adicionarOpcaoContribuicao(... 'presente' ...)` — no separate
 *      undo needed because step 5's delete cascades to opcoes_contribuicao
 *      via the FK ON DELETE CASCADE (migration 001).
 *
 * Any failure at step 4, 5, or 6 walks the compensation list in LIFO
 * order so the system never ends up with an auth principal lacking a
 * domain Usuario, or a domain Usuario lacking a Campanha.
 *
 * Email é único por `(idPlataforma, email)` — a mesma pessoa pode
 * registrar em eunenem e eucasei como contas separadas.
 */
export async function registrarContaUsuario(
  deps: RegistrarContaUsuarioDeps,
  input: RegistrarContaUsuarioInput,
): Promise<RegistrarContaUsuarioResult> {
  const {
    usuarioRepository,
    plataformaRepository,
    campanhaRepository,
    recebedorRepository,
    authService,
    clock,
    gerarIdCampanha = randomUUID,
    gerarIdOpcao = randomUUID,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('registrarContaUsuario', async (span) => {
    try {
      const parsed = RegistrarContaUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const data = parsed.data;

      span.setAttribute('usuario.id', data.idUsuario);
      span.setAttribute('usuario.plataforma.id', data.idPlataforma);
      span.setAttribute('usuario.conta.id', data.idConta);
      span.setAttribute('usuario.email.length', data.email.length);

      // step 1: plataforma must exist (BEFORE the auth-side write — spares
      // the auth adapter a doomed write + compensation cycle on a bad tenant).
      const plataforma = await plataformaRepository.findById(data.idPlataforma);
      if (!plataforma) {
        throw new UsuarioPlataformaNaoEncontradaError(data.idPlataforma);
      }

      // step 2: composite-uniqueness pre-check (also BEFORE auth — same
      // doomed-write rationale).
      const existing = await usuarioRepository.findUsuarioByEmail(data.idPlataforma, data.email);
      if (existing) {
        throw new UsuarioEmailJaExisteError(data.email);
      }

      // step 3: auth principal (BetterAuth-side, can NOT be rolled back via tx).
      // The domain side is delegated to provisionarContaUsuarioDominio below;
      // if THAT throws, we run the auth compensation here (LIFO across the
      // two layers: auth undo wraps the domain provisioning, whose OWN
      // internal compensations have already unwound by the time it rethrows).
      await authService.criarConta({
        idUsuario: data.idUsuario,
        idPlataforma: data.idPlataforma,
        email: data.email,
        senha: data.senhaSimulada,
        nome: data.nomeExibicao,
      });

      let resultado: RegistrarContaUsuarioResult;
      try {
        // EXTRACTED domain side (aperture-6wo1f). Identical sequence the saga
        // ran inline before the extraction — Usuario + Conta + default
        // Campanha + 'presente' opcao, with its own LIFO compensation. The
        // caller-supplied idConta is passed through so the email+password
        // behavior is UNCHANGED. The plataforma-exists check inside the
        // provisioner re-confirms the tenant; it's a cheap idempotent read.
        resultado = await provisionarContaUsuarioDominio(
          {
            usuarioRepository,
            plataformaRepository,
            campanhaRepository,
            recebedorRepository,
            clock,
            gerarIdCampanha,
            gerarIdOpcao,
            observability,
          },
          {
            idUsuario: data.idUsuario,
            idPlataforma: data.idPlataforma,
            email: data.email,
            nome: data.nomeExibicao,
            idConta: data.idConta,
          },
        );
      } catch (domainError) {
        // Domain provisioning failed AFTER the auth principal was created.
        // Compensate the auth-side write (best-effort, logged, never
        // rethrown — the ORIGINAL domain error is what the caller sees).
        try {
          await authService.removerConta(data.idUsuario);
          logger.info('usuario.conta.compensacao_executada', {
            etapa: 'authService.removerConta',
            erroOriginal: (domainError as Error).message,
          });
        } catch (compensationError) {
          logger.info('usuario.conta.compensacao_falhou', {
            etapa: 'authService.removerConta',
            erroOriginal: (domainError as Error).message,
            erroCompensacao: (compensationError as Error).message,
          });
        }
        throw domainError;
      }

      logger.info('usuario.conta.registrada', {
        idUsuario: resultado.usuario.id,
        idPlataforma: resultado.usuario.idPlataforma,
        idConta: resultado.conta.id,
        slug: resultado.usuario.slug,
        idCampanha: resultado.campanha.id,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return resultado;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * **EXTRACTED domain-only provisioning** (aperture-6wo1f — reuse-not-
 * reimplement). The domain side of `registrarContaUsuario` lifted verbatim
 * so TWO callers share ONE source of truth:
 *
 *   1. `registrarContaUsuario` (email+password) — calls `criarConta` THEN
 *      this function. Behavior is unchanged: it passes its caller-controlled
 *      `idConta` through and the same PERMISSOES_PADRAO / Campanha / 'presente'
 *      opcao are written.
 *   2. The eunenem-server `me`-resolver self-heal (OAuth) — when a session
 *      resolves to a BetterAuth user that has NO domain `usuarios` row (the
 *      `signup_collision`/oss3g orphan: OAuth's native create writes only
 *      BetterAuth's users/sessions/accounts, never the engine domain rows),
 *      it calls THIS function to idempotently provision the missing domain
 *      side. The auth principal already exists (BetterAuth created it), so
 *      this function NEVER touches `AuthService` — that is the caller's
 *      responsibility, which is exactly why it was extracted out.
 *
 * **What it does NOT do** (vs the full saga): no `authService.criarConta`
 * and no auth compensation. The auth principal is the caller's concern.
 *
 * **Tenancy (Cipher constraint #1)**: `idPlataforma` is passed in by the
 * caller and written verbatim onto BOTH `usuarios.id_plataforma` and the
 * Campanha. The OAuth caller MUST pass the RESOLVED SESSION USER's
 * `idPlataforma` (BetterAuth `users.id_plataforma`, the server constant set
 * by the dm7s3 hook) — NEVER a value derived from the Google profile or any
 * request input.
 *
 * **Least-privilege (Cipher constraint #2)**: PERMISSOES_PADRAO — identical
 * to the saga, guaranteed by this being the single shared definition.
 *
 * **Idempotency / unique-backstop (Cipher constraint #4)**: this function
 * does NOT pre-decide whether the usuario exists; it always attempts the
 * insert. `saveRegistroDomain` maps the `(id_plataforma, email)` UNIQUE
 * violation to `UsuarioEmailJaExisteError`. The self-heal caller catches
 * THAT typed error and re-reads (handling the concurrent-double-provision
 * race). The function's own internal LIFO compensation unwinds any partial
 * domain writes on a DOWNSTREAM (campanha/opcao) failure before rethrowing,
 * so a thrown error never leaves a half-provisioned domain aggregate.
 */
export async function provisionarContaUsuarioDominio(
  deps: ProvisionarContaUsuarioDominioDeps,
  input: ProvisionarContaUsuarioDominioInput,
): Promise<RegistrarContaUsuarioResult> {
  const {
    usuarioRepository,
    plataformaRepository,
    campanhaRepository,
    recebedorRepository,
    clock,
    gerarIdConta = randomUUID,
    gerarIdCampanha = randomUUID,
    gerarIdOpcao = randomUUID,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('provisionarContaUsuarioDominio', async (span) => {
    /**
     * LIFO compensation list — scoped to the DOMAIN steps only (no auth).
     * Each successful mutating step pushes its own undo; any subsequent
     * failure walks the list in reverse, best-effort (logged, not rethrown).
     */
    const compensations: Array<{
      readonly label: string;
      readonly undo: () => Promise<void>;
    }> = [];

    const runCompensations = async (originalError: Error): Promise<void> => {
      for (const { label, undo } of [...compensations].reverse()) {
        try {
          await undo();
          logger.info('usuario.conta.compensacao_executada', {
            etapa: label,
            erroOriginal: originalError.message,
          });
        } catch (compensationError) {
          logger.info('usuario.conta.compensacao_falhou', {
            etapa: label,
            erroOriginal: originalError.message,
            erroCompensacao: (compensationError as Error).message,
          });
        }
      }
    };

    try {
      const parsed = ProvisionarContaUsuarioDominioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const data = parsed.data;
      const idConta = data.idConta ?? gerarIdConta();
      const criadoEm = clock();

      span.setAttribute('usuario.id', data.idUsuario);
      span.setAttribute('usuario.plataforma.id', data.idPlataforma);
      span.setAttribute('usuario.conta.id', idConta);
      span.setAttribute('usuario.email.length', data.email.length);

      // step 1: plataforma must exist
      const plataforma = await plataformaRepository.findById(data.idPlataforma);
      if (!plataforma) {
        throw new UsuarioPlataformaNaoEncontradaError(data.idPlataforma);
      }

      // step 2: derive slug + walk suffix collisions within the plataforma
      // (aperture-khbow). Pre-check is best-effort — a concurrent race could
      // still slip through, in which case the Postgres unique constraint
      // raises UsuarioSlugJaExisteError and the caller can retry.
      const base = deriveSlugBase(data.nome);
      const slug = await resolveSlugInPlataforma(usuarioRepository, data.idPlataforma, base);
      span.setAttribute('usuario.slug', slug);

      // step 3: domain aggregate
      const usuario: Usuario = {
        id: data.idUsuario,
        idPlataforma: data.idPlataforma,
        idConta,
        email: data.email,
        nomeExibicao: data.nome,
        slug,
        criadoEm,
        // Plan 0018 Phase A (aperture-omswg). Fresh registrations start
        // with `null` so the first-time tutorial overlay fires on first
        // visit.
        tutorialCompletadoEm: null,
        onboardingConcluidoEm: null,
      };

      const conta: Conta = {
        id: idConta,
        idUsuario: data.idUsuario,
        permissoes: PERMISSOES_PADRAO,
        criadaEm: criadoEm,
      };

      // saveRegistroDomain maps the (id_plataforma, email) UNIQUE violation
      // to UsuarioEmailJaExisteError — the typed backstop the self-heal
      // caller catches to win the concurrent-double-provision race
      // (Cipher constraint #4). No compensation is pushed for a FAILED
      // insert (nothing was written); the undo is only registered after a
      // SUCCESSFUL write.
      await usuarioRepository.saveRegistroDomain({ usuario, conta });
      compensations.push({
        label: 'usuarioRepository.removeRegistroDomain',
        undo: () => usuarioRepository.removeRegistroDomain(data.idUsuario),
      });

      // step 4: default Campanha (no Recebedor — user has no PIX at signup)
      const idCampanha = gerarIdCampanha();
      const titulo = construirTituloListaPadrao(data.nome);
      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.campanha.titulo.length', titulo.length);

      // criarCampanha writes the campanha row with empty opcoes; the
      // intermediate return value is discarded because step 5 immediately
      // re-saves the same campanha with the initial opcao appended.
      await criarCampanha(
        {
          campanhaRepository,
          recebedorRepository,
          plataformaRepository,
          clock,
          observability,
        },
        {
          id: idCampanha,
          idPlataforma: data.idPlataforma,
          idsAdministradores: [idConta],
          titulo,
          // No dadosRecebedor — see aperture-66klh: campanha can exist
          // without bank info; only withdrawal use-case gates on presence.
        },
      );
      compensations.push({
        label: 'campanhaRepository.delete',
        undo: () => campanhaRepository.delete(idCampanha),
      });

      // step 5: initial 'presente' OpcaoContribuicao. NO separate
      // compensation — step 4's campanhaRepository.delete cascades to
      // opcoes_contribuicao via the FK ON DELETE CASCADE (migration 001).
      const idOpcao = gerarIdOpcao();
      span.setAttribute('arrecadacao.opcao.id', idOpcao);

      const campanhaComOpcao = await adicionarOpcaoContribuicao(
        { campanhaRepository, observability },
        { idCampanha, idOpcao, tipo: 'presente' },
      );

      span.setStatus({ code: SpanStatusCode.OK });
      return { usuario, conta, campanha: campanhaComOpcao };
    } catch (error) {
      // Compensation path. Best-effort — runCompensations logs failures
      // but never throws; the ORIGINAL error is what propagates.
      await runCompensations(error as Error);

      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Constrói o título padrão da lista de presentes para um novo usuário.
 * Formato: "Lista de <nomeExibicao>". Truncado para caber no limite
 * do schema (200 chars — ver criar-campanha.ts).
 *
 * Exportado para reuso pelo script de backfill p8i01
 * (`scripts/p8i01-backfill-campanhas.ts`), que precisa produzir o
 * mesmo título para usuários pré-saga. Mantém uma única fonte de
 * verdade da regra de formatação.
 */
export function construirTituloListaPadrao(nomeExibicao: string): string {
  const prefix = 'Lista de ';
  const MAX = 200;
  const orcamento = MAX - prefix.length;
  const nomeAjustado =
    nomeExibicao.length > orcamento
      ? `${nomeExibicao.slice(0, orcamento - 1).trimEnd()}…`
      : nomeExibicao;
  return `${prefix}${nomeAjustado}`;
}

/**
 * Walk `base`, `base-2`, `base-3`… within `idPlataforma` until
 * `findUsuarioBySlug` returns undefined. Pre-check only — the eventual
 * `saveRegistroDomain` still relies on the Postgres unique constraint as
 * the source of truth in case a concurrent register raced us.
 */
async function resolveSlugInPlataforma(
  repo: UsuarioRepository,
  idPlataforma: string,
  base: SlugUsuario,
): Promise<SlugUsuario> {
  for (let attempt = 1; attempt <= MAX_SLUG_COLLISION_ATTEMPTS; attempt++) {
    const candidate = slugWithSuffix(base, attempt);
    const taken = await repo.findUsuarioBySlug(idPlataforma, candidate);
    if (!taken) return candidate;
  }
  throw new UsuarioInputInvalidoError(
    `Não foi possível gerar um slug único para "${base}" em ${MAX_SLUG_COLLISION_ATTEMPTS} tentativas`,
  );
}
