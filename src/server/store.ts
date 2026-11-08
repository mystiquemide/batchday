import crypto from 'node:crypto';
import {
  CAPACITY_STATES,
  type BatchSummary,
  type CampaignView,
  type PlanDependency,
  type PlanTask,
  type ReservationState,
  type ReservationView,
} from '../shared/types.js';
import type { Db } from './db.js';
import { addDays, daysBetween, isInWindow, todayUtc, windowOpenDate } from './dates.js';
import { TEMPLATE, buildTemplatePlan } from './template.js';

export const randomId = () => crypto.randomBytes(16).toString('hex'); // 128-bit

export interface ReservationRow {
  id: string;
  workspace_id: string;
  batch_number: number | null;
  state: ReservationState;
  message: string | null;
  buyer_email: string | null;
  buyer_name: string | null;
  paypal_customer_id: string | null;
  vault_id: string | null;
  setup_token_id: string | null;
  public_token: string;
  created_at: string;
  charged_at: string | null;
  order_id: string | null;
  capture_id: string | null;
  refund_id: string | null;
}

const capacityStates = CAPACITY_STATES.map((s) => `'${s}'`).join(',');

export function createWorkspace(db: Db, now = new Date()): string {
  const id = randomId();
  const { tasks, dependencies } = buildTemplatePlan(todayUtc(now));
  db.transaction(() => {
    db.prepare('INSERT INTO workspace (id, product_name, unit_price, created_at) VALUES (?, ?, ?, ?)').run(
      id, TEMPLATE.productName, TEMPLATE.unitPrice, now.toISOString(),
    );
    const insTask = db.prepare(
      'INSERT INTO task (workspace_id, id, name, start_date, duration, kind, batch_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const t of tasks) insTask.run(id, t.id, t.name, t.startDate, t.duration, t.kind, t.batchNumber);
    const insDep = db.prepare('INSERT INTO dependency (workspace_id, id, from_task, to_task) VALUES (?, ?, ?, ?)');
    for (const d of dependencies) insDep.run(id, d.id, d.fromTask, d.toTask);
    const insBatch = db.prepare('INSERT INTO batch (workspace_id, number, capacity) VALUES (?, ?, ?)');
    for (const b of TEMPLATE.batches) insBatch.run(id, b.number, b.capacity);
  })();
  return id;
}

export function getCampaign(db: Db, workspaceId: string): CampaignView | null {
  const row = db.prepare('SELECT id, product_name, unit_price, currency, is_template FROM workspace WHERE id = ?').get(
    workspaceId,
  ) as { id: string; product_name: string; unit_price: string; currency: 'USD'; is_template: number } | undefined;
  if (!row) return null;
  return {
    workspaceId: row.id,
    productName: row.product_name,
    unitPrice: row.unit_price,
    currency: row.currency,
    isTemplate: row.is_template === 1,
  };
}

export function getPlan(db: Db, workspaceId: string): { tasks: PlanTask[]; dependencies: PlanDependency[] } {
  const tasks = (
    db
      .prepare(
        'SELECT id, name, start_date, duration, kind, batch_number, constraint_type, constraint_date FROM task WHERE workspace_id = ? ORDER BY id',
      )
      .all(workspaceId) as {
      id: number; name: string; start_date: string; duration: number; kind: PlanTask['kind']; batch_number: number | null;
      constraint_type: PlanTask['constraintType']; constraint_date: string | null;
    }[]
  ).map((t) => ({
    id: t.id, name: t.name, startDate: t.start_date, duration: t.duration, kind: t.kind, batchNumber: t.batch_number,
    constraintType: t.constraint_type, constraintDate: t.constraint_date,
  }));
  const dependencies = (
    db.prepare('SELECT id, from_task, to_task FROM dependency WHERE workspace_id = ? ORDER BY id').all(workspaceId) as {
      id: number; from_task: number; to_task: number;
    }[]
  ).map((d) => ({ id: d.id, fromTask: d.from_task, toTask: d.to_task }));
  return { tasks, dependencies };
}

/** FR-005: ship date is the end of the batch's "Ship batch N" task; window opens 20 days earlier. */
export function getBatches(db: Db, workspaceId: string, now = new Date()): BatchSummary[] {
  const today = todayUtc(now);
  const rows = db
    .prepare(
      `SELECT b.number, b.capacity, t.start_date, t.duration,
              (SELECT COUNT(*) FROM reservation r
                WHERE r.workspace_id = b.workspace_id AND r.batch_number = b.number
                  AND r.state IN (${capacityStates})) AS reserved
         FROM batch b
         JOIN task t ON t.workspace_id = b.workspace_id AND t.kind = 'ship_batch' AND t.batch_number = b.number
        WHERE b.workspace_id = ?
        ORDER BY b.number`,
    )
    .all(workspaceId) as { number: number; capacity: number; start_date: string; duration: number; reserved: number }[];
  return rows.map((r) => {
    const end = addDays(r.start_date, r.duration);
    return {
      number: r.number,
      capacity: r.capacity,
      reserved: r.reserved,
      shipDate: end,
      windowOpenDate: windowOpenDate(end),
      daysToShip: daysBetween(today, end),
      inWindow: isInWindow(end, today),
    };
  });
}

/** Earliest batch with free capacity, or null when sold out (FR-006, FR-007). */
export function nextOpenBatch(db: Db, workspaceId: string, now = new Date()): BatchSummary | null {
  return getBatches(db, workspaceId, now).find((b) => b.reserved < b.capacity) ?? null;
}

export function createPendingReservation(db: Db, workspaceId: string, now = new Date()): ReservationRow {
  const row: ReservationRow = {
    id: randomId(),
    workspace_id: workspaceId,
    batch_number: null,
    state: 'PENDING_APPROVAL',
    message: null,
    buyer_email: null,
    buyer_name: null,
    paypal_customer_id: null,
    vault_id: null,
    setup_token_id: null,
    public_token: randomId(),
    created_at: now.toISOString(),
    charged_at: null,
    order_id: null,
    capture_id: null,
    refund_id: null,
  };
  db.prepare(
    `INSERT INTO reservation (id, workspace_id, state, public_token, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(row.id, row.workspace_id, row.state, row.public_token, row.created_at);
  return row;
}

export function attachSetupToken(db: Db, reservationId: string, setupTokenId: string): void {
  db.prepare("UPDATE reservation SET setup_token_id = ? WHERE id = ? AND state = 'PENDING_APPROVAL'").run(
    setupTokenId, reservationId,
  );
}

export function getReservationByPublicToken(db: Db, publicToken: string): ReservationRow | null {
  return (db.prepare('SELECT * FROM reservation WHERE public_token = ?').get(publicToken) as ReservationRow) ?? null;
}

export function setPendingMessage(db: Db, reservationId: string, message: string): void {
  db.prepare("UPDATE reservation SET message = ? WHERE id = ? AND state = 'PENDING_APPROVAL'").run(message, reservationId);
}

export function abandon(db: Db, reservationId: string, message: string): boolean {
  return (
    db.prepare("UPDATE reservation SET state = 'ABANDONED', message = ? WHERE id = ? AND state = 'PENDING_APPROVAL'").run(
      message, reservationId,
    ).changes === 1
  );
}

export interface ApprovedToken {
  vaultId: string;
  customerId: string | null;
  email: string | null;
  name: string | null;
}

/**
 * Turns an approved setup token into a RESERVED reservation on the earliest batch with
 * free capacity. Runs in one transaction so concurrent returns cannot oversell a batch.
 * Returns 'sold_out' when no batch has room, leaving the reservation PENDING_APPROVAL.
 */
export function confirmReservation(
  db: Db,
  reservationId: string,
  token: ApprovedToken,
  now = new Date(),
): 'reserved' | 'sold_out' | 'not_pending' {
  return db.transaction(() => {
    const r = db.prepare('SELECT workspace_id, state FROM reservation WHERE id = ?').get(reservationId) as
      | { workspace_id: string; state: ReservationState }
      | undefined;
    if (!r || r.state !== 'PENDING_APPROVAL') return 'not_pending' as const;
    const batch = nextOpenBatch(db, r.workspace_id, now);
    if (!batch) return 'sold_out' as const;
    db.prepare(
      `UPDATE reservation SET state = 'RESERVED', batch_number = ?, vault_id = ?, paypal_customer_id = ?,
              buyer_email = ?, buyer_name = ?, message = NULL
        WHERE id = ? AND state = 'PENDING_APPROVAL'`,
    ).run(batch.number, token.vaultId, token.customerId, token.email, token.name, reservationId);
    return 'reserved' as const;
  }).immediate();
}

/** NFR-001: the only reservation shape that leaves the server. Never includes vault_id. */
export function toView(r: ReservationRow, includePublicToken: boolean): ReservationView {
  return {
    ...(includePublicToken ? { publicToken: r.public_token } : {}),
    state: r.state,
    batchNumber: r.batch_number,
    buyerEmail: r.buyer_email,
    buyerName: r.buyer_name,
    createdAt: r.created_at,
    chargedAt: r.charged_at,
    captureId: r.capture_id,
    message: r.message,
  };
}

export function listReservations(db: Db, workspaceId: string): ReservationRow[] {
  return db
    .prepare("SELECT * FROM reservation WHERE workspace_id = ? AND state != 'PENDING_APPROVAL' ORDER BY created_at")
    .all(workspaceId) as ReservationRow[];
}
