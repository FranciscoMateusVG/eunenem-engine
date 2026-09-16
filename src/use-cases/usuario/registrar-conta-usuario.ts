import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { RecebedorRepository } from '../../adapters/arrecadacao/recebedor-repository.js';
import type {
  CatalogoListaComItens,
  CatalogoRepository,
} from '../../adapters/catalogo/repository.js';
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
import { UsuarioEmailJaExisteError } from '../../errors/usuario/email-ja-existe.error.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import { UsuarioPlataformaNaoEncontradaError } from '../../errors/usuario/plataforma-nao-encontrada.error.js';
import { UsuarioSlugJaExisteError } from '../../errors/usuario/slug-ja-existe.error.js';
import type { Observability } from '../../observability/observability.js';
import { adicionarOpcaoContribuicao } from '../arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../arrecadacao/criar-campanha.js';
import {
  criarContribuicoesEmLote,
  type ItemLote,
  ItemLoteSchema,
} from '../arrecadacao/criar-contribuicoes-em-lote.js';

/**
 * Defensive cap on slug-collision retries (aperture-khbow). 50 is well past
 * any realistic congestion ("francisco", "francisco-2", … "francisco-50")
 * but bounded so a pathological loop can't run forever. If we ever hit it,
 * something is wrong with the derivation or the repo lookup.
 */
const MAX_SLUG_COLLISION_ATTEMPTS = 50;

const InitialCampaignItemsSchema = z.array(ItemLoteSchema).min(1).max(50);

export class InitialCampaignGiftTemplateInvalidError extends Error {
  readonly name = 'InitialCampaignGiftTemplateInvalidError';
}

export function prepareInitialCampaignTemplateItems(
  template: CatalogoListaComItens,
  isImageReadable: (value: string) => boolean,
): ItemLote[] {
  const grupo = template.lista.slug ?? template.lista.id;
  const candidate = template.itens.map(({ item, produto }) => ({
    nome: produto.nome,
    valor: produto.precoCents,
    imagemUrl: produto.imageUrl,
    grupo,
    quantidade: item.quantidade,
  }));
  const parsed = InitialCampaignItemsSchema.safeParse(candidate);
  const normalizedAnyField = parsed.success
    ? parsed.data.some((item, index) => {
        const source = candidate[index];
        return (
          !source ||
          item.nome !== source.nome ||
          item.valor !== source.valor ||
          item.imagemUrl !== source.imagemUrl ||
          item.grupo !== source.grupo ||
          item.quantidade !== source.quantidade
        );
      })
    : false;
  if (
    !parsed.success ||
    normalizedAnyField ||
    parsed.data.some(
      ({ imagemUrl }) => typeof imagemUrl === 'string' && !isImageReadable(imagemUrl),
    )
  ) {
    throw new InitialCampaignGiftTemplateInvalidError(
      'A lista padrão da campanha inicial possui itens inválidos.',
    );
  }
  return candidate;
}

async function resolveInitialCampaignTemplateItems(deps: {
  readonly catalogoRepository?: CatalogoRepository | undefined;
  readonly contribuicaoRepository?: ContribuicaoRepository | undefined;
  readonly catalogImageUrlReadable?: ((value: string) => boolean) | undefined;
}): Promise<ItemLote[]> {
  const { catalogoRepository, contribuicaoRepository, catalogImageUrlReadable } = deps;
  if (!catalogoRepository) return [];

  const configured = await catalogoRepository.findInitialCampaignTemplate();
  if (configured.status === 'invalid_config') {
    throw new InitialCampaignGiftTemplateInvalidError(
      'A lista padrão da campanha inicial está inválida.',
    );
  }
  if (configured.status === 'none') return [];
  if (!contribuicaoRepository || !catalogImageUrlReadable) {
    throw new InitialCampaignGiftTemplateInvalidError(
      'Dependências da lista padrão da campanha inicial indisponíveis.',
    );
  }
  return prepareInitialCampaignTemplateItems(configured.template, catalogImageUrlReadable);
}

