# Plan 0007 — Webhook authentication & authorization

> **Status**: drafted 2026-05-24, awaiting confirmation.
> **Depends on**: plan `0004-async-confirmation-and-webhooks.md` (the webhook ingress exists and is currently trusting-everything).

## Goal

Plan 0004 introduced `POST /webhook/provedor` that calls `ingerirWebhookProvedor`. That route currently accepts any payload — perfect for the demo, catastrophic for production. This plan adds:

1. **Signature verification per provider** (Stripe-style HMAC, PIX cert-based, etc.) at the HTTP boundary, before the payload reaches `ingerirWebhookProvedor`.
2. **Replay protection** via timestamp window (reject events older than N minutes, even if signature valid).
3. **Per-provider secret rotation** without code changes.
4. **IP allowlist (optional, defense-in-depth)** for providers that publish stable webhook source IPs.
5. **Audit log** of rejected webhooks (signature failure, stale timestamp, unknown provider).

## Locked decisions

1. **Signature verification is a port, adapters are per-provider.** `WebhookSignatureVerifier` interface; one implementation per provider (Stripe, PIX, MercadoPago). The HTTP route picks the verifier based on the URL or header. Wrong-provider headers fail verification.

2. **Verification happens at the HTTP boundary, before `ingerirWebhookProvedor`.** Domain layer never sees raw headers. The route reads `(rawBody, headers, providerName)` → verifies → parses → calls use case with the normalized payload.

