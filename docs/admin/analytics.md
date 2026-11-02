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
