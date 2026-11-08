import type { ChargeLogRow, ChargeOutcome, ReservationState } from '../shared/types.js';
import type { Db } from './db.js';
import { PayPalError, type ChargeResult, chargeVault } from './paypal.js';
import { getBatches, getCampaign } from './store.js';

/** CHARGE_FAILED gets one automatic retry (state model), so at most two failed attempts. */
const MAX_FAILED_ATTEMPTS = 2;
/** A CHARGING reservation whose last attempt has no final answer after this long is resumed. */
const RESUME_AFTER_MS = 60_000;
const PENDING_APPROVAL_TTL_MS = 3 * 86_400_000;

export interface EngineDeps {
  db: Db;
  paypal?: { chargeVault: typeof chargeVault };
  now?: () => Date;
}

export interface EngineSummary {
  charged: number;
  failed: number;
  revoked: number;
  unknown: number;
  skipped: number;
  outsideWindow: number;
}

interface Candidate {
  id: string;
  state: ReservationState;
  batch_number: number;
  vault_id: string;
}

interface Attempt {
  attemptNo: number;
  requestId: string;
  shipDate: string;
}

const running = new Map<string, Promise<EngineSummary>>();

/** Ship date and window status of a batch, read fresh from the stored plan. */
function batchWindow(db: Db, workspaceId: string, batchNumber: number, now: Date) {
  return getBatches(db, workspaceId, now).find((b) => b.number === batchNumber) ?? null;
}

/**
 * Atomically moves one reservation into CHARGING and records a PENDING attempt.
 * BR-001 is checked inside the same transaction. Returns null when the reservation
 * is no longer chargeable (another run took it, it was cancelled, or its batch left the window).
 */
