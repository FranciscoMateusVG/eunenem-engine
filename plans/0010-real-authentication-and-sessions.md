# Plan 0010 — Real authentication & session management

> **Status**: drafted 2026-05-24, awaiting confirmation.
> **Depends on**: plan `0003-plataforma-multi-tenant-done.md` (Usuario already scoped per plataforma with composite uniqueness).
> **Unblocks**: plan `0009-plataforma-management-and-admin-ux.md` (admin role needs real auth to be safe).

## Goal

Today Usuario registration takes a `senhaSimulada: string` and stores it verbatim. Sessions exist as a repository scaffold but no use case logs in, validates a token, or expires anything. The web demo doesn't ask anyone to log in — every action is anonymous.

This plan ships real authentication:

1. Passwords are **hashed** (argon2id), never stored cleartext.
2. **Login** use case validates credentials, creates a session.
3. **Session token** is a random opaque string in a cookie (HttpOnly, SameSite, Secure-in-prod).
4. **Session validation middleware** for protected routes; logout invalidates the session.
5. **Roles**: `admin | operador | end_user`. Per plataforma. Admin/operador can manage their own plataforma; nothing cross-plataforma.

## Locked decisions

1. **argon2id, not bcrypt.** Modern, GPU-resistant, configurable memory/time costs. OWASP-recommended (2024+). Single library, no algorithm migrations needed.

2. **Opaque session tokens in cookies, not JWT.** JWTs are great for stateless distributed systems we don't have. Opaque tokens stored in a `sessoes` table = trivial revocation, simple to reason about, no signing-key rotation drama.

3. **Cookie attributes**: `HttpOnly` always, `Secure` when behind HTTPS (config-driven for dev), `SameSite=Lax` (forms still work), `Path=/`. Cookie name `engine_session`.

4. **Session expiry**: sliding 30-day TTL (every successful request resets it). Configurable per plataforma later. Admin/operador sessions get shorter TTL (24h) — they're higher-privilege.

5. **Per-plataforma sessions.** A session is bound to `(idPlataforma, idUsuario)`. Switching plataformas means logging out + back in. No cross-plataforma session tokens.

