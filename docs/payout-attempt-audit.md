# Payout attempt audit trail

`repasse_transfer_attempts` is the durable, intent-first trail for Banco Inter
PIX payouts. The open row is committed before `POST /banking/v2/pix`; closing
the row and changing `repasses_recebedor.status` happen in the same database
transaction. A failed close therefore leaves `transferindo` plus an open row.
Redelivery reconciles that row and **does not issue another PIX**.

This document covers Slice 1 only. It does not create a generic payment-event
system or change payout, retry, idempotency, reconciliation, or accounting
rules.

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
private key, raw headers/body, full CPF/CNPJ, PIX key, bank-account data,
recipient name, provider `detail`, violation `valor`, or arbitrary
`razao`/`title` text. The adapter maps only exact known codes/labels and
allowlisted field/reason patterns to application-owned enums.

Banco Inter's official Banking API documents PIX payment creation and its
`codigoSolicitacao`, `tipoRetorno`, validation response, and reconciliation
contract at <https://developers.inter.co/references/banking>. The implementation
uses that shape but retains only the bounded projection above.

## Operator read path

The existing authorized `admin.repasses.show` response includes the diagnostic
projection. The repasse detail page shows HTTP status, correlation identifier,
duration, state transition, and a canonical diagnosis. Historical rows without
structured evidence display diagnosis as unavailable rather than inferring a
cause from `HTTP_400`.

## Verification

Focused synthetic tests cover:

- documented validation field/reason mapping and unknown-response honesty;
- PII/secret canaries never reaching the diagnostic record;
- pre-send, rejected, ambiguous, accepted/pending and paid outcomes;
- one transaction closing the attempt and applying the FSM state;
- a post-provider persistence failure leaving an open intent whose redelivery
  reconciles without calling the provider again;
- migration round-trip, repository recreation, and authorized admin retrieval.

No verification command in this slice calls Banco Inter or uses provider
credentials.
