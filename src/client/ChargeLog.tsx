import type { ChargeLogRow } from '../shared/types';
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

export function ChargeLog({ rows }: { rows: ChargeLogRow[] }) {
  return (
    <div className="panel">
      <h2>Charge log</h2>
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