async function saveRegistroWithUniqueSlug(input: {
  readonly usuarioRepository: UsuarioRepository;
  readonly usuario: Omit<Usuario, 'slug'>;
  readonly conta: Conta;
  readonly base: ReturnType<typeof deriveSlugBase>;
}): Promise<Usuario> {
  const { usuarioRepository, usuario: usuarioSemSlug, conta, base } = input;
  // Every attempt is one repository transaction. A typed slug collision rolls
  // the whole Usuario+Conta aggregate back before the next distinct candidate.
  for (let attempt = 1; attempt <= MAX_SLUG_COLLISION_ATTEMPTS; attempt++) {
    const slug = slugWithSuffix(base, attempt);
    if (await usuarioRepository.findUsuarioBySlug(usuarioSemSlug.idPlataforma, slug)) continue;

    const candidate: Usuario = { ...usuarioSemSlug, slug };
    try {
      await usuarioRepository.saveRegistroDomain({ usuario: candidate, conta });
      return candidate;
    } catch (error) {
      if (error instanceof UsuarioSlugJaExisteError) continue;
      throw error;
    }
  }
  throw new UsuarioInputInvalidoError(
    `Não foi possível gerar um slug único para "${base}" em ${MAX_SLUG_COLLISION_ATTEMPTS} tentativas`,
  );
}

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
  /** Optional only for backwards-compatible embedded consumers with no catalog. */
  readonly catalogoRepository?: CatalogoRepository | undefined;
  readonly contribuicaoRepository?: ContribuicaoRepository | undefined;
  readonly catalogImageUrlReadable?: ((value: string) => boolean) | undefined;
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
  readonly catalogoRepository?: CatalogoRepository | undefined;
  readonly contribuicaoRepository?: ContribuicaoRepository | undefined;
  readonly catalogImageUrlReadable?: ((value: string) => boolean) | undefined;
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
    catalogoRepository,
    contribuicaoRepository,
    catalogImageUrlReadable,
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
            catalogoRepository,
            contribuicaoRepository,
            catalogImageUrlReadable,
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
    catalogoRepository,
    contribuicaoRepository,
    catalogImageUrlReadable,
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

      // Resolve and validate one coherent catalogue snapshot BEFORE any
      // domain write. No configured marker intentionally preserves the
      // historical empty initial campaign. A configured-but-invalid marker
      // fails closed before Usuario/Conta/Campanha exist.
      const initialCampaignItems = await resolveInitialCampaignTemplateItems({
        catalogoRepository,
        contribuicaoRepository,
        catalogImageUrlReadable,
      });

      // step 2: derive slug. The bounded loop below treats availability reads
      // as an optimisation only; the UNIQUE constraint is the source of truth.
      const base = deriveSlugBase(data.nome);
      const conta: Conta = {
        id: idConta,
        idUsuario: data.idUsuario,
        permissoes: PERMISSOES_PADRAO,
        criadaEm: criadoEm,
      };

      // step 3: reserve one of at most 50 distinct candidates. Only a typed
      // slug collision advances the suffix; all other errors fail closed.
      const usuario = await saveRegistroWithUniqueSlug({
        usuarioRepository,
        base,
        conta,
        usuario: {
          id: data.idUsuario,
          idPlataforma: data.idPlataforma,
          idConta,
          email: data.email,
          nomeExibicao: data.nome,
          criadoEm,
          // Plan 0018 Phase A (aperture-omswg). Fresh registrations start
          // with `null` so the first-time tutorial overlay fires on first
          // visit.
          tutorialCompletadoEm: null,
          onboardingConcluidoEm: null,
        },
      });
      span.setAttribute('usuario.slug', usuario.slug);

      // Compensation exists only after the one successful aggregate write.
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

      // Final mutating step: one atomic bulk write. A failure reaches the
      // existing LIFO compensation, whose campanha delete cascades option
      // and contribution rows before Usuario/Conta are removed.
      if (initialCampaignItems.length > 0 && contribuicaoRepository) {
        await criarContribuicoesEmLote(
          { campanhaRepository, contribuicaoRepository, clock, observability },
          {
            idCampanha,
            idOpcaoContribuicao: idOpcao,
            items: initialCampaignItems,
          },
        );
      }

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
