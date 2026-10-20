# 45h33 — manual recovery from VERIFICANDO

No migration. No production calls or real payments were performed.

## Admin contract
- Every VERIFICANDO has “Confirmei que saiu” (bank reference + reason) and
  “Confirmei que NÃO saiu” (fresh read-only bank lookup + statement).
- Paid resolution stamps the existing ledger once under the existing payment
  locks and repasse row lock. It does not call the payment provider.
- Retry queries the original codigoSolicitacao, never the local EN reference.
  Positive/in-flight response, matching debit or debit without verifiable
  destination blocks retry. PIXP97/404/no strong ID/empty statement is inconclusive.
- Inconclusive needs reason, statement evidence, period covering attempt ±24h,
  typed amount, and every dismissed other-recipient E2E. Session supplies actor.
- Submission reads the bank again and compares evidence digest and original
  attempt count. The client cannot supply classifications.
- One short transaction locks/revalidates VERIFICANDO and original attempt,
  audits authorization, sets aprovado and enqueues inside the transaction.
  Worker claiming permits one new send. Original reference/history survives.
- Audit sequence is separate from the count of actual transfer attempts:
  manual audit rows cannot collide with the next worker attempt.
- The previous unchecked resolverManualFalhou endpoint now fails closed.

## Provider contract (verified 2026-10-19)
Official OpenAPI: https://developers.inter.co/redocusaurus/swagger-banking-yaml.yaml

GET /banking/v2/extrato/completo, DetalhePix documents string fields
endToEndId, nomeRecebedor, cpfCnpjRecebedor, chavePixRecebedor and
codigoSolicitacao. Absence never hides a debit. Malformed/incomplete pagination
is not a clean empty statement.

Normalized matching destination or original PIX-key fingerprint blocks the debit.
A clearly different complete identity requires explicit E2E dismissal. Missing
or masked identities block. Date-only rows are conservatively retained for the
entire requested bank-day window. No raw provider payload goes into the recovery
response or audit; no plaintext key is logged.

## Evidence
Real PostgreSQL + loopback HTTP tests cover positive/negative/404/PIXP97,
matching/other/unknown destination, mandatory attestation fields, concurrent
recovery, queue rollback and two worker claims. No external transport.
Initial screen rendering uses real React/tRPC providers.
