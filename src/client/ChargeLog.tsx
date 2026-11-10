import { Download } from 'lucide-react';
import type { ChargeLogRow } from '../shared/types';
import { toCsv } from '../shared/csv';
import { formatDate } from './api';

const OUTCOME: Record<ChargeLogRow['outcome'], string> = {
  PENDING: 'Sending',
  COMPLETED: 'Captured',
  DECLINED: 'Declined',
  FAILED: 'Refused',
  REVOKED: 'Revoked at PayPal',
  UNKNOWN: 'Awaiting PayPal',
  SKIPPED: 'Skipped, left window',
};

function exportCsv(rows: ChargeLogRow[]) {
  const csv = toCsv(
    ['time', 'buyer', 'batch', 'batch_ships', 'amount_usd', 'outcome', 'attempt', 'http_status', 'paypal_order', 'paypal_capture', 'paypal_debug_id', 'detail', 'paypal_webhook_status'],
    rows.map((r) => [
      r.finishedAt ?? r.createdAt, r.buyerEmail, r.batchNumber, r.shipDate, r.amount, r.outcome, r.attemptNo,
      r.httpStatus, r.orderId, r.captureId, r.paypalDebugId, r.detail, r.webhookStatus,
    ]),
  );
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `batchday-charge-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ChargeLog({ rows }: { rows: ChargeLogRow[] }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Charge log</h2>
        {rows.length > 0 && (
          <button type="button" className="small-btn" onClick={() => exportCsv(rows)}>
            <Download size={16} strokeWidth={1.5} aria-hidden="true" /> Export CSV
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="muted">No charges yet. Reservations are charged automatically once their batch ships within 20 days.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th><th>Buyer</th><th>Batch ships</th><th>Amount</th><th>Outcome</th>
                <th>PayPal order</th><th>Capture</th><th>Debug ID</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.finishedAt ?? r.createdAt).toLocaleString()}</td>
                  <td>{r.buyerEmail ?? '-'}</td>
                  <td>Batch {r.batchNumber}, {formatDate(r.shipDate)}</td>
                  <td>${r.amount}</td>
                  <td>
                    <span className={`badge o-${r.outcome.toLowerCase()}`}>{OUTCOME[r.outcome]}</span>
                    {r.attemptNo > 1 && <div className="muted small">Attempt {r.attemptNo}</div>}
                    {r.detail && <div className="muted small">{r.detail}</div>}
                    {r.webhookStatus && (
                      <div className={r.webhookStatus === 'COMPLETED' ? 'ok small' : 'error small'}>
                        {r.webhookStatus === 'COMPLETED' ? 'Confirmed by PayPal webhook' : `PayPal webhook: ${r.webhookStatus.toLowerCase()}`}
                      </div>
                    )}
                  </td>
                  <td className="mono">{r.orderId ?? '-'}</td>
                  <td className="mono">{r.captureId ?? '-'}</td>
                  <td className="mono">{r.paypalDebugId ?? '-'}{r.httpStatus ? <div className="muted small">HTTP {r.httpStatus}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
