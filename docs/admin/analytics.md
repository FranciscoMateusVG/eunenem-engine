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
