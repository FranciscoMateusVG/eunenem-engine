# Spec: Banco Inter Cobrança PIX — replace Stripe for PIX collection

**Bead:** aperture-2j2j1 · **Author:** Wheatley · **Date:** 2026-08-05
**Status:** PENDING GLADOS + OPERATOR APPROVAL — no implementation beads until both sign off.

## 1. Title & Goal

Collect PIX payments on eunenem-engine via Banco Inter's Pix API (Cobrança imediata / "cob") instead of Stripe, while credit-card collection stays on Stripe. Reuse the money-safety, mTLS, OAuth, NO-PII and observability patterns already proven in the PIX-out adapter (`transferencia-provider.inter.ts`, aperture-ju5w2). Stripe and Inter coexist during migration; rollback is an env-var flip.

## 2. Grep-receipt (existing-infra audit)

- `cobranca|pixCopiaECola|txid|devolucao|qrcode|\bcob\b` over `src/ apps/` → **zero collection-side hits** (one comment in `aprovar-repasse-recebedor.ts:17` about PIX-out referencia format). The cobrança adapter is greenfield.
- Reusable primitives confirmed: mTLS keep-alive agent + OAuth token cache + error-code extraction (`transferencia-provider.inter.ts:145-338`); provider-generic webhook archive (`WebhookEventArchive` port + `payment_webhook_events` table, `ON CONFLICT (provider, provider_event_id)` dedup); pg-boss for background jobs; `InterHttpTransport` injectable test seam; OTel span conventions.
- NOT reusable as-is: `CheckoutSessionProvider` result shape (iframe `clientSecret`, no QR field); `RefundarPagamentoInput` (Stripe `ch_`/`pi_` refs, no e2eId slot); the binary Stripe-vs-fake DI gate.

## 3. Key API facts (from Inter's official OpenAPI spec)