6. **Rate limiting on login**: 5 failed attempts in 15 min → 15-min lockout per `(idPlataforma, email)`. Not per-IP (NAT/CGNAT) and not per-account-id (attacker doesn't know it). After lockout, even correct password fails — they wait.

7. **Roles are denormalized onto Usuario for 0010.** `Usuario.papel: 'admin' | 'operador' | 'end_user'`. Multi-role / RBAC matrix is over-engineering for now. Admin assignment is bootstrap-time (memory seed) or via a future use case.

8. **Password reset is out of scope for 0010.** Documented as a gap; needs email infrastructure we don't have.

## DDD concepts this plan teaches

### Authentication is a separate concern from authorization

`autenticarUsuario` (login) → "who are you?" returns a Sessao.
`autorizar*` checks → "are you allowed to do X?" inspects role.

Coupling them means every endpoint mixes "is the cookie valid" with "are they allowed." Separating means middleware does authn once, use cases enforce authz at their entry point. The use cases know about roles; middleware doesn't know about endpoints.

### Session as an aggregate root

Sessao is its own aggregate: id, idUsuario, idPlataforma, criadaEm, expiraEm, ultimaAtividadeEm, revogadaEm. It has a lifecycle (criada → ativa → expirada/revogada). Treating it as a real aggregate (with state transitions, typed errors, proper repo) is better than the typical "session is just a row" thinking. Login = create Sessao. Logout = revoke Sessao. Validation = load + check status.

### Defense in depth at the credential boundary

argon2id (slow hash) + rate limiting (attempt cap) + opaque tokens (no info leak in cookie) + cookie flags (XSS protection) — each is necessary, none sufficient. Same pattern as plan 0007's webhook auth.

### Composite uniqueness as the login key

Plan 0003 made email unique per `(idPlataforma, email)`. Login takes `(slug, email, password)` — the plataforma slug *is* the namespace. Same email on eunenem and eucasei = two separate accounts. The composite uniqueness from 0003 becomes meaningful at login: we resolve plataforma first, then look up usuario.

## Phases

### Phase 1 — Hash passwords on register

**Objective**: `registrarContaUsuario` hashes `senhaSimulada` with argon2id; never stores cleartext.

**Files NEW**:
```
src/adapters/usuario/
└── password-hasher.{ts,argon2.ts,fake.ts}     # port + real adapter + fake (for fast tests)
tests/unit/usuario/
└── password-hasher.test.ts
```

**Files MODIFIED**:
- `src/domain/usuario/entities/usuario.ts` — rename field `senhaSimulada` → `hashSenha` (or add new, deprecate old).
- `src/use-cases/usuario/registrar-conta-usuario.ts` — call hasher, store hash.
- Memory + Postgres adapters — persist hash.
- Migration: rename column.

**Verification**: `pnpm check` green; new usuarios have argon2-format hashes (not cleartext); existing tests that compared cleartext password values get updated.

**STOP for confirmation.**

---

### Phase 2 — Login use case + Sessao aggregate

**Objective**: `autenticarUsuario(slug, email, password)` validates credentials, creates a Sessao, returns token.

**Files NEW**:
```
src/use-cases/usuario/
├── autenticar-usuario.ts            # login
├── encerrar-sessao.ts                # logout
└── validar-sessao.ts                 # called by middleware on every request
src/errors/usuario/
├── credenciais-invalidas.error.ts
├── sessao-expirada.error.ts
├── sessao-revogada.error.ts
└── usuario-bloqueado.error.ts
src/adapters/usuario/
└── login-attempt-repository.{ts,memory.ts,postgres.ts}  # rate-limit tracking
migrations/
├── 20261101_001_create_sessoes.ts (if not yet in Postgres)
└── 20261101_002_create_login_attempts.ts
tests/unit/usuario/
├── autenticar-usuario.test.ts
├── encerrar-sessao.test.ts
└── validar-sessao.test.ts
```

**Files MODIFIED**:
- `src/domain/usuario/entities/sessao.ts` — promote to real aggregate with `status: 'ativa' | 'expirada' | 'revogada'` + helpers `podeRevogar`, `estaAtiva(s, agora)`.
- `src/adapters/usuario/sessao-repository.{memory,postgres}.ts` — gain `findByToken(token)`.

**Behavior**:
```ts
autenticarUsuario(deps, { slug, email, senha })
  → plataforma = plataformaRepo.findBySlug(slug)  // 404 → CredenciaisInvalidas (don't leak)
  → checkLockout(slug, email)                     // raise UsuarioBloqueado if locked
  → usuario = usuarioRepo.findByEmail(plataforma.id, email)  // missing → record attempt, raise CredenciaisInvalidas
  → ok = await hasher.verify(usuario.hashSenha, senha)
  → if !ok → record attempt, raise CredenciaisInvalidas
  → reset attempts
  → sessao = criar Sessao{ idUsuario, idPlataforma, criadaEm: now, expiraEm: now + 30d, token: randomBytes(32).hex }
  → save sessao
  → return { token, sessao }
```

**Verification**: integration test boots adapters, exercises login (success + fail + lockout), validates session, logs out, re-validates → expired.

**STOP for confirmation.**

---

### Phase 3 — Cookie middleware + protected routes in demo

**Objective**: Web demo wraps protected routes with auth middleware; login form + logout flow.

**Files MODIFIED**:
- `examples/fluxo-completo.web.ts`:
  - NEW `GET /p/:slug/login` — login form.
  - NEW `POST /p/:slug/login` — calls `autenticarUsuario`, sets cookie on success.
  - NEW `POST /p/:slug/logout` — calls `encerrarSessao`, clears cookie.
  - Middleware: for routes under `/p/:slug/admin/*` and `/admin/plataformas/*` (from plan 0009), read cookie → `validarSessao` → require role.
  - Loja routes (`/p/:slug/loja/...`) stay open — anyone can browse and buy. Checkout submission attaches contribuinte info without requiring login.

**Verification**: manual browser test — log in, access admin, log out, admin redirects to login.

**STOP for confirmation.**

---

### Phase 4 — Roles + per-route authz

**Objective**: Routes assert role; use cases reject when caller role insufficient.

**Files MODIFIED**:
- `src/domain/usuario/entities/usuario.ts` — add `papel: 'admin' | 'operador' | 'end_user'` (default `end_user`).
- `src/use-cases/plataforma/*` (from plan 0009) — accept `executorPapel` and reject if not admin (suspender allows operador).
- Middleware reads usuario.papel, attaches to request context.
- Demo seed users: one admin per plataforma.

**Verification**: end_user trying to suspend plataforma → 403; admin can; operador can suspend but not arquivar.

**STOP for confirmation.**

---

## Open questions

1. **Password reset.** Out of scope but needs email. When the project gets email infrastructure (or a fake "console-prints-the-reset-link" adapter), add `solicitarResetSenha` + `resetarSenha` use cases.

2. **Anonymous checkout.** Locked as "loja stays open." But should the contribuinte create a lightweight account at checkout (for status emails)? Maybe optional — capture email always, persist if they want.

3. **Role granularity.** `admin | operador | end_user` is coarse. Real systems often have `admin_global | admin_plataforma | operador_financeiro | operador_suporte | end_user`. Coarse is fine for 0010; revisit when an actual use case demands finer.

4. **Session storage scaling.** Postgres for sessions is fine up to ~millions. Beyond that, Redis is the canonical move. Not in 0010.

5. **CSRF protection.** Cookie-auth + form posts means CSRF tokens become relevant. SameSite=Lax mitigates most cases but not all. Add a CSRF token to admin forms? Probably yes in Phase 4.

6. **Audit log of sensitive actions.** Login success/failure, logout, role change — should land in an audit table. Could ride on plan 0005's outbox.

## Done definition

- All 4 phases land; `pnpm check` green.
- Passwords stored as argon2id hashes.
- Login + logout work in the demo via cookie.
- Admin routes require admin role; end_user gets 403.
- Failed login attempts trigger lockout after 5 in 15 min.