function claim(db: Db, workspaceId: string, reservationId: string, amount: string, now: Date): Attempt | null {
  return db.transaction((): Attempt | null => {
    const r = db.prepare('SELECT state, batch_number, vault_id FROM reservation WHERE id = ?').get(reservationId) as
      | { state: ReservationState; batch_number: number | null; vault_id: string | null }
      | undefined;
    if (!r || r.batch_number === null || !r.vault_id) return null;
    const batch = batchWindow(db, workspaceId, r.batch_number, now);
    if (!batch?.inWindow) return null;

    const last = db
      .prepare('SELECT attempt_no, request_id, outcome, created_at FROM charge_attempt WHERE reservation_id = ? ORDER BY attempt_no DESC LIMIT 1')
      .get(reservationId) as { attempt_no: number; request_id: string; outcome: ChargeOutcome; created_at: string } | undefined;

    if (r.state === 'CHARGING') {
      // Resume an attempt whose outcome is unknown, with the same PayPal-Request-Id.
      if (!last || !['PENDING', 'UNKNOWN'].includes(last.outcome)) return null;
      if (last.outcome === 'PENDING' && now.getTime() - Date.parse(last.created_at) < RESUME_AFTER_MS) return null;
      db.prepare("UPDATE charge_attempt SET outcome = 'PENDING', finished_at = NULL WHERE request_id = ?").run(last.request_id);
      return { attemptNo: last.attempt_no, requestId: last.request_id, shipDate: batch.shipDate };
    }

    if (r.state === 'CHARGE_FAILED') {
      const failures = (db
        .prepare("SELECT COUNT(*) AS n FROM charge_attempt WHERE reservation_id = ? AND outcome IN ('DECLINED','FAILED')")
        .get(reservationId) as { n: number }).n;
      if (failures >= MAX_FAILED_ATTEMPTS) return null;
    } else if (r.state !== 'RESERVED') {
      return null;
    }

    const attemptNo = (last?.attempt_no ?? 0) + 1;
    const requestId = `bd-${reservationId}-${attemptNo}`; // FR-009: stable per reservation and attempt
    const moved = db
      .prepare("UPDATE reservation SET state = 'CHARGING', message = NULL WHERE id = ? AND state = ?")
      .run(reservationId, r.state).changes;
    if (moved !== 1) return null;
    db.prepare(
      `INSERT INTO charge_attempt (workspace_id, reservation_id, attempt_no, request_id, amount, ship_date, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    ).run(workspaceId, reservationId, attemptNo, requestId, amount, batch.shipDate, now.toISOString());
    return { attemptNo, requestId, shipDate: batch.shipDate };
  }).immediate();
}

function finish(
  db: Db,
  reservationId: string,
  requestId: string,
  outcome: ChargeOutcome,
  next: ReservationState | null,
  fields: { httpStatus?: number | null; debugId?: string | null; orderId?: string | null; captureId?: string | null; detail?: string | null },
  now: Date,
) {
  db.transaction(() => {
    db.prepare(
      `UPDATE charge_attempt SET outcome = ?, http_status = ?, paypal_debug_id = ?, order_id = ?, capture_id = ?, detail = ?, finished_at = ?
        WHERE request_id = ?`,
    ).run(
      outcome, fields.httpStatus ?? null, fields.debugId ?? null, fields.orderId ?? null, fields.captureId ?? null,
      fields.detail ?? null, now.toISOString(), requestId,
    );
    if (next === 'CHARGED') {
      db.prepare(
        "UPDATE reservation SET state = 'CHARGED', charged_at = ?, order_id = ?, capture_id = ?, message = ? WHERE id = ? AND state = 'CHARGING'",
      ).run(now.toISOString(), fields.orderId ?? null, fields.captureId, fields.detail ?? null, reservationId);
    } else if (next) {
      db.prepare("UPDATE reservation SET state = ?, message = ? WHERE id = ? AND state = 'CHARGING'").run(
        next, fields.detail ?? null, reservationId,
      );
    }
  }).immediate();
}

async function chargeOne(deps: Required<EngineDeps>, workspaceId: string, c: Candidate, summary: EngineSummary) {
  const { db, paypal } = deps;
  const campaign = getCampaign(db, workspaceId)!;
  const attempt = claim(db, workspaceId, c.id, campaign.unitPrice, deps.now());
  if (!attempt) return;

  // BR-001, second check: re-read the plan immediately before the PayPal call.
  const now = deps.now();
  const batch = batchWindow(db, workspaceId, c.batch_number, now);
  if (!batch?.inWindow) {
    finish(db, c.id, attempt.requestId, 'SKIPPED', 'RESERVED', { detail: 'Batch left the 20-day window before the charge was sent' }, now);
    summary.skipped++;
    return;
  }

  let result: ChargeResult;
  try {
    result = await paypal.chargeVault({
      requestId: attempt.requestId,
      vaultId: c.vault_id,
      amount: campaign.unitPrice,
      currency: campaign.currency,
      referenceId: c.id,
      description: `${campaign.productName}, batch ${c.batch_number}`,
    });
  } catch (err) {
    const pe = err instanceof PayPalError ? err : new PayPalError('Unexpected error', 0, null, null);
    const done = deps.now();
    if (pe.status === 403) {
      finish(db, c.id, attempt.requestId, 'REVOKED', 'REVOKED', {
        httpStatus: 403, debugId: pe.debugId, detail: `PayPal rejected the saved wallet (${pe.issue ?? 'PERMISSION_DENIED'})`,
      }, done);
      summary.revoked++;
    } else if (pe.status >= 400 && pe.status < 500) {
      finish(db, c.id, attempt.requestId, 'FAILED', 'CHARGE_FAILED', {
        httpStatus: pe.status, debugId: pe.debugId, detail: `PayPal refused the charge (${pe.issue ?? `HTTP ${pe.status}`})`,
      }, done);
      summary.failed++;
    } else {
      // 5xx or no response: PayPal may have charged. Stay CHARGING and resume with the same request id.
      finish(db, c.id, attempt.requestId, 'UNKNOWN', null, {
        httpStatus: pe.status || null, debugId: pe.debugId, detail: 'No final answer from PayPal yet. Will retry with the same request id.',
      }, done);
      summary.unknown++;
    }
    return;
  }

  const done = deps.now();
  const ids = { httpStatus: 201, debugId: result.debugId, orderId: result.orderId, captureId: result.captureId };
  if (result.captureId && (result.captureStatus === 'COMPLETED' || result.captureStatus === 'PENDING')) {
    finish(db, c.id, attempt.requestId, 'COMPLETED', 'CHARGED', {
      ...ids, detail: result.captureStatus === 'PENDING' ? 'PayPal capture is PENDING' : null,
    }, done);
    summary.charged++;
  } else {
    finish(db, c.id, attempt.requestId, 'DECLINED', 'CHARGE_FAILED', {
      ...ids, detail: `PayPal order ${result.orderStatus ?? 'unknown'}, capture ${result.captureStatus ?? 'missing'}`,
    }, done);
    summary.failed++;
  }
}

async function runWorkspace(deps: Required<EngineDeps>, workspaceId: string): Promise<EngineSummary> {
  const summary: EngineSummary = { charged: 0, failed: 0, revoked: 0, unknown: 0, skipped: 0, outsideWindow: 0 };
  const { db } = deps;
  const inWindow = new Set(getBatches(db, workspaceId, deps.now()).filter((b) => b.inWindow).map((b) => b.number));
  const candidates = db
    .prepare(
      `SELECT id, state, batch_number, vault_id FROM reservation
        WHERE workspace_id = ? AND state IN ('RESERVED','CHARGE_FAILED','CHARGING') AND batch_number IS NOT NULL AND vault_id IS NOT NULL
        ORDER BY created_at`,
    )
    .all(workspaceId) as Candidate[];
  for (const c of candidates) {
    if (!inWindow.has(c.batch_number)) {
      summary.outsideWindow++; // Zero PayPal calls for these (FR-011).
      continue;
    }
    await chargeOne(deps, workspaceId, c, summary);
  }
  return summary;
}

/** FR-008: evaluate every chargeable reservation in a workspace. Runs are serialized per workspace. */
export async function runEngine(deps: EngineDeps, workspaceId: string): Promise<EngineSummary> {
  const full: Required<EngineDeps> = { paypal: { chargeVault }, now: () => new Date(), ...deps } as Required<EngineDeps>;
  const prior = running.get(workspaceId);
  const next = (prior ?? Promise.resolve()).catch(() => undefined).then(() => runWorkspace(full, workspaceId));
  running.set(workspaceId, next);
  try {
    return await next;
  } finally {
    if (running.get(workspaceId) === next) running.delete(workspaceId);
  }
}

/** Timer entry point: expire stale approvals, then run every workspace with chargeable reservations. */
export async function tick(deps: EngineDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  deps.db
    .prepare(
      "UPDATE reservation SET state = 'ABANDONED', message = 'PayPal approval was not completed within 3 days.' WHERE state = 'PENDING_APPROVAL' AND created_at < ?",
    )
    .run(new Date(now.getTime() - PENDING_APPROVAL_TTL_MS).toISOString());
  const ids = deps.db
    .prepare("SELECT DISTINCT workspace_id FROM reservation WHERE state IN ('RESERVED','CHARGE_FAILED','CHARGING')")
    .all() as { workspace_id: string }[];
  for (const { workspace_id } of ids) {
    try {
      await runEngine(deps, workspace_id);
    } catch (err) {
      console.error('engine run failed', { workspace: workspace_id.slice(0, 6), err: err instanceof Error ? err.message : err });
    }
  }
}

export function chargeLog(db: Db, workspaceId: string, limit = 200): ChargeLogRow[] {
  return (
    db
      .prepare(
        `SELECT a.*, r.buyer_email, r.batch_number FROM charge_attempt a JOIN reservation r ON r.id = a.reservation_id
          WHERE a.workspace_id = ? ORDER BY a.id DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as Record<string, unknown>[]
  ).map((a) => ({
    id: a.id as number,
    buyerEmail: a.buyer_email as string | null,
    batchNumber: a.batch_number as number | null,
    attemptNo: a.attempt_no as number,
    amount: a.amount as string,
    shipDate: a.ship_date as string,
    outcome: a.outcome as ChargeOutcome,
    httpStatus: a.http_status as number | null,
    paypalDebugId: a.paypal_debug_id as string | null,
    orderId: a.order_id as string | null,
    captureId: a.capture_id as string | null,
    detail: a.detail as string | null,
    createdAt: a.created_at as string,
    finishedAt: a.finished_at as string | null,
  }));
}
