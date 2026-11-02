# Admin analytics read models

Additive admin-only `admin.analytics.*`, input `{meses: 3 | 6 | 12}` (default 3).
Existing `admin.estatisticas` and `admin.receita` remain unchanged.

## Calendar

Reuses `receitaPeriodo` São Paulo calendar helpers. Selected window starts on
first day of the earliest selected month and ends at the server snapshot (not
at the end of today). `periodo.ate` is the exclusive local day boundary for
presentation; `snapshotAt` is the exact data cutoff. Month buckets have natural
calendar boundaries; ISO Monday weeks cover the same filtered window, with
partial edge buckets flagged. Zero buckets are retained.

## Funil

`usuarios.criado_em` acquisition cohorts, active users only, same internal/QA
exclusion as existing statistics. `onboarding_concluido_em` is the onboarding
milestone. `campanha_administradores.id_usuario` links to **usuarios.id_conta**;
`campanhas.criada_em` identifies list creation. First gift is evidenced by a
`credito_receita_plataforma` ledger row for any linked campaign/payment, before
snapshot, even if subsequently refunded. Multiple campaigns/items do not
multiply users. Membership is current; historical ownership is not stored.

There is no publication state/date. Lists are auto-created at signup, so
`lista_publicada` is deliberately folded into `lista_criada`, not invented.
All totals, origins and time series use registration cohorts and milestone
reach by snapshot. Milestones are independently observed, **not a strictly
ordered path**; creation may precede onboarding. Ratios between adjacent steps
can exceed 100% and must not be described as sequential conversion probability.

First-touch `signup_*` fields: Google click IDs or Google paid-search UTM →
`google_ads`; explicit organic medium or recognized search referrer with no
campaign source → `organico`; captured without source/medium/referrer → `direto`;
other attribution → `outros`; absent capture → `desconhecida` (no legacy backfill).

## Vendas

GMV is gross gift contribution subtotal, excluding platform fees and card
surcharge. Approval is the earliest platform-revenue ledger timestamp per
payment (same evidence as Receita), not mutable payment status. Subsequent
refunds remain in **gross** sales. Gift count sums contribution item quantities;
PIX/card counts count payments, not units. Average ticket is rounded GMV per
gift unit; null without units. All amounts are integer cents.

Sales time series use approval date. PIX generated/paid/expired instead use
**intent creation cohorts**, as of snapshot: generated requires an external
reference; paid requires ledger evidence; expired means unpaid with expiration
at/before snapshot, even if the reconciliation job has not updated status yet.
Pending unexpired payments remain in the denominator and these rates need not
sum to 100%. Failed creation without an external reference is not generated.

Every query scopes through the EuNeném platform. Vendas includes all platform
payments (unlike the Funil active/non-QA acquisition population); it is not a
reconciliation of the funnel population. Each query is a single SQL snapshot.

## Saúde/erros

- `provedor`: historical failed/unknown checkout attempt facts, plus Inter payout
  attempt diagnostics joined through payout/campaign platform. Raw provider text
  comes from existing private diagnostic columns: the stored body is the raw
  provider response, while OUR request credentials/headers are never persisted.
  Additional auth-token pattern redaction protects the admin response. Recent
  messages are bounded to 2 KiB characters with `truncado`; admin-only
  `admin.analytics.saudeDetalhe({id})` returns the complete stored diagnostic
  with that same credential-pattern defense for an expanded view.
- `checkout`: currently `failed`/`outcome_unknown` operations, at `updated_at`.
- `webhook`: currently unprocessed rows with processing errors, at last processing
  start (or received date). Explicit ingress platform wins; older null-ingress
  rows need a payment/campaign proving platform. Unattributed rows are excluded.
- `email`: currently failed/unknown lifecycle deliveries, at last claim (or event
  occurrence). **No failure timestamp/history exists**, so these are proxies.
  Other SMTP sends without durable delivery records cannot be measured here.

These categories overlap: a provider attempt can also leave a failed checkout.
Do not sum categories as unique incidents. Only provider attempts have durable
historical failure evidence; recovery removes current errors from the other
series. Dates do not claim complete historical failure rates. Totals and daily
counts are independent of the 50-row newest-first recent list. No webhook
payloads, signatures, checkout snapshots or email snapshots are returned.

## Tráfego (Mixpanel)

Production composition constructs `AdminTrafficReader` from four server-only env
vars: `MIXPANEL_PROJECT_ID`, `MIXPANEL_SERVICE_ACCOUNT_USERNAME`,
`MIXPANEL_SERVICE_ACCOUNT_SECRET`, `MIXPANEL_API_REGION` (US/EU/IN). Both compose
files pass these at runtime, never as build args or browser runtime data.

