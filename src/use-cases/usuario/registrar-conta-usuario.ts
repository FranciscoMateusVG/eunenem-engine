import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { PlataformaRepository } from '../../adapters/plataforma/repository.js';
import type { AuthService } from '../../adapters/usuario/auth-service.js';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { Conta, Usuario } from '../../domain/usuario/entities/usuario.js';
import { EmailUsuarioSchema } from '../../domain/usuario/value-objects/email-usuario.js';
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
import type { Observability } from '../../observability/observability.js';

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
  readonly authService: AuthService;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface RegistrarContaUsuarioResult {
  readonly usuario: Usuario;
  readonly conta: Conta;
}

/**
 * Regista utilizador, conta administrativa (1:1), perfil inicial e
 * credencial via `AuthService`, escopado à plataforma informada.
 *
 * **Saga shape** (aperture-ibbet — bakes the T3 compensation discipline
 * from monorepo-incluir's BetterAuth prod usage, see recon aperture-q2i8l
 * §8 #3): BetterAuth-future adapter writes commit on their own connection,
 * outside any wrapping Kysely transaction. The only safe undo path is
 * compensation. We honor that discipline NOW with the in-memory adapter
 * so the choreography is correct from day one — when bead 3 swaps in
 * `AuthServiceBetterAuth`, this use-case does not need to change.
 *
 * Flow:
 *   1. Validate input + plataforma exists.
 *   2. **Pre-check** `findUsuarioByEmail(idPlataforma, email)` — if a
 *      domain Usuario already exists for the composite key, throw
 *      `UsuarioEmailJaExisteError` BEFORE touching the auth side. Spares
 *      the auth adapter a doomed write + compensation cycle.
 *   3. `authService.criarConta(...)` — creates the auth principal.
 *   4. Try `usuarioRepository.saveRegistroDomain(...)` — writes the
 *      domain aggregate.
 *   5. On (4) failure: `authService.removerConta(idUsuario)` to undo (3),
 *      then rethrow the domain error.
 *
 * Email é único por `(idPlataforma, email)` — a mesma pessoa pode
 * registrar em eunenem e eucasei como contas separadas.
 */
export async function registrarContaUsuario(
  deps: RegistrarContaUsuarioDeps,
  input: RegistrarContaUsuarioInput,
): Promise<RegistrarContaUsuarioResult> {
  const { usuarioRepository, plataformaRepository, authService, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('registrarContaUsuario', async (span) => {
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

      // step 3: auth principal (BetterAuth-side, can NOT be rolled back via tx)
      await authService.criarConta({
        idUsuario: data.idUsuario,
        idPlataforma: data.idPlataforma,
        email: data.email,
        senha: data.senhaSimulada,
        nome: data.nomeExibicao,
      });

      // step 4: domain aggregate. On failure, compensate the auth write.
      const usuario: Usuario = {
        id: data.idUsuario,
        idPlataforma: data.idPlataforma,
        idConta: data.idConta,
        email: data.email,
        nomeExibicao: data.nomeExibicao,
        criadoEm,
      };

      const conta: Conta = {
        id: data.idConta,
        idUsuario: data.idUsuario,
        permissoes: PERMISSOES_PADRAO,
        criadaEm: criadoEm,
      };

      try {
        await usuarioRepository.saveRegistroDomain({ usuario, conta });
      } catch (domainError) {
        // Compensation (T3): undo the auth.criarConta write so the system
        // does not end up with an auth principal that has no domain
        // counterpart. Best-effort — log the compensation outcome but
        // surface the ORIGINAL domain error to the caller (more useful
        // than a "compensation also failed" wrap).
        try {
          await authService.removerConta(data.idUsuario);
          logger.info('usuario.conta.registro_compensado', {
            idUsuario: data.idUsuario,
            motivo: (domainError as Error).message,
          });
        } catch (compensationError) {
          logger.info('usuario.conta.compensacao_falhou', {
            idUsuario: data.idUsuario,
            erroOriginal: (domainError as Error).message,
            erroCompensacao: (compensationError as Error).message,
          });
        }
        throw domainError;
      }

      logger.info('usuario.conta.registrada', {
        idUsuario: usuario.id,
        idPlataforma: usuario.idPlataforma,
        idConta: conta.id,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { usuario, conta };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
