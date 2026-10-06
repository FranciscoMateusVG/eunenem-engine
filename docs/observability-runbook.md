# EuNeném observability evidence and runbook

This runbook records what the current system can prove. It deliberately keeps
four states separate: **configured**, **accessible**, **ingesting**, and
**alert-delivered**. A DSN in a container is not evidence of the latter three.

Baseline for this audit: engine commit `43b11a13d1d901ce8e66bc60ec78dd612d73e011`,
production image digest suffix `810d1318` (full digest remains in the private
deployment receipt), 2026-09-13.

## Evidence matrix

| Gap | Source evidence | Runtime evidence | Current verdict |
| --- | --- | --- | --- |
| Log retention | Both server compose files omit a `logging` policy. Production constructs `ConsoleLogger` and `noopTracer`; logs go only to stdout/stderr. | The running container uses `json-file` with an empty options object. Docker daemon defaults, host capacity, rotation, forwarding, and retained-search duration were not inspected. | **Configured:** stdout only. **Retention/loss:** unbounded and runtime-dependent; searchable retention is not proven. |
| Browser capture | `client.tsx` hydrates without a browser Sentry SDK, error boundary, `window.onerror`, or `unhandledrejection` handler. Production client builds omit source maps. | Public-browser inspection found no Sentry global or error-report request on the new site. The legacy site attempted Sentry ingestion but received HTTP 429 during the bounded witness. | New-site browser errors: **not configured / not captured**. Legacy ingestion: **failed in the witnessed window**. |
| GlitchTip access and alerts | `@sentry/node` initializes first when `GLITCHTIP_DSN` exists, with error-only `tracesSampleRate: 0`. Before this change there was no normal Hono/tRPC error boundary. Environment is only `NODE_ENV`; release identity is absent. | `GLITCHTIP_DSN` is non-empty in the running container; value was not read. No dashboard access receipt, event receipt, alert rule, or delivered notification was available. | **Configured:** server DSN yes. **Accessible / ingesting / alert-delivered:** `NOT_RUN` or unavailable, not PASS. |
| Request/payment/webhook correlation | Before this change there was no request ID. Durable payment paths do retain domain/provider evidence: webhook archive IDs and provider event IDs; payout attempts retain `idRepasse`, attempt data, response class, bounded provider request ID, and a private 16 KiB body with a truncation flag. Inter callback archives intentionally retain an identifier projection rather than the unsigned full batch. | Public `auth.me` returned no request or trace header before this change. No financial/provider call was made for this audit. | Request correlation was absent. This change adds a server-owned `X-Request-Id`, inherits it into request-scoped console logs, and captures sanitized internal failures. Queue jobs remain correlated by durable business IDs, not an HTTP request ID. |

## Source correction in this change

1. Every Hono response receives a fresh, server-generated `X-Request-Id`.
   Incoming values are ignored, so a caller cannot forge a correlation link.
2. The ID is available to nested `ConsoleLogger` calls through
   `AsyncLocalStorage`; request context overrides a same-named call-site attr.
3. Unhandled Hono failures, handled 5xx responses, and tRPC
   `INTERNAL_SERVER_ERROR` results emit one fixed `http.request.failed` record
   and one GlitchTip exception when the SDK is enabled.
4. The event contains only request ID, bounded method, registered route,
   status, source category, and sanitized stack frames. It excludes the raw
   URL/query, request/response bodies, headers, cookies, authorization, and the
   original error message.
5. CORS exposes `X-Request-Id` to the first-party browser. The middleware does
   not consume request bodies and therefore preserves BetterAuth and webhook
   raw-body signature verification.

This is not browser error capture, trace export, log forwarding, or proof that
GlitchTip accepted an event.

## Read-only diagnostic procedure

### 1. Pin the artifact

Record the canonical git SHA and deployed image receipt. Do not infer a deploy
from a branch name or container creation timestamp.

### 2. Verify request correlation after deployment

Use a harmless public request:

```sh
curl -sS -D - -o /dev/null https://eunenem.com/healthz \
  | grep -i '^x-request-id:'
```

Expected: one UUID response header. This proves only the HTTP boundary. With
approved host log access, search the exact returned ID without surrounding log
context, because adjacent lines can contain unrelated customer activity:

```sh
docker logs --since 5m SERVER_CONTAINER 2>&1 \
  | grep -F '"requestId":"THE_RETURNED_UUID"'
```

A healthy 200 intentionally emits no completion line, so log correlation is
verified using the next naturally occurring application event for that ID; do
not fabricate a 500.

### 3. Verify retention separately

Infrastructure owner inspects only the application container's logging driver
and option names. Current evidence is `json-file` plus an empty options object.
Before claiming retention, record all of:

- driver and explicit rotation options;
- destination/collector, if any;
- searchable duration and oldest/newest retained timestamps;
- disk-capacity alert and owner;
- behavior across one ordinary deploy.

