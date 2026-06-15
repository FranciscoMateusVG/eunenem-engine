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
    /**
     * LIFO compensation list. Each successful mutating step pushes its
     * own undo. On any subsequent failure we walk this list in reverse
     * and execute each entry best-effort (errors logged, not rethrown —
     * the ORIGINAL failure is what the caller sees).
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
      const parsed = RegistrarContaUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const data = parsed.data;
      const criadoEm = clock();

      span.setAttribute('usuario.id', data.idUsuario);
      span.setAttribute('usuario.plataforma.id', data.idPlataforma);
      span.setAttribute('usuario.conta.id', data.idConta);
      span.setAttribute('usuario.email.length', data.email.length);

      // step 1: plataforma must exist
      const plataforma = await plataformaRepository.findById(data.idPlataforma);
      if (!plataforma) {
        throw new UsuarioPlataformaNaoEncontradaError(data.idPlataforma);
      }

      // step 2: composite-uniqueness pre-check
      const existing = await usuarioRepository.findUsuarioByEmail(data.idPlataforma, data.email);
      if (existing) {
        throw new UsuarioEmailJaExisteError(data.email);
      }

      // step 2b: derive slug + walk suffix collisions within the plataforma
      // (aperture-khbow). Pre-check is best-effort — a concurrent race could
      // still slip through, in which case the Postgres unique constraint
      // raises UsuarioSlugJaExisteError and the caller can retry.
      const base = deriveSlugBase(data.nomeExibicao);
      const slug = await resolveSlugInPlataforma(usuarioRepository, data.idPlataforma, base);
      span.setAttribute('usuario.slug', slug);

      // step 3: auth principal (BetterAuth-side, can NOT be rolled back via tx)
      await authService.criarConta({
        idUsuario: data.idUsuario,
        idPlataforma: data.idPlataforma,
        email: data.email,
        senha: data.senhaSimulada,
        nome: data.nomeExibicao,
      });
      compensations.push({
        label: 'authService.removerConta',
        undo: () => authService.removerConta(data.idUsuario),
      });

      // step 4: domain aggregate
      const usuario: Usuario = {
        id: data.idUsuario,
        idPlataforma: data.idPlataforma,
        idConta: data.idConta,
        email: data.email,
        nomeExibicao: data.nomeExibicao,
        slug,
        criadoEm,
        // Plan 0018 Phase A (aperture-omswg). Fresh registrations start
        // with `null` so the first-time tutorial overlay fires on first
        // visit.
        tutorialCompletadoEm: null,
      };

      const conta: Conta = {
        id: data.idConta,
        idUsuario: data.idUsuario,
        permissoes: PERMISSOES_PADRAO,
        criadaEm: criadoEm,
      };

      await usuarioRepository.saveRegistroDomain({ usuario, conta });
      compensations.push({
        label: 'usuarioRepository.removeRegistroDomain',
        undo: () => usuarioRepository.removeRegistroDomain(data.idUsuario),
      });

      // step 5: default Campanha (no Recebedor — user has no PIX at signup)
      const idCampanha = gerarIdCampanha();
      const titulo = construirTituloListaPadrao(data.nomeExibicao);
      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.campanha.titulo.length', titulo.length);

      // criarCampanha writes the campanha row with empty opcoes; the
      // intermediate return value is discarded because step 6 immediately
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
          idsAdministradores: [data.idConta],
          titulo,
          // No dadosRecebedor — see aperture-66klh: campanha can exist
          // without bank info; only withdrawal use-case gates on presence.
        },
      );
      compensations.push({
        label: 'campanhaRepository.delete',
        undo: () => campanhaRepository.delete(idCampanha),
      });

      // step 6: initial 'presente' OpcaoContribuicao. NO separate
      // compensation — step 5's campanhaRepository.delete cascades to
      // opcoes_contribuicao via the FK ON DELETE CASCADE (migration 001).
      const idOpcao = gerarIdOpcao();
      span.setAttribute('arrecadacao.opcao.id', idOpcao);

      const campanhaComOpcao = await adicionarOpcaoContribuicao(
        { campanhaRepository, observability },
        { idCampanha, idOpcao, tipo: 'presente' },
      );

      logger.info('usuario.conta.registrada', {
        idUsuario: usuario.id,
        idPlataforma: usuario.idPlataforma,
        idConta: conta.id,
        slug: usuario.slug,
        idCampanha: campanhaComOpcao.id,
        idOpcao,
      });

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