Read-only [Segmentation API](https://docs.mixpanel.com/reference/segmentation-query),
service-account Basic auth, fixed region hosts, redirects forbidden. This legacy
endpoint is in maintenance; current saved Insights requires a bookmark and does
not document dynamic date overrides. No reports/project settings are mutated.
Peppy verified project 4045181 timezone is **US/Pacific**, with no saved ordered
entry→signup funnel. Charts therefore explicitly use America/Los_Angeles days,
not São Paulo. No silent hourly/daily timezone conversion is attempted.

Visits mean `page_view_custom` events (not sessions); signup means `conta_criada`
events (lazy server emission; not necessarily the original signup instant).
`visitantes` and `conversaoPct` are null: summing daily uniques is not unique
visitors, and dividing independent event counts is not an ordered funnel.
Sources are event `utm_source`, not proven signup attribution; absent source is
unknown, never direct. First-touch DB attribution remains in Funil. The top 50
source values are grouped into finite safe labels; remaining source values are
not detailed, and totals are queried separately to avoid top-N undercounting.
Mixpanel may include imported/legacy events and traffic outside DB cohort rules.

Four requests per 12-month refresh, at most four concurrent, one shared 8-second
abort deadline including body reads, 2 MiB response cap each, schema/count
validation. One in-flight request and one cache per server instance, shared by
all 3/6/12 selectors: 20-minute success TTL, 5-minute failure TTL. No upstream
errors/auth/URLs/raw source strings are surfaced. Failure returns `disponivel:
false` with a safe Portuguese reason (zero placeholders are not observed data).
Cache is process-local; multiple server instances have independent limits.

## Listas

`admin.analytics.listas` uses lists **created in the selected window**, with at
least one currently active, non-QA administrator under the same explicit
exclusions as Estatísticas. An ownerless/QA-only list is not silently classified
as a new customer. First-touch origin uses the earliest eligible administrator
(by registration/id); legacy is `sim` if any eligible administrator matches the
existing private legacy snapshot, `nao` only with a configured complete snapshot,
otherwise `desconhecido`. Cohort origin×legacy partitions are disjoint; no
identity/name/email is returned. This is current ownership, not creator history.

Each metric supplies a Portuguese `cobertura` label, denominator and observed
count. Percentages are 0–100; absent/nonpositive denominators yield null.

- First gift: earliest platform-fee ledger approval, never payment updated_at.
  Median/p90 are conditional on having a first payment. Unpaid lists remain in
  totals. D7/14/30 rates include only lists at least that old; horizons are
  elapsed 24-hour days with half-open `[creation, creation + D)` windows.
- Monthly cohorts: D7/30/60 exclude immature lists, report their count, and use
  gross approved gift GMV. Observed margin = platform fees minus cancellations
  and matched BRL cost events inside the horizon. Costs observed later remain
  eligible when their occurrence is inside the horizon; all facts must be known
  by the snapshot. Missing cost observations are unknown, never proof of zero
  fees. No fixed-cost allocation, no net-profit claim.
- Payers: normalized nonempty contributor email from approved payments. Global
  unique/repeat counts across selected lists; per-list p50/p90 include zero
  lists. A repeat means >1 approved payment, not a proven unique human.
- Risk: disjoint event-distance bins 0–3/4–7/8–14 days; no first payment and no
  payment in the last seven elapsed days are independent, overlapping labels.
  Uses current `eventos.data_hora`; missing event dates excluded and counted.
- Curve: zero-filled D−30…D+7 on São Paulo calendar dates relative to the current
  event date. Date edits have no history and future windows are incomplete.
- Concentration: top-ten list shares of gross GMV and observed contribution
  margin, no names. Zero revenue means platform fees minus reversals equals
  zero. Margin share is null when aggregate margin is nonpositive; with negative
  tail margins, a positive top-ten share may exceed 100% (not capped).

## Financeiro

`admin.analytics.financeiro` reuses the active/non-QA current-owner campaign scope.

- Contribution margin uses the **approval cohort of payments in the selected
  window**, current known fees − reversals − linked BRL provider costs. Per-list
  percentiles include lists with at least one such payment (zero-sale lists are
  covered separately by Listas). Money percentiles are rounded to cents. This
  is not the existing Receita event-date accounting series and not net profit.
  Missing costs, unlinked provider fees and fixed costs are not invented.
- Payout timing uses the request cohort: requested→transferred and
  payout-approved→transferred are distinct distributions. Transfer timestamp
  requires ledger `transferido_em`, or a finished attempt whose outcome is
  `pago`; `aprovado_em` alone never proves bank arrival. Paid records without a
  usable marker are counted separately. Aging includes only currently nonpaid,
  noncancelled payouts in the request cohort. Manual confirmation can be late.
- MED is grouped by occurrence cohort and current status. Stripe/Pix refunds
  are grouped by record-creation cohort and confirmed current outcome. MED,
  refunds and prior transferred payment amounts can overlap; never sum them as
  unique loss/exposure. Transferred amount is the actual receiver ledger total
  of the contested payment, not a capped net-loss estimate. Recovery **by the
  platform** remains null: refund to payer, released MED reserve and collection
  from a creator are not equivalent. There is no complete chargeback/receipt
  event history; absence of a recorded case is not proof of no exposure.

## Additional funnel, price and email coverage

- `funil.checkout` cohorts provider operations by reservation date. Current state
  counts do not claim ordered browser stages. Failed/unknown result attempts are
  deduplicated to operation; recovery requires later provider success evidence
  (or local commit) on the same operation. Provider success is not approval of
  payment. Recovery denominator is operations with recorded error, not attempts
  or visitors. Cross-operation logical purchases and PIX→card switches remain
  null: existing IDs cannot establish those links reliably.
- `vendas.faixasPreco` contrasts **current** available non-archived gift units,
  after approved-payment consumption, against gross paid item snapshots first
  approved in the window. Bounds are exclusive at the upper end, in cents.
  Refunded gifts remain historical purchases; their current availability follows
  the existing catalog rule. Missing historical prices are excluded from bands
  and reduce observed coverage. Current catalog is not historical exposure,
  replenishable quantities are not a stable completion denominator.
- `saude.emailCobertura` counts registered lifecycle event cohorts by occurrence
  with current eligible recipient states. Campaign events require eligible
  ownership; user events require an eligible user. Recipient QA exclusions apply
  separately. Event counts are distinct, states count delivery records (multiple
  recipients per event). Admission may omit events without an eligible recipient,
  so registered events are not all potential eligible users. Sent means accepted
  for sending, not delivery; no inferred click, causality or missing history.

Each additional block includes a Portuguese limitation note and explicit
observed/denominator counts. Codes remain raw for client translation. All queries
stay admin-only and tenant-scoped; no payer/recipient identities are returned.
