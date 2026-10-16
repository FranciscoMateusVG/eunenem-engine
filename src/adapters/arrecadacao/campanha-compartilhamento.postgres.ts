import { randomUUID } from 'node:crypto';
import { type Selectable, sql, type Transaction } from 'kysely';
import type { Database } from '../database.js';
import type { CampanhaConvites, DB } from '../db-types.generated.js';
import { CampanhaMembrosRepositoryPostgres } from './campanha-membros-repository.postgres.js';

export class EmailJaMembroCampanhaError extends Error {
  constructor() {
    super('Este e-mail já tem acesso à campanha.');
    this.name = 'EmailJaMembroCampanhaError';
  }
}

/** Persistence boundary; callers authorize owner/admin inside the same transaction.
 * Invites never contain bearer credentials: only a verified, authenticated email
 * in the campaign tenant can consume them. No ownership or banking writes here.
 */
export class CampanhaCompartilhamentoPostgres {
  constructor(private readonly db: Database) {}

  async bloquear(trx: Transaction<DB>, campanhaId: string, plataformaId: string) {
    return trx
      .selectFrom('campanhas')
      .select('id')
      .where('id', '=', campanhaId)
      .where('id_plataforma', '=', plataformaId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  async auditar(
    trx: Transaction<DB>,
    campanhaId: string,
    atorId: string,
    acao: string,
    alvo: string,
  ) {
    await trx
      .insertInto('campanha_compartilhamento_audit')
      .values({
        id: randomUUID(),
        campanha_id: campanhaId,
        ator_id: atorId,
        acao,
        alvo,
      })
      .execute();
  }

  async convidar(
    input: {
      campanhaId: string;
      plataformaId: string;
      email: string;
      atorId: string;
      origem: 'owner' | 'admin';
    },
    trx?: Transaction<DB>,
  ): Promise<Selectable<CampanhaConvites>> {
    if (!trx) return this.db.transaction().execute((tx) => this.convidar(input, tx));
    await this.bloquear(trx, input.campanhaId, input.plataformaId);
    const email = input.email.trim().toLowerCase();
    const member = await trx
      .selectFrom('campanha_administradores as a')
      .innerJoin('usuarios as u', 'u.id_conta', 'a.id_usuario')
      .leftJoin('users as auth', (join) => join.on(sql<boolean>`u.id::text = auth.id`))
      .select('a.id_usuario')
      .where('a.campanha_id', '=', input.campanhaId)
      .where('u.id_plataforma', '=', input.plataformaId)
      .where((eb) =>
        eb.or([
          sql<boolean>`lower(btrim(u.email)) = ${email}`,
          sql<boolean>`lower(btrim(auth.email)) = ${email}`,
        ]),
      )
      .executeTakeFirst();
    if (member) throw new EmailJaMembroCampanhaError();
    const now = new Date();
    // Expired invites become terminal, allowing a fresh invitation without
    // reviving the old identity (important for revoke/re-invite races).
    await trx
      .updateTable('campanha_convites')
      .set({ revogado_em: now })
      .where('campanha_id', '=', input.campanhaId)
      .where('email', '=', email)
      .where('consumido_em', 'is', null)
      .where('revogado_em', 'is', null)
      .where('expira_em', '<=', now)
      .execute();
    const existing = await trx
      .selectFrom('campanha_convites')
      .selectAll()
      .where('campanha_id', '=', input.campanhaId)
      .where('email', '=', email)
      .where('consumido_em', 'is', null)
      .where('revogado_em', 'is', null)
      .executeTakeFirst();
    if (existing) return existing;
    const row = await trx
      .insertInto('campanha_convites')
      .values({
        id: randomUUID(),
        campanha_id: input.campanhaId,
        email,
        criado_por: input.atorId,
        expira_em: new Date(now.getTime() + 7 * 86400_000),
        revogado_em: null,
        consumido_em: null,
        consumido_por: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.auditar(trx, input.campanhaId, input.atorId, `${input.origem}:convidar`, email);
    return row;
  }

  async revogar(
    campanhaId: string,
    plataformaId: string,
    conviteId: string,
    atorId: string,
    trx?: Transaction<DB>,
  ): Promise<void> {
    if (!trx)
      return this.db
        .transaction()
        .execute((tx) => this.revogar(campanhaId, plataformaId, conviteId, atorId, tx));
    await this.bloquear(trx, campanhaId, plataformaId);
    const row = await trx
      .updateTable('campanha_convites')
      .set({ revogado_em: new Date() })
      .where('id', '=', conviteId)
      .where('campanha_id', '=', campanhaId)
      .where('consumido_em', 'is', null)
      .where('revogado_em', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (row) await this.auditar(trx, campanhaId, atorId, 'revogar', row.id);
  }

  /** Called by the sole membership-removal path while holding the campaign lock. */
  async revogarPendentesDoMembro(
    campanhaId: string,
    idConta: string,
    atorId: string,
    trx: Transaction<DB>,
  ): Promise<void> {
    const campaign = await trx
      .selectFrom('campanhas')
      .select('id_plataforma')
      .where('id', '=', campanhaId)
      .executeTakeFirstOrThrow();
    const user = await trx
      .selectFrom('usuarios as u')
      .leftJoin('users as auth', (join) => join.on(sql<boolean>`u.id::text = auth.id`))
      .select(['u.email', 'auth.email as auth_email'])
      .where('u.id_conta', '=', idConta)
      .where('u.id_plataforma', '=', campaign.id_plataforma)
      .executeTakeFirst();
    if (!user) return;
    const emails = [user.email, user.auth_email]
      .filter((email): email is string => email !== null)
      .map((email) => email.trim().toLowerCase());
    const revoked = await trx
      .updateTable('campanha_convites')
      .set({ revogado_em: new Date() })
      .where('campanha_id', '=', campanhaId)
      .where('email', 'in', emails)
      .where('revogado_em', 'is', null)
      .where('consumido_em', 'is', null)
      .returning('id')
      .execute();
    for (const row of revoked)
      await this.auditar(trx, campanhaId, atorId, 'remover:revogar-convite', row.id);
  }

  /** Read-only onboarding projection; a shared campaign never completes the
   * invitee's own onboarding or replaces their owner-only default campaign. */
  async contextoOnboarding(
    usuarioId: string,
    idConta: string,
    plataformaId: string,
  ): Promise<{ idsProprias: string[]; idCompartilhada: string | null }> {
    const memberships = await this.db
      .selectFrom('campanha_administradores as a')
      .innerJoin('campanhas as c', 'c.id', 'a.campanha_id')
      .innerJoin('campanha_membros_permissoes as p', (join) =>
        join.onRef('p.campanha_id', '=', 'a.campanha_id').onRef('p.id_conta', '=', 'a.id_usuario'),
      )
      .select(['c.id', 'p.papel'])
      .where('a.id_usuario', '=', idConta)
      .where('c.id_plataforma', '=', plataformaId)
      .orderBy('c.criada_em', 'asc')
      .orderBy('c.id', 'asc')
      .execute();
    const idsProprias = memberships.filter((m) => m.papel === 'owner').map((m) => m.id);
    const verified = await this.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', usuarioId)
      .where('id_plataforma', '=', plataformaId)
      .where('email_verified', '=', true)
      .executeTakeFirst();
    if (!verified) return { idsProprias, idCompartilhada: null };
    const accepted = await this.db
      .selectFrom('campanha_convites')
      .select('campanha_id')
      .where('consumido_por', '=', usuarioId)
      .where('consumido_em', 'is not', null)
      .execute();
    const shared = memberships.find(
      (m) => m.papel === 'membro' && accepted.some((invite) => invite.campanha_id === m.id),
    );
    return { idsProprias, idCompartilhada: shared?.id ?? null };
  }

  async consumirVerificados(usuarioId: string, plataformaId: string): Promise<void> {
    // Called only AFTER session resolution/domain healing. Re-read authoritative
    // email verification and account mapping; never trust request/session email.
    const user = await this.db
      .selectFrom('users')
      .innerJoin('usuarios', (join) => join.on(sql<boolean>`usuarios.id::text = users.id`))
      .select(['users.email', 'usuarios.id_conta'])
      .where('users.id', '=', usuarioId)
      .where('users.id_plataforma', '=', plataformaId)
      .where('usuarios.id_plataforma', '=', plataformaId)
      .where('users.email_verified', '=', true)
      .where('usuarios.desativado_em', 'is', null)
      .executeTakeFirst();
    if (!user) return;
    const candidates = await this.db
      .selectFrom('campanha_convites')
      .innerJoin('campanhas', 'campanhas.id', 'campanha_convites.campanha_id')
      .select(['campanha_convites.id', 'campanha_convites.campanha_id'])
      .where('campanhas.id_plataforma', '=', plataformaId)
      .where('email', '=', user.email.trim().toLowerCase())
      .where('revogado_em', 'is', null)
      .where('consumido_em', 'is', null)
      .where('expira_em', '>', new Date())
      .execute();
    for (const candidate of candidates) {
      await this.db.transaction().execute(async (trx) => {
        await this.bloquear(trx, candidate.campanha_id, plataformaId);
        const verified = await trx
          .selectFrom('users')
          .innerJoin('usuarios', (join) => join.on(sql<boolean>`usuarios.id::text = users.id`))
          .select(['users.email', 'usuarios.id_conta'])
          .where('users.id', '=', usuarioId)
          .where('users.email_verified', '=', true)
          .where('users.id_plataforma', '=', plataformaId)
          .where('usuarios.id_plataforma', '=', plataformaId)
          .where('usuarios.desativado_em', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!verified) return;
        const consumed = await trx
          .updateTable('campanha_convites')
          .set({ consumido_em: new Date(), consumido_por: usuarioId })
          .where('id', '=', candidate.id)
          .where('email', '=', verified.email.trim().toLowerCase())
          .where('revogado_em', 'is', null)
          .where('consumido_em', 'is', null)
          .where('expira_em', '>', new Date())
          .returning('id')
          .executeTakeFirst();
        if (!consumed) return;
        await trx
          .insertInto('campanha_administradores')
          .values({ campanha_id: candidate.campanha_id, id_usuario: verified.id_conta })
          .onConflict((oc) => oc.columns(['campanha_id', 'id_usuario']).doNothing())
          .execute();
        await new CampanhaMembrosRepositoryPostgres(this.db).adicionarMembro(
          candidate.campanha_id,
          verified.id_conta,
          { trx },
        );
        await this.auditar(trx, candidate.campanha_id, usuarioId, 'consumir', consumed.id);
      });
    }
  }
}