- Base `https://cdpj.partners.bancointer.com.br/pix/v2` (sandbox `cdpj-sandbox.partners.uatinter.co`), mTLS + OAuth2 client-credentials (token TTL 60min, endpoint rate-limited 5/min → shared token cache is mandatory).
- Create charge: `PUT /cob/{txid}` with client-generated txid `[a-zA-Z0-9]{26,35}` (UUID minus hyphens = 32 chars, fits). Response includes `pixCopiaECola` (BR Code string, ≤512) inline — **no image endpoint; we render the QR client-side**. `calendario.expiracao` in seconds (we set **600**, matching Stripe's current PIX window). `devedor` optional for cob.
- Paid detection: webhook `PUT /webhook/{chave}` (per PIX key, one URL per key, overwrite semantics) + authoritative re-query `GET /cob/{txid}` / `GET /pix/{e2eId}`.
- Refund: `PUT /pix/{e2eId}/devolucao/{id}` — client-generated `{id}` = free idempotency; partial allowed; ≤90 days; **async** (`EM_PROCESSAMENTO → DEVOLVIDO | NAO_REALIZADO`).
- **Webhook has NO payload signature.** Official verification = Inter client-cert (mTLS on our endpoint) and/or published IP allowlist; recommended pattern is re-query before fulfilling. Deliveries arrive at registered URL **+ `/pix` suffix**; retries only 4× over ~3.8h; payload is an **array** of pix.
- Scopes needed: `cob.write cob.read pix.read pix.write webhook.write webhook.read`. **Scopes are fixed at integration creation** → the existing Banking-v2 credential CANNOT gain Pix scopes; a **new Inter integration** (new cert + client_id/secret) is required. Operator prereq, see §11.
- Sandbox: self-service, all scopes, **open 08:00–20:00 BRT weekdays only**, certs expire every 30 days, has payment simulators (`POST /pix/v2/cob/pagar/{txid}`). Usable for manual verification; NOT for CI (fake adapter covers CI).

## 4. Port & adapter design

### 4.1 New sibling port `PixCobrancaProvider` (ISP precedent: aperture-aiipy)

Do NOT bend `CheckoutSessionProvider` (iframe-shaped) around a QR flow, and do not add phantom optional fields to shared results. New port in `src/adapters/pagamentos/pix-cobranca-provider.ts`:

```ts
export interface CriarCobrancaInput {
  readonly idPagamento: IdPagamento;          // → txid = uuidWithoutHyphens(idPagamento)
  readonly idIntencaoPagamento: IdIntencaoPagamento;
  readonly amountCents: MoneyCents;           // → valor.original, formatted "d+.dd"
  readonly solicitacaoPagador?: string;       // charge description shown to payer
}
export interface CobrancaCriada {
  readonly txid: string;
  readonly pixCopiaECola: string;             // BR Code; frontend renders QR from this
  readonly expiraEm: Date;                    // criacao + expiracao
}
export type ConsultarCobrancaResult =
  | { status: 'ativa' }
  | { status: 'concluida'; e2eId: string; valorPagoCents: MoneyCents; horario: Date }
  | { status: 'removida' }
  | { status: 'desconhecido'; statusBruto: string };   // never map unknown → terminal
export interface SolicitarDevolucaoInput {
  readonly e2eId: string;
  readonly idDevolucao: string;               // client-generated, stable per retry (≤35 alnum)
  readonly amountCents: MoneyCents;
  readonly descricao?: string;                // ≤140; reason text (Stripe's enum maps here)
}
export type DevolucaoOutcome =
  | { status: 'em_processamento'; rtrId: string }
  | { status: 'devolvida' }
  | { status: 'nao_realizada'; motivo?: string }
  | { status: 'rejeitada'; codigo: string };  // terminal 400-class only
export interface PixCobrancaProvider {
  criarCobranca(input: CriarCobrancaInput): Promise<CobrancaCriada>;
  consultarCobranca(txid: string): Promise<ConsultarCobrancaResult>;
  solicitarDevolucao(input: SolicitarDevolucaoInput): Promise<DevolucaoOutcome>;
  consultarDevolucao(e2eId: string, idDevolucao: string): Promise<DevolucaoOutcome>;
}
```

Adapter `pix-cobranca-provider.inter.ts` mirrors the PIX-out adapter file-for-file in structure: injectable `InterHttpTransport`, keep-alive mTLS agent (TLS verification stays ON — no `rejectUnauthorized`, no custom `ca`, no env override), token cache with 60s refresh margin, `extractInterErrorCode` (ignore `detail`/`violacoes` — they can echo PII).

**Shared plumbing extraction (small refactor, same PR as the adapter):** lift the mTLS agent + token cache + error-code extraction from `transferencia-provider.inter.ts` into `src/adapters/pagamentos/inter-http.ts`, consumed by both adapters with separate credential sets. The PIX-out adapter's behavior must be diff-provably unchanged (its 328-line test suite is the guard).

### 4.2 Money-safety classification (direction-aware)

- `criarCobranca`: retry-safe by construction (PUT keyed on deterministic txid). Transport/token failures → plain retryable error; no ambiguity class needed — re-PUT converges.
- **Marking a pagamento as paid is the hazardous transition** (goods/thank-you released). It NEVER happens from a webhook payload alone — only from an authoritative `GET /cob/{txid}` → `concluida` (§5).
- `solicitarDevolucao` is money-OUT — same hazard class as transferências. Reuse the taxonomy: pre-flight/token failures → transient (retry with SAME `idDevolucao`); timeouts/5xx/unknown-2xx → ambiguous (park + `consultarDevolucao` before any retry); 400-class violations (over-refund, duplicate id, >90 days) → terminal `rejeitada`. Unknown status never maps to a terminal state.
- NO-PII: `infoPagador`, `devedor.nome/cpf/cnpj` never appear in logs, spans, or error messages. Span attrs: `cobranca.txid`, `cobranca.valor_cents`, HTTP status, Inter error code — mirroring `transferencia.*` conventions. `pixCopiaECola` is stored (DB) but never logged.

### 4.3 Checkout flow routing (use-case + frontend)

`iniciar-pagamento-carrinho` returns a **discriminated union** (no phantom fields):

```ts
type IniciarPagamentoResult =
  | { tipo: 'stripe_embedded'; sessionId: string; clientSecret: string }
  | { tipo: 'pix_qr'; txid: string; pixCopiaECola: string; expiraEm: Date };
```

Routing: `metodo === 'pix'` AND `COBRANCA_PIX_PROVIDER === 'inter'` → Inter branch; everything else → existing Stripe path untouched. Frontend adds a QR screen (render QR from `pixCopiaECola`, copy button, countdown to `expiraEm`, poll payment status endpoint) — **identity capture (nome/mensagem) moves to our own form before checkout** for the PIX path, since Stripe collected these in-iframe and Inter collects nothing (decision follows aperture-m95f3's intent: the data must exist; the collector changes).

### 4.4 DB changes

- `pagamentos.intencao_external_ref` stores the **txid** for Inter payments (same semantic slot as Stripe's `cs_` ref: "provider-side collection object id"; partial unique index already fits).
- New nullable column `intencao_e2e_external_ref` (+ partial unique index) — the settlement id, required for devolução. Mirrors the `20260602_018` pi/ch-columns pattern.
- `transacao_externa.provedor` gains value `'inter'` — this field routes refunds for historical payments (§6).
- New table `pix_cobranca_devolucoes` (idPagamento, e2eId, idDevolucao, amountCents, status, rtrId, timestamps) — devolução is async; its lifecycle needs a home. (Stripe refunds were synchronous-ish and lived in the result only.)

## 5. Webhook design (verify-by-requery — the payload is a hint, never evidence)

- **Route:** `POST /api/webhooks/inter/pix` AND `POST /api/webhooks/inter/pix/pix` (Inter appends `/pix` to the registered URL on real deliveries; the portal validator hits the raw URL — register `…/api/webhooks/inter/pix`, serve both). Mounted before the SSR catch-all like the Stripe route.
- **Pipeline** (reuses `WebhookEventArchive` port + `payment_webhook_events`): parse body → split the `pix[]` array into per-item events → archive each with `provider: 'inter'`, `provider_event_id: e2eId` (or `e2eId:devolucao:{id}` for refund updates), `signature_valid: false` **by convention** (Inter sends no signature; the column reads as "payload-authenticated", which Inter events never are) → dedup via existing `ON CONFLICT` → dispatch.
- **Dispatch = verify-then-act:** for each archived pix event, call `GET /cob/{txid}` (authoritative). Only `status: CONCLUIDA` from the API triggers `finalizarPagamentoAprovado`. Devolução updates likewise re-query `GET /pix/{e2eId}/devolucao/{id}` before `estornarPagamento` bookkeeping. A webhook whose re-query doesn't confirm → archive `markFailed`, no state change, alert via existing observability.
- **Ingress hardening (defense-in-depth, Peppy):** IP allowlist for Inter's published ranges at the proxy if feasible; body size cap; always fast-200 verified receipts. Inter's client-cert (`ca.crt`) validation at our TLS terminator is OPTIONAL — pursue only if the Dokploy/proxy setup supports per-route client-cert requests without contorting the stack; re-query already carries the trust load.
- **Reconciliation poller (REQUIRED for correctness):** Inter retries only 4× over ~3.8h, and **expiry produces no webhook at all**. pg-boss job every 5min: (a) for pagamentos in awaiting-pix state past `expiraEm` → re-query cob; `ATIVA` past expiry or `REMOVIDA_*` → reject/expire flow; `CONCLUIDA` → approve (missed webhook); (b) daily `GET /webhook/callbacks` audit sweep logs delivery failures. Note: `GET /pix` only lists charge-originated receipts — fine, all our receipts are charge-originated.

## 6. Coexistence & cutover vs Stripe

- New env `COBRANCA_PIX_PROVIDER: 'stripe' | 'inter' | 'fake'` (default `'stripe'` → zero behavior change at merge). Card payments: Stripe always, out of scope.
- **Migration sequence:** ship everything dark → operator creates Inter integration + sandbox manual verification → flip to `'inter'` in prod → new PIX checkouts go to Inter. In-flight Stripe PIX sessions (≤10min window) complete via the Stripe webhook path, which stays fully wired.
- **Refund routing by provenance:** `estornar-pagamento` branches on the stored `transacao_externa.provedor` — `'stripe'` → existing Stripe refund path (works indefinitely for historical payments); `'inter'` → devolução path. `RefundarPagamentoInput` gains `readonly e2eExternalRef: string | null` (documented deviation: the port already carries two provider-specific refs; a third is honest — a ref-map refactor is out of scope and phantom-proofing against providers we don't have).
- **Rollback:** flip env back to `'stripe'`. In-flight Inter charges (≤10min) settle via the Inter webhook/poller, which stays wired. No data migration in either direction.
- **Sandbox stance (differs from PIX-out — deliberate):** PIX-out is production-only because a real transfer double-pays; PIX-in's worst dev-mode failure is a test charge nobody pays. `'inter'` + sandbox base URL is allowed in non-prod for manual verification; CI keeps `'fake'` (sandbox's business-hours window + 30-day certs would make CI flaky).

## 7. Fake adapter & tests

- `PixCobrancaProviderFake`: option-driven outcomes, deterministic txid/e2eId factories, in-memory ledger, same-idPagamento replay (idempotency mirror), magic-value hooks (e.g. amount `1337` → charge that auto-completes on first consult) — mirroring `provider.fake.ts` + `4ifbm` magic patterns.
- Unit suite mirrors `ju5w2-inter-adapter.test.ts`: scripted transport; classification matrix (unknown-2xx → desconhecido, 400 → terminal, 5xx/timeout → ambiguous on devolução, token failure → transient); request-shape assertions (valor formatting, txid charset, expiracao); NO-PII assertions on thrown errors; token-cache single-fetch.
- Integration: DI-gate tests (COBRANCA_PIX_PROVIDER binding matrix, prod requires full INTER_COB_* set); webhook route tests (array payload split, dedup by e2eId, verify-by-requery gating, `/pix`-suffix route, oversized body 413).
- E2E (fake provider): full checkout → QR screen → simulated confirmation → approved; expiry path → rejected. Byte-level assertion on the archived webhook rows (e2e-catches-what-lower-cant: the archive write path is a composition-root surface).

## 8. Cipher security review checklist (pre-merge gate)

1. TLS verification ON everywhere (no `rejectUnauthorized:false`, no custom `ca` for API calls, no `NODE_TLS_REJECT_UNAUTHORIZED`).
2. NO-PII: grep adapter + webhook + poller for `infoPagador|devedor|nome|cpf|cnpj` reaching any log/span/error; `detail`/`violacoes` ignored in error extraction.
3. Webhook endpoint: no state transition from unverified payload (verify-by-requery enforced in code, not convention); dedup by e2eId; body-size cap; response never echoes payload; rate of 200s vs re-query failures observable.
4. Secrets: INTER_COB_* only via Infisical base64 envs; certs never on disk; absent from `.env.example`; no secret in span/log.
5. Refund authz: devolução callable only from the existing estorno use-case behind its 409 lançamento gate; no new public surface can trigger money-out.
6. Token cache shared per credential set (5/min endpoint limit — a cache miss storm is a self-DoS); token never logged.
7. txid/idDevolucao generation deterministic from our IDs (no ambient randomness in the money path — retries must converge).
8. Frontend QR screen renders `pixCopiaECola` from OUR API only (no third-party QR services — the BR Code embeds the merchant key).

## 9. Required seed data (test env)

- ≥1 campanha + contribuição option priced > R$0 wired to a checkout, so the PIX flow is drivable end-to-end.
- Fake-provider magic values documented in the fake's header (auto-complete amount, force-expire amount, devolução-fails amount).
- One historical Stripe-provedor pagamento fixture (refund-routing regression: old payments must still refund via Stripe).

## 10. Primary user journey (Izzy executes literally)

1. Open a campanha page → checkout with metodo PIX → **our** nome/mensagem form renders (not an iframe).
2. Submit → QR screen loads: QR image + copia-e-cola string + copy button + countdown (~10min). Not a 404; not a Stripe iframe.
3. (Fake/sandbox) trigger payment confirmation → within one poll cycle the screen flips to "pagamento confirmado"; contribution appears with the given nome + recadinho.
4. DB: pagamento aprovado; `intencao_external_ref` = 32-char txid; `intencao_e2e_external_ref` populated; `payment_webhook_events` row with `provider='inter'`.
5. Let a second charge expire → status flips to expired/rejected WITHOUT any webhook (poller path proven).
6. Admin estorno on the Inter payment → devolução `em_processamento` → confirmed on next poll; ledger consistent. Estorno on the historical Stripe fixture → still routes to Stripe.
7. Link checks: QR screen URL returns 200; post-confirmation redirect lands on the declared success page (200).

## 11. Operator prerequisites (blocking, before prod flip)

1. Create a **new** Inter integration (PJ Internet Banking) with scopes `cob.write cob.read pix.read pix.write webhook.write webhook.read`; download cert/key; store as base64 in Infisical (`INTER_COB_CERT_BASE64`, `INTER_COB_KEY_BASE64`, `INTER_COB_CLIENT_ID`, `INTER_COB_CLIENT_SECRET`).
2. Confirm/register the receiving **PIX key** on the Inter PJ account (`INTER_COB_PIX_KEY`) — cob and webhook are both keyed on it; confirm no other system uses that key's webhook slot (registration overwrites).
3. Decide the charge description text (`solicitacaoPagador`) shown to payers.
4. Calendar item: yearly prod cert renewal (renewal keeps credentials, changes cert only).

## 12. Proposed implementation beads (for GLaDOS to file post-approval — creation gate respected)

- B1 `inter-http.ts` extraction (shared mTLS/OAuth/error-code core; PIX-out suite proves no behavior change) — blocks B2.
- B2 `PixCobrancaProvider` port + Inter adapter + fake + unit suite — blocks B3, B5, B6.
- B3 webhook route + archive integration + verify-by-requery dispatch — blocks B4, B8.
- B4 reconciliation/expiry poller (pg-boss) — blocks B8.
- B5 checkout routing (use-case union + frontend QR screen + identity form) — blocks B8.
- B6 refund path (port widening, provenance routing, devoluções table) — blocks B8.
- B7 DI wiring + env schema + superRefine rules (parallel with B3-B6, after B2).
- B8 E2E + Cipher review checklist execution → prod-flip readiness.

## 13. Deploy spec

- Repo: eunenem-engine (this repo). No new service; new webhook route rides the existing `apps/eunenem-server` deployment. Public HTTPS (TLS ≥1.2) already satisfied. Ingress IP-allowlist config for Inter ranges: Peppy, optional hardening. No new subdomain.

## 14. Deviation log (post-approval, binding for implementers)

**D1 (2026-08-05, found by Rex during B3 — supersedes the literal mechanism text in §5/§6 for settlement + refunds):**
The spec's original mechanism assumed the Stripe-era use-cases compose as-is. They don't, on two points:

1. **Settlement:** `finalizarPagamentoAprovado` unconditionally calls `PagamentoProvider.solicitarPagamento` (a Stripe read-and-synthesize step). Re-firing it after an Inter `GET /cob/{txid}` already confirmed `CONCLUIDA` would be wrong — the authoritative verification HAS the settlement facts.
2. **Refunds:** `estornarPagamento` triggers a provider refund call. An Inter refund *webhook* reports money that has ALREADY moved (post-money-movement) — re-firing a refund trigger on that signal is the wrong direction entirely.

**Resolution:** B3 (Rex) introduces a **verified-result bookkeeping seam** — settlement/refund facts verified via authoritative re-query enter domain bookkeeping through that seam, without re-firing provider calls. **B5 and B6 MUST design against Rex's seam (see B3's PR/bead for its exact shape), not against this spec's literal "branch inside estornar-pagamento / call the finalizer" wording.** The provenance-branching INTENT of §6 stands: Stripe-provedor payments keep the existing Stripe paths; Inter-provedor flows route through the seam.

*(Process note: this is spec-deviation-discipline working as designed — the spec was written against port surfaces; implementation recon traced the use-case internals and found the composition gap. Deviations belong here, not in silence.)*
