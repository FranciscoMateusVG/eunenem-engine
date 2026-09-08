# Payout attempt audit trail

`repasse_transfer_attempts` is the durable, intent-first trail for Banco Inter
PIX payouts. The open row is committed before `POST /banking/v2/pix`; closing
the row and changing `repasses_recebedor.status` happen in the same database
transaction. A failed close therefore leaves `transferindo` plus an open row.
Redelivery reconciles that row and **does not issue another PIX**.

This document covers the payout-attempt audit trail and its bounded private
error-response follow-up. It does not create a generic payment-event system or
change payout, retry, idempotency, reconciliation, or accounting rules.

## Safe diagnostic projection

New columns are nullable so historical records remain honest. No backfill
guesses why an old request failed.

| Column | Meaning |
| --- | --- |
| `operation` | Application-owned operation enum (`pagar_pix`, `cancelar`, `resolver_manual`). |
| `http_status` | Received provider status, only 100–599. Null when no valid response status was observed. |
| `provider_request_id` | Inter `correlationId` only after a 1–128 character safe-identifier grammar check. |
| `response_class` | Finite transport/response classification. It does not assert settlement. |
| `diagnostic_code` | Finite operator-facing category such as `invalid_pix_key`; unknown stays `diagnostic_unavailable` or generic `provider_rejection`. |
| `diagnostic_field` | Finite request-field category; never the provider's raw property text. |
| `diagnostic_reason` | Finite reason class; never the provider's raw reason text. |
| `duration_ms` | Bounded local elapsed time for the provider call. |
| `state_before`, `state_after` | Observed repasse FSM states closed atomically with the attempt. |
| `provider_error_body_private` | Exact decoded body of a non-2xx PIX payment response, truncated at a complete UTF-8 boundary to at most 16 KiB. Private admin evidence; null for successful, local/pre-send and historical attempts. |
| `provider_error_body_truncated` | Whether the private body exceeded 16 KiB. Null whenever no body was captured. |

The existing `outcome`, `codigo_solicitacao`, `error`, timestamps and stable
`referencia` remain authoritative. In particular:

- `accepted` describes the HTTP/provider response shape, not proof that funds
  settled. `agendado_aprovacao` still moves to `verificando`.
- `ambiguous_http`, `ambiguous_transport`, and `invalid_response` never permit
  automatic retry.
- `pre_send_failure` is used only where the existing money-safety policy proves
  that the PIX request was not sent.
- An unknown or malformed response never becomes a guessed bank cause.

## Data excluded by construction

Never persist or log the access token, Authorization header, certificate,
private key, request body, raw headers, full CPF/CNPJ, PIX key, or bank-account
request data. Never emit the private provider error body to logs, spans, public
DTOs, BEADS, or model-visible output.

The single approved exception is the bounded non-2xx PIX response body on the
private attempt row. It may contain recipient-related provider diagnostics and
is exposed only by the existing authorized admin detail below. It is retained
for the same lifetime as its attempt row; this slice adds no independent purge
job and makes no indefinite-retention guarantee. The finite diagnostic fields
remain the safe summary for normal operation.

Banco Inter's official Banking API documents PIX payment creation and its
`codigoSolicitacao`, `tipoRetorno`, validation response, and reconciliation
contract at <https://developers.inter.co/references/banking>. The implementation
uses that shape but retains only the bounded projection above.

## Operator read path

The existing authorized `admin.repasses.show` response includes the diagnostic
projection. The repasse detail page shows HTTP status, correlation identifier,
duration, state transition, and a canonical diagnosis. When a private body was
captured, the same page offers it in a collapsed, React-escaped block and marks
truncation explicitly. The body is never returned by list procedures.
Historical rows without structured evidence display diagnosis as unavailable
rather than inferring a cause from `HTTP_400`.

## Verification

Focused synthetic tests cover:

- documented validation field/reason mapping and unknown-response honesty;
- PII/secret canaries never reaching the diagnostic record;
- pre-send, rejected, ambiguous, accepted/pending and paid outcomes;
- one transaction closing the attempt and applying the FSM state;
- a post-provider persistence failure leaving an open intent whose redelivery
  reconciles without calling the provider again;
- migration round-trip, repository recreation, and authorized admin retrieval.
- exact and multibyte 16 KiB capture boundaries, success/null behavior,
  private admin rendering, and unauthorized/cross-campaign denial.

No verification command in this slice calls Banco Inter or uses provider
credentials.

## Platform handoff semantics (aperture-62ok9)

For PIX payouts, a documented Banco Inter `POST /banking/v2/pix` 2xx response
with a non-empty `codigoSolicitacao` completes this platform's responsibility.
The repasse moves atomically to `enviado_ao_banco`, stores the receipt in
`inter_codigo_solicitacao`, and records the observed response time in
`enviado_ao_banco_em`.

`enviado_ao_banco` means **request accepted and handed to Inter**. It does not
mean the operator approved the request in the bank application and does not
mean the PIX settled. Consequently the transition does not set
`lancamentos_financeiros.transferido_em`. The linked `id_repasse` claims remain
in place, so the amount cannot be withdrawn again, cancelled back to the
available balance, retried, resent, or manually marked paid through the
existing repasse actions.

Automatic payout confirmation is disabled. New accepted requests do not enqueue
`repasse.confirmar`; ambiguous outcomes remain `verificando` for manual review
without automatic provider reads or resends. The registered confirmation worker
is temporarily drain-only so stale queued jobs cannot contact Inter or mutate
financial state. Collection PIX-in webhooks and reconciliation are unrelated
and unchanged.

### Operator-authorized staging correction

Migration `20260908_052_repasse_bank_handoff` contains a single guarded data
correction for repasse `e2c18fc0-a5f9-4d23-a0e7-104b68327b57`. It runs only when
that row and immutable attempt 4 match the recorded HTTP 200 acceptance receipt,
all linked ledger settlement timestamps remain null, and the repasse is still
`verificando`. It reuses attempt 4's real `finished_at` and existing receipt,
preserves every attempt row, and performs no provider call. A missing target is
a no-op (other environments); a present mismatch aborts the migration.

The correction is intentionally retained with normal repasse/attempt lifetime.
It is not a generic backfill rule and must not be copied for other payouts.
