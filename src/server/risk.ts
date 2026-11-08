import { WINDOW_DAYS, type ReservationState } from '../shared/types.js';
import type { Db } from './db.js';
import { daysBetween } from './dates.js';
import { PayPalError, refundCapture } from './paypal.js';
import { REFUNDABLE, getBatches } from './store.js';

function displayDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * FR-018: a charged buyer was promised shipment within 20 days of the charge. When the plan
 * pushes their batch past that, the reservation becomes AT_RISK; when the plan recovers, it returns to CHARGED.
 */
export function evaluateRisk(db: Db, workspaceId: string, now = new Date()): { atRisk: number; recovered: number } {
  const batches = new Map(getBatches(db, workspaceId, now).map((b) => [b.number, b]));
  const rows = db
    .prepare("SELECT id, state, batch_number, charged_at FROM reservation WHERE workspace_id = ? AND state IN ('CHARGED','AT_RISK') AND charged_at IS NOT NULL")
    .all(workspaceId) as { id: string; state: ReservationState; batch_number: number; charged_at: string }[];
  let atRisk = 0;
  let recovered = 0;
  const toRisk = db.prepare("UPDATE reservation SET state = 'AT_RISK', message = ? WHERE id = ? AND state IN ('CHARGED','AT_RISK')");
  const toCharged = db.prepare("UPDATE reservation SET state = 'CHARGED', message = NULL WHERE id = ? AND state = 'AT_RISK'");
  db.transaction(() => {
    for (const r of rows) {
      const b = batches.get(r.batch_number);
      if (!b) continue;
      const chargedOn = r.charged_at.slice(0, 10);
      const gap = daysBetween(chargedOn, b.shipDate);
      if (gap > WINDOW_DAYS) {
        const msg = `Batch ${b.number} now ships ${displayDate(b.shipDate)}, ${gap} days after this buyer was charged on ${displayDate(chargedOn)}. That breaks the ${WINDOW_DAYS}-day promise. Refund, or move the plan back.`;
        toRisk.run(msg, r.id);
        if (r.state === 'CHARGED') atRisk++;
      } else if (r.state === 'AT_RISK') {
        toCharged.run(r.id);
        recovered++;
      }
    }
  }).immediate();
  return { atRisk, recovered };
}

export class RefundRejected extends Error {
  constructor(message: string, readonly status: number, readonly debugId: string | null = null) {
    super(message);
  }
}

const inFlight = new Set<string>();

/** FR-019: full refund of a charged reservation. Seller-initiated only. */
export async function refundReservation(
  db: Db,
  workspaceId: string,
  reservationId: string,
  deps: { refundCapture?: typeof refundCapture; now?: () => Date } = {},
): Promise<void> {
  const refund = deps.refundCapture ?? refundCapture;
  const now = deps.now ?? (() => new Date());
  const r = db
    .prepare('SELECT state, capture_id FROM reservation WHERE id = ? AND workspace_id = ?')
    .get(reservationId, workspaceId) as { state: ReservationState; capture_id: string | null } | undefined;
  if (!r) throw new RefundRejected('Reservation not found.', 404);
  if (r.state === 'REFUNDED') return;
  if (!REFUNDABLE.includes(r.state) || !r.capture_id) throw new RefundRejected('Only charged reservations can be refunded.', 409);
  if (inFlight.has(reservationId)) throw new RefundRejected('A refund for this reservation is already in progress.', 409);

  inFlight.add(reservationId);
  try {
    let refundId: string;
    let status: string | null;
    let debugId: string | null;
    try {
      ({ refundId, status, debugId } = await refund({
        requestId: `rf-${reservationId}`,
        captureId: r.capture_id,
        note: 'Your pre-order batch slipped beyond the 20-day shipping window, so we refunded your payment.',
      }));
    } catch (err) {
      if (err instanceof PayPalError && err.issue === 'CAPTURE_FULLY_REFUNDED') {
        // Refunded at PayPal already (for example from the PayPal dashboard): reflect it, no second refund.
        db.prepare(
          "UPDATE reservation SET state = 'REFUNDED', refund_status = 'COMPLETED', refunded_at = ?, refund_debug_id = ?, message = 'Already refunded at PayPal.' WHERE id = ? AND state IN ('CHARGED','AT_RISK')",
        ).run(now().toISOString(), err.debugId, reservationId);
        return;
      }
      const pe = err instanceof PayPalError ? err : null;
      throw new RefundRejected(
        pe ? `PayPal refused the refund (${pe.issue ?? `HTTP ${pe.status}`}).` : 'Refund failed.',
        502,
        pe?.debugId ?? null,
      );
    }
    db.prepare(
      `UPDATE reservation SET state = 'REFUNDED', refund_id = ?, refund_status = ?, refunded_at = ?, refund_debug_id = ?,
              message = ? WHERE id = ? AND state IN ('CHARGED','AT_RISK')`,
    ).run(refundId, status, now().toISOString(), debugId, status === 'COMPLETED' ? 'Refunded in full.' : `Refund ${status ?? 'submitted'} at PayPal.`, reservationId);
  } finally {
    inFlight.delete(reservationId);
  }
}
