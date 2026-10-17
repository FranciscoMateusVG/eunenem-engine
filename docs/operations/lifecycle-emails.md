# Lifecycle e-mail rollout and recovery

Default: **OFF** (`LIFECYCLE_EMAIL_ENABLED=false`). No production sends were used in tests.

## Enable only after the complete feature lands

The backend depends on the companion templates/preferences/feedback pages. Do not enable until `/email/preferencias`, `/email/descadastrar`, and `/avaliar-email` are mounted and tested. Account settings and every template offer per-type opt-out; unset preferences mean enabled. Authentication and payer PIX receipts are unaffected.

1. Apply additive migration 060 (and companion 061), with normal backup/restore checks.
2. Verify `SMTP_*` configuration in the process's env-file, the verified sender, and `BETTER_AUTH_URL`. Do not print values or credentials. Enabled boot rejects missing SMTP/Noop and any host other than SendGrid.
3. Outside `eunenem.com`, configure `LIFECYCLE_EMAIL_ALLOWED_RECIPIENTS` with an explicit exact synthetic-address allowlist. Non-allowlisted deliveries are suppressed, not redirected. Local automated tests use loopback TLS with a runtime-generated CA and synthetic credentials, never SendGrid.
4. Schedule `LIFECYCLE_EMAIL_LAUNCH_AT` in UTC at first enable and set `LIFECYCLE_EMAIL_ENABLED=true`. First initialization rejects an instant more than five minutes in the past. Once persisted, the instant is immutable; restarting cannot widen the cohort. Accounts AND campaigns must be post-launch; historical self-heal, old members, and pre-launch payments remain excluded.
5. Observe only IDs, states and bounded reason/count metadata. Never log addresses, messages, token-bearing URLs or SMTP error objects.

The shared pg-boss worker wakes each minute, drains through the existing application lifecycle, and scans durable keyset pages of at most 100 candidates per type. A deployment restart resumes the persisted cursors. Ineligible/corrupt candidates cannot starve later records. The scanner recovers payments only after ten minutes, validates the financial ledger, and uses **owner-only** recipients when a contemporaneous membership snapshot was lost. Newly added members never receive historical payments.

## Delivery semantics

- First gift is recorded by an INSERT trigger inside the gift transaction, including bulk/templates. Deleting/readding gifts does not reset the marker. Delivery waits for completed domain provisioning; a persisted expected-gift-count plan recovers the final-write/return crash window.
- D−5 is the civil date in `America/Sao_Paulo`, at or after 09:00 on that day only. A changed unsent date may rearm the occurrence. Sent or ambiguous outcomes never rearm. Missing/late/changed dates suppress an outdated delivery.
- Claims are short SQL transactions. SMTP runs outside transactions. Current verified email, tenant, membership/permission, account/campaign cohort and preferences are revalidated before sending. Permission revocation during the actual SMTP operation remains an unavoidable residual race.
- SMTP acceptance and the local `sent` write are not atomic. Explicit rejection can retry with bounded backoff (up to three attempts); permanent rejection fails immediately. An interrupted/ambiguous SMTP operation is **unknown**, not retried. A `sending` claim older than 15 minutes becomes unknown. Nodemailer reconnect requeues are disabled; network timeouts are bounded. Never promise exactly-once delivery.
- Click rewriting and open pixels are disabled per message through SendGrid SMTP filters.
- Preference links are scoped and HMAC-signed without email addresses. Per-type unsubscribe links last ten years; manage/feedback links last 30 days. GET is read-only; POST changes state. Expired management links offer authenticated preferences. Secret rotation invalidates old links.

## Roll back / investigate

Set `LIFECYCLE_EMAIL_ENABLED=false` and roll the deployment normally. New work is disabled; already-admitted SMTP can finish during coordinated drain. Preserve all ledger/preference tables and the launch marker. Re-enable with the **same** launch instant. Do not delete events or reset `unknown` rows to pending. Inspect SendGrid acceptance evidence out of band before any separately authorized manual resend; no automated unknown retry endpoint exists.

A failure of optional e-mail provisioning callbacks is logged by ID and never compensates an otherwise successful account creation. If both the plan write and final completion write fail, the scanner deliberately does not guess a completed signup from a user row; investigate that bounded failure signal rather than backfilling accounts unsafely.

Retention/erasure of protected payment snapshots and feedback requires an approved policy. No speculative destructive purge is installed. Ledger uniqueness must survive any later payload redaction.
