# EuNeném lifecycle: bounded drain, not unrestricted release safety

## Source boundary

This change composes over observability PR109 at
`e3a96c4d0c067a4dbb5c0f0b0c9564a44383cbdf` (production baseline
`43b11a13d1d901ce8e66bc60ec78dd612d73e011`). It does not change provider
requests, retries, payment states, reconciliation policy, or migration policy.

The platform command directly execs Node with the existing tsx loader. Signal
handling begins before asynchronous worker startup. After registration and
listen, admission/readiness opens. On the first SIGTERM/SIGINT:

1. Close HTTP/business-callback admission synchronously; reachable new HTTP
   requests return 503. A closed listener may instead refuse connections.
2. Stop pg-boss polling with native offWork(wait:false), close the HTTP server,
   and gracefully stop pg-boss. Await an in-progress startup registration before
   the final worker stop so it cannot install an unnoticed late worker.
3. Independently await admitted HTTP handler and worker callback promises.
   Socket closure after a client disconnect and job bookkeeping expiry are not
   proof those JavaScript operations completed.
4. Duplicate signals join this same shutdown promise. Return 0 only for completed
   lifecycle shutdown, not payment success. Deadline/close/stop/startup errors
   return nonzero with fixed value-free categories.

The 420s application deadline is an explicit **best-effort cutoff**, with 450s
Compose grace. A blocked event loop can delay application timers; the supervisor
remains the external termination boundary. A failure may leave an external
financial effect unresolved. It does not cancel it, settle it, authorize replay,
or mark its durable state successful. Existing recovery/lease rules are unchanged.

## Reachable budget evidence (exact composed source)

The live registered reconciliation path is:

- `apps/eunenem-server/server.tsx` registers
  `registerPixCobrancaReconciliationJob` unless the existing disable flag applies.
- `server/jobs/pix-cobranca-reconciliation.pgboss.ts` calls
  `reconciliarCobrancasPix`; its existing queue expiry is 240s.
- `src/use-cases/pagamentos/reconciliar-cobrancas-pix.ts` claims up to 100
  candidates and sequentially awaits `consultarCobranca` and local DB work.
- `src/adapters/pagamentos/pix-cobranca-provider.inter.ts` obtains OAuth then
  performs the charge GET through `InterHttpClient`.
- `src/adapters/pagamentos/inter-http.ts` sets a 30000ms socket-idle timeout.
  This is not a shared absolute OAuth+request+batch+DB deadline.

The SDK's job expiration is bookkeeping, not cancellation of the callback
promise. Thus 420s is not a demonstrated upper bound for all admitted work.
Stripe 18.5 default request retries may alone reach a conservative 360s before
other overhead; this is not a guaranteed bank-result resolution deadline either.
No provider timeout or retry parameter is changed here.

**Retracted evidence:** at exact production 43b and PR109 e3,
`confirmar-transferencia-repasse.ts` is provider-NOOP (retired polling); it only
loads the local repasse and logs the disabled path. `buscarPagamentos` has no
runtime callers in these source trees. The old extrato/200-page path must not be
used as an admitted-work budget or reactivated. An earlier assessment incorrectly
read a stale working checkout; the actual registered charge reconciler above is
the relevant reachable path.

## Native pg-boss limitations

In pg-boss 12.26, offWork(wait:false) synchronously requests worker stop, preventing
the next polling loop. An already-issued database fetch is not canceled: it may
return after the signal. The callback gate prevents newly returned work from
starting business I/O, but this is not an atomic SQL claim barrier. The SDK's
existing failure/retry handling still applies to rejected late callbacks.

Graceful boss.stop can reach its timeout, fail bookkeeping and resolve. Its
configured 421s timeout is beyond the application's 420s nonzero cutoff; independent
callback tracking also prevents an earlier bookkeeping expiration from being
reported as successful shutdown while business code still runs.

## Release gates and recovery

- Single replica remains single replica: draining is not zero downtime.
- Container healthcheck tests readiness after startup, not DB/schema or bank
  convergence. Dokploy job DONE is not a readiness receipt; inspect the exact
  new instance and routed readiness separately.
- A financial/migration release remains an attended maintenance operation with
  an independently reviewed plan. Counting zero jobs then waiting is not an
  admission barrier and does not account for in-flight HTTP.
- Unrestricted deployment remains HOLD. It requires either separately authorized
  cancellation-safe absolute end-to-end budgets and ambiguity-safe recovery, or
  a pre-replacement quiescence mechanism covering active HTTP and jobs which
  aborts replacement if work remains. This patch adds neither release mechanism.
- On a nonzero/forced termination, retain native logs and existing durable state;
  classify unresolved effects under the existing separately authorized recovery
  process. Do not infer safe retry, cancel, replay, or automatic rollback.
- The entrypoint still runs existing migrations before app startup. A signal
  during its migration wait prevents later HTTP startup but does not cancel or
  roll back a migration; shell traps may be deferred until the child returns.

## Offline verification and evidence separation

Existing Vitest tests cover real local Hono and OS signals, installed native
pg-boss Worker/Manager with fake fetch, disconnected clients, keepalive admission,
startup interruption, duplicate signals, deadline nonzero, early bookkeeping
completion, and compose grace/readiness. No DB, provider, payment, live model,
production browser, or deployment is needed for these tests.

The GitHub App's incorrect private-tailnet webhook URL was separately corrected
by the operator to the existing public ingress. Human-provided green deliveries
are transport evidence only. Automation completion still needs one legitimate
reviewed main push under an authorized release window correlated to delivery,
job and the exact running artifact. No empty commit, old push redelivery, manual
deploy fallback or replacement automation is a valid substitute.