3. **Failed verification returns 401 + logs.** Not 400 (don't tell attackers "your signature was wrong, your timestamp was old"). 401 with a generic message; full details only in our logs.

4. **Replay window: 5 minutes default**, configurable per provider. Stripe ships with a `timestamp` in the signature; we reject if `|now - timestamp| > window`.

5. **Secrets live in env vars, not DB.** `STRIPE_WEBHOOK_SECRET`, `PIX_WEBHOOK_PUBLIC_KEY_PATH`, etc. Rotation is a deploy step. A future plan can move to a secret manager (Vault, AWS Secrets Manager).

6. **IP allowlist is opt-in, per provider.** Some providers don't publish stable IPs (PIX via various banks). If `WEBHOOK_<PROVIDER>_ALLOWLIST` is set, enforce it; otherwise skip.

7. **One signature verifier per provider in 0007**: Stripe-style HMAC-SHA256. PIX (mTLS / JWS) deferred to a separate plan unless we onboard a PIX provider in the meantime.

## DDD concepts this plan teaches

### Anti-corruption layer at the edge

Plan 0004 already used "ACL" for normalizing provider payloads into our shape. Verification is the *security half* of the same boundary: not just translating shape, but vouching for authenticity. The pattern: external systems can never be trusted at face value; the ACL is where trust is established (or denied).

### Defense in depth

Signature verification alone is enough in theory. IP allowlist alone is enough in theory. Replay protection alone is *not* enough in theory. The combination of all three buys margin: if the signature secret leaks, IP allowlist still helps. If IP is spoofed (rare on TCP), signature stops it. If signature scheme has a CVE (it happens — see Stripe's 2020 timing attack patch), replay window limits exploit time.

### Domain vs infrastructure for secrets

Secrets are *infrastructure*. They never appear in domain types, never in test fixtures, never in logs. The use case `ingerirWebhookProvedor` doesn't know secrets exist. It receives a *verified, parsed* payload. This makes domain tests trivial (no need to mock signature verification) and keeps the security-critical code in one place.

## Phases

### Phase 1 — Signature verifier port + fake adapter

**Objective**: Define the verification port; fake adapter for tests/demo trusts everything (current behavior, but now explicitly wrapped).

**Files NEW**:
```
src/adapters/pagamentos/webhook-verifier.ts             # port
src/adapters/pagamentos/webhook-verifier.fake.ts        # always-valid (demo + tests)
tests/unit/pagamentos/webhook-verifier.test.ts
```

**Port shape**:
```ts
interface WebhookSignatureVerifier {
  readonly nomeProvedor: string;
  verify(input: {
    rawBody: string;
    headers: Record<string, string>;
    agora: Date;
  }): { valido: true } | { valido: false; motivo: 'signature' | 'timestamp' | 'malformed' };
}
```

**Files MODIFIED**: `examples/fluxo-completo.web.ts` POST `/webhook/provedor` route — selects verifier by header, calls `verify()` before `ingerirWebhookProvedor`. With the fake, behavior is identical to today.

**Verification**: route still works; verifier is invoked but always returns valid.

**STOP for confirmation.**

---

### Phase 2 — Stripe-style HMAC verifier

**Objective**: Real verifier that checks `Stripe-Signature`-style headers using HMAC-SHA256 with timestamp + signed payload + secret.

**Files NEW**:
```
src/adapters/pagamentos/webhook-verifier.stripe-hmac.ts
tests/unit/pagamentos/webhook-verifier.stripe-hmac.test.ts
```

**Behavior**: parse `t=<ts>,v1=<sig>` from header; compute `HMAC_SHA256(secret, "<ts>.<rawBody>")`; constant-time compare to `v1`; reject if `|now - ts| > window`.

**Constant-time compare**: use `crypto.timingSafeEqual` — `===` is a timing oracle.

**Files MODIFIED**: env-var loader (probably new) that reads `STRIPE_WEBHOOK_SECRET` and instantiates the verifier at boot. Demo can opt-in via env var.

**Verification**: tests cover valid signature, invalid signature, stale timestamp, malformed header. Property test: any byte flip in body or signature invalidates.

**STOP for confirmation.**

---

### Phase 3 — IP allowlist + audit log

**Objective**: Optional IP allowlist per provider; record all rejections (with reason) to an audit table.

**Files NEW**:
```
migrations/
└── 20260801_001_create_webhook_rejeicoes_audit.ts
src/adapters/pagamentos/
└── webhook-audit-repository.{ts,memory.ts,postgres.ts}
```

**Schema**:
```sql
CREATE TABLE webhook_rejeicoes_audit (
  id          UUID PRIMARY KEY,
  provedor    TEXT NOT NULL,
  motivo      TEXT NOT NULL,         -- 'signature' | 'timestamp' | 'ip' | 'unknown_provider'
  origem_ip   INET,
  ocorrido_em TIMESTAMPTZ NOT NULL,
  headers_redacted JSONB              -- everything except signature/secret-bearing headers
);
CREATE INDEX ON webhook_rejeicoes_audit (provedor, ocorrido_em DESC);
```

**Files MODIFIED**: webhook route checks IP allowlist (if configured), records rejection on any failure, returns 401 with generic message.

**Verification**: rejections appear in audit table; 401 response body is generic; logs contain full details.

**STOP for confirmation.**

---

## Open questions

1. **PIX webhook auth.** PIX uses mTLS at the receiver bank's choice or JWS in some flows. Highly bank-dependent. Probably its own plan when we have a real PIX provider lined up.

2. **Rotation procedure.** Today: deploy with new env var, restart. Realistic: dual-secrets window (accept either A or B) for N minutes during rotation. Add to the port? Or handle at infra layer (load both, try one then the other)?

3. **Audit retention.** webhook_rejeicoes_audit grows forever if not pruned. Default retention 90 days? Configurable per plataforma?

4. **What about the inbox after verification?** If verification passes, we write to inbox (plan 0005 Phase 3). If inbox write fails, we've already returned 200 to provider — risk of lost event. Mitigation: write inbox + verify in same transaction, or write inbox first and reject after. Lean toward "verify first, then write inbox" since most rejects shouldn't pollute the inbox.

5. **Rate limiting at the route.** A misconfigured provider could DOS us with millions of bad-signature webhooks. Should we rate-limit per source IP, per provider? Probably yes, but rate limiting is its own concern — defer to ops/infra plan.

## Done definition

- All 3 phases land; `pnpm check` green.
- Webhook route rejects bad-signature payloads with 401.
- Demo can toggle between fake (trusts everything) and Stripe-HMAC verifier via env var.
- Audit table captures every rejection.
- `docs/idempotency-and-concurrency.md` (or a new security doc) gets a section on webhook trust.
