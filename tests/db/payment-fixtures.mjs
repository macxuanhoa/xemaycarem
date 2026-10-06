import { randomUUID } from 'node:crypto'
import { asUser, rpc } from '../../scripts/db-harness.mjs'

// Explicit synthetic manager verification for existing accounting fixtures.
// Production never grants staff approval; concurrency suites pre-create proposals
// and race the real add_payment RPC rather than this preparation helper.
export async function verifiedPayment(db, actorId, managerId, input) {
  const request_id = input.request_id ?? randomUUID()
  const receipt = await asUser(db, actorId, c => rpc(c,'prepare_payment_receipt','$1::jsonb',[JSON.stringify({
    ...input, request_id, evidence_kind:'MANUAL_RECONCILIATION',
    evidence_scope:'SYNTHETIC TEST FIXTURES', evidence_reference:request_id,
  })]))
  return asUser(db, managerId, c => rpc(c,'add_payment','$1::jsonb',[JSON.stringify({
    request_id, receipt_id:receipt.id, verification_reference:'Synthetic manager verified fixture receipt and ledger',
  })]))
}