Until an approved explicit policy exists, local JSON logs can grow until host
or daemon behavior intervenes. Adding more application logs without a bound
would improve diagnosis by making disk exhaustion arrive earlier. That is not
an improvement.

### 4. Verify GlitchTip without a fabricated production error

Using the existing dashboard/access path, locate a naturally occurring event
whose timestamp and deployed artifact are independently known. Record:

- access succeeded;
- project and environment label;
- event ID and timestamp;
- deployed release identity, or `UNAVAILABLE` while release tagging is absent;
- whether the event is server process-fatal, request, job, or browser sourced;
- the matching alert rule and delivered notification receipt, if any.

If no event exists, report **ingestion NOT_PROVEN**. Do not create a payment,
replay a webhook, throw a production canary, or claim alert delivery from the
presence of a rule.

### 5. Correlate payment incidents from durable evidence

- HTTP/server failure: start with `X-Request-Id` and the fixed
  `http.request.failed` record.
- Stripe/Inter callback: use the operator admin payment/webhook evidence
  surfaces to move from provider event ID to archive ID and payment ID.
- Payout: use the admin repasse attempt history (`idRepasse`, attempt number,
  response class, bounded provider request ID, and truncation flag). The private
  provider body remains server-side and is not copied into tickets or logs.
- Background workers: use `idPagamento`/`idRepasse` and durable attempt/archive
  rows. An HTTP request ID is not preserved across a later queue delivery.

Never infer provider settlement from a log line, a 2xx handoff, or absence of a
failure event. Provider truth and the durable payment state remain separate.

## Open operational gates

1. Approve and apply explicit Docker log rotation/retention compatible with the
   actual platform collector; then verify the running container options.
2. Establish GlitchTip dashboard ownership/read access, a real release tag and
   distinct deployment environment, ingestion evidence from a natural event,
   and one delivered-alert receipt.
3. Scope browser error capture as a separate client project/DSN with production
   source-map handling and abuse/privacy review.
4. Bound Stripe webhook request/signature sizes before archival and add one
   terminal correlation record per webhook outcome.
5. Add an application healthcheck only after its DB/worker semantics are
   specified; current `/healthz` is liveness-only.

## Browser error capture delivery contract

The Hono SSR client is bundled directly from `apps/eunenem-server/client.tsx`
by esbuild. It is not a Next.js or Vite runtime. Browser capture initializes
before the application module is loaded and before React hydration.

Capture stays dark unless both of these values are present and valid:

- `GLITCHTIP_BROWSER_DSN`: a dedicated public browser-ingestion DSN. It must
  not equal or fall back to the server `GLITCHTIP_DSN`. A separate browser
  client key in the existing EuNeném project is sufficient; a new project is
  not required. Configure the project for exactly `https://eunenem.com` and
  `https://www.eunenem.com` when GlitchTip supports origin restrictions. If it
  does not, record that public-key submissions are forgeable and rely on key
  revocation plus ingestion limits; CORS is not authentication.
- `artifact-sha256:<64 lowercase hex>`: generated automatically after the
  build from the exact final `public/client.js` and `public/styles.css` bytes,
  using a fixed domain and ordered length framing. It identifies the browser
  assets, not the Git commit or full server image. The deployment receipt maps
  this ID to the canonical commit and image.

The build never takes a manually updated release environment variable. It
writes a small release metadata file outside the hashed inputs, avoiding a
self-reference. The server reads that metadata once at startup and projects
only `browserErrorDsn` and `release` into the existing script-safe
`window.__EUNENEM_ENV__` object. Missing assets/metadata, read failure, invalid
or partial configuration emits neither browser field and does not block SSR or
hydration. The client also initializes only on the two exact production
origins above; that client check is not an ingestion authentication boundary.

The browser SDK has no default integrations. There is no replay, tracing,
session tracking, breadcrumbs, console/fetch/history capture, user identity,
or tunnel. Window errors, unhandled Promise rejections, and the React 19 root
error callbacks share one bounded dedupe and one closed event envelope:

- fixed failure type/message;
- exact release, finite error-source category, and `resolveRoute` route kind;
- at most 20 frames containing only a fixed bundle/application category and
  bounded numeric line/column;
- no raw URL, route parameter, query/hash, filename/function, exception
  message/cause, component stack, DOM/input, request data, or attachments.

### One-shot post-deploy witness

This witness is intentionally a browser-console action, not a committed crash
route or test button. After the deployed bundle and exact release value are
independently pinned, the operator may open a harmless route such as `/faq`
and execute once in DevTools:

```js
queueMicrotask(() => {
  throw new Error('sq4jn-browser-witness');
});
```

The literal is deliberately discarded by the client boundary. Identify the
event in the EuNeném frontend project by the exact release, fixed
`BrowserUnhandledError` type, `route_kind=faq`, and the bounded witness time.
Record the GlitchTip event ID and receipt. Do not repeat against a payment
route, add a permanent crash surface, or call a provider. Until that receipt
exists, source/build success is not ingestion proof.
