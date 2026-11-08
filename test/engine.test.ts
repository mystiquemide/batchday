import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/server/db';
import { runEngine, tick } from '../src/server/engine';
import { PayPalError } from '../src/server/paypal';
import { createWorkspace, randomId } from '../src/server/store';

// Template from 2026-11-08: batch 1 ships 2026-12-02, batch 2 ships 2026-12-12.
const CREATED = new Date('2026-11-08T12:00:00Z');
const OUTSIDE = new Date('2026-11-08T12:00:00Z'); // batch 1 is 24 days out
const INSIDE_B1 = new Date('2026-11-13T12:00:00Z'); // batch 1 is 19 days out, batch 2 is 29

let db: Db;
let ws: string;
let seq = 0;
const chargeVault = vi.fn();
const okCharge = async (o: { requestId: string }) => ({
  orderId: `ORDER-${o.requestId}`,
  orderStatus: 'COMPLETED',
  captureId: `CAP-${o.requestId}`,
  captureStatus: 'COMPLETED',
  debugId: 'dbg-ok',
});

function reserve(batch: number, state = 'RESERVED'): string {
  const id = randomId();
  db.prepare(
    `INSERT INTO reservation (id, workspace_id, batch_number, state, buyer_email, vault_id, public_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ws, batch, state, `b${++seq}@example.com`, `VAULT-${seq}`, randomId(), new Date(CREATED.getTime() + seq).toISOString());
  return id;
}
const stateOf = (id: string) => (db.prepare('SELECT state FROM reservation WHERE id = ?').get(id) as { state: string }).state;
const attempts = (id: string) =>
  db.prepare('SELECT attempt_no, request_id, outcome FROM charge_attempt WHERE reservation_id = ? ORDER BY attempt_no').all(id) as {
    attempt_no: number; request_id: string; outcome: string;
  }[];
const run = (now: Date | (() => Date)) =>
  runEngine({ db, paypal: { chargeVault }, now: typeof now === 'function' ? now : () => now }, ws);

beforeEach(() => {
  db = openDb(':memory:');
  ws = createWorkspace(db, CREATED);
  seq = 0;
  chargeVault.mockReset();
  chargeVault.mockImplementation(okCharge);
});

describe('BR-001 window invariant', () => {
  it('makes zero PayPal calls when every batch is outside the window', async () => {
    const a = reserve(1);
    const s = await run(OUTSIDE);
    expect(chargeVault).not.toHaveBeenCalled();
    expect(s.outsideWindow).toBe(1);
    expect(stateOf(a)).toBe('RESERVED');
    expect(attempts(a)).toEqual([]);
  });

  it('charges only reservations whose batch is within 20 days', async () => {
    const a = reserve(1);
    const b = reserve(1);
    const c = reserve(2);
    const s = await run(INSIDE_B1);
    expect(s).toMatchObject({ charged: 2, outsideWindow: 1 });
    expect(stateOf(a)).toBe('CHARGED');
    expect(stateOf(b)).toBe('CHARGED');
    expect(stateOf(c)).toBe('RESERVED');
    expect(chargeVault).toHaveBeenCalledTimes(2);
    const call = chargeVault.mock.calls[0][0];
    expect(call).toMatchObject({ requestId: `bd-${a}-1`, vaultId: 'VAULT-1', amount: '49.00', currency: 'USD', referenceId: a });
    const row = db.prepare('SELECT order_id, capture_id, charged_at FROM reservation WHERE id = ?').get(a) as Record<string, string>;
    expect(row.order_id).toBe(`ORDER-bd-${a}-1`);
    expect(row.capture_id).toBe(`CAP-bd-${a}-1`);
    expect(row.charged_at).toBe(INSIDE_B1.toISOString());
  });

  it('charges at exactly 20 days and not at 21', async () => {
    const a = reserve(1);
    await run(new Date('2026-11-11T23:59:00Z')); // 21 days before Dec 2
    expect(chargeVault).not.toHaveBeenCalled();
    await run(new Date('2026-11-12T00:00:00Z')); // 20 days
    expect(stateOf(a)).toBe('CHARGED');
  });

  it('re-checks the window immediately before calling PayPal and skips if it closed', async () => {
    const a = reserve(1);
    let calls = 0;
    // Candidate scan and claim read the clock inside the window; the pre-call re-check sees it outside.
    const clock = () => (calls++ < 2 ? INSIDE_B1 : OUTSIDE);
    const s = await run(clock);
    expect(chargeVault).not.toHaveBeenCalled();
    expect(s.skipped).toBe(1);
    expect(stateOf(a)).toBe('RESERVED');
    expect(attempts(a)).toEqual([{ attempt_no: 1, request_id: `bd-${a}-1`, outcome: 'SKIPPED' }]);
  });
});

describe('BR-002 at most one capture', () => {
  it('never charges a reservation twice across repeated and concurrent runs (AC-2.5)', async () => {
    const a = reserve(1);
    const b = reserve(1);
    chargeVault.mockImplementation(async (o) => {
      await new Promise((r) => setTimeout(r, 20));
      return okCharge(o);
    });
    await Promise.all([run(INSIDE_B1), run(INSIDE_B1), run(INSIDE_B1)]);
    await run(INSIDE_B1);
    expect(chargeVault).toHaveBeenCalledTimes(2);
    expect(attempts(a)).toHaveLength(1);
    expect(attempts(b)).toHaveLength(1);
  });

  it('resumes an unknown outcome with the same PayPal-Request-Id', async () => {
    const a = reserve(1);
    chargeVault.mockRejectedValueOnce(new PayPalError('timeout', 0, null, 'TimeoutError'));
    const first = await run(INSIDE_B1);
    expect(first.unknown).toBe(1);
    expect(stateOf(a)).toBe('CHARGING');
    await run(INSIDE_B1);
    expect(chargeVault).toHaveBeenCalledTimes(2);
    expect(chargeVault.mock.calls[1][0].requestId).toBe(chargeVault.mock.calls[0][0].requestId);
    expect(stateOf(a)).toBe('CHARGED');
    expect(attempts(a)).toEqual([{ attempt_no: 1, request_id: `bd-${a}-1`, outcome: 'COMPLETED' }]);
  });

  it('treats a 5xx as unknown, not as a failure', async () => {
    const a = reserve(1);
    chargeVault.mockRejectedValueOnce(new PayPalError('x', 503, 'dbg-503', 'SERVICE_UNAVAILABLE'));
    await run(INSIDE_B1);
    expect(stateOf(a)).toBe('CHARGING');
    expect(attempts(a)[0].outcome).toBe('UNKNOWN');
  });

  it('does not resume a fresh PENDING attempt owned by another run', async () => {
    const a = reserve(1);
    db.prepare("UPDATE reservation SET state = 'CHARGING' WHERE id = ?").run(a);
    db.prepare(
      `INSERT INTO charge_attempt (workspace_id, reservation_id, attempt_no, request_id, amount, ship_date, outcome, created_at)
       VALUES (?, ?, 1, ?, '49.00', '2026-12-02', 'PENDING', ?)`,
    ).run(ws, a, `bd-${a}-1`, INSIDE_B1.toISOString());
    await run(INSIDE_B1);
    expect(chargeVault).not.toHaveBeenCalled();
    await run(new Date(INSIDE_B1.getTime() + 61_000));
    expect(chargeVault).toHaveBeenCalledTimes(1);
    expect(chargeVault.mock.calls[0][0].requestId).toBe(`bd-${a}-1`);
  });
});

describe('failure states', () => {
  it('sets REVOKED on 403 and never tries again (FR-014)', async () => {
    const a = reserve(1);
    chargeVault.mockRejectedValueOnce(new PayPalError('x', 403, 'dbg-403', 'PERMISSION_DENIED'));
    const s = await run(INSIDE_B1);
    expect(s.revoked).toBe(1);
    expect(stateOf(a)).toBe('REVOKED');
    await run(INSIDE_B1);
    expect(chargeVault).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT http_status, paypal_debug_id FROM charge_attempt').get()).toEqual({ http_status: 403, paypal_debug_id: 'dbg-403' });
  });

  it('retries CHARGE_FAILED exactly once with a new attempt number', async () => {
    const a = reserve(1);
    chargeVault.mockRejectedValue(new PayPalError('x', 422, 'dbg-422', 'INSTRUMENT_DECLINED'));
    await run(INSIDE_B1);
    expect(stateOf(a)).toBe('CHARGE_FAILED');
    await run(INSIDE_B1);
    await run(INSIDE_B1);
    expect(chargeVault).toHaveBeenCalledTimes(2);
    expect(attempts(a).map((x) => x.request_id)).toEqual([`bd-${a}-1`, `bd-${a}-2`]);
    expect(stateOf(a)).toBe('CHARGE_FAILED');
  });

  it('marks a declined capture as CHARGE_FAILED', async () => {
    const a = reserve(1);
    chargeVault.mockResolvedValueOnce({ orderId: 'O', orderStatus: 'COMPLETED', captureId: 'C', captureStatus: 'DECLINED', debugId: 'd' });
    await run(INSIDE_B1);
    expect(stateOf(a)).toBe('CHARGE_FAILED');
    expect(db.prepare('SELECT capture_id FROM reservation WHERE id = ?').get(a)).toEqual({ capture_id: null });
  });

  it('never charges cancelled, revoked, abandoned, refunded or pending reservations (BR-004)', async () => {
    for (const s of ['CANCELLED', 'REVOKED', 'ABANDONED', 'REFUNDED', 'PENDING_APPROVAL', 'CHARGED', 'AT_RISK']) reserve(1, s);
    await run(INSIDE_B1);
    expect(chargeVault).not.toHaveBeenCalled();
  });
});

describe('tick', () => {
  it('abandons approvals older than 3 days and charges eligible workspaces', async () => {
    const pending = reserve(2, 'PENDING_APPROVAL');
    const a = reserve(1);
    await tick({ db, paypal: { chargeVault }, now: () => new Date(CREATED.getTime() + 3 * 86_400_000 + 60_000) });
    expect(stateOf(pending)).toBe('ABANDONED');
    expect(stateOf(a)).toBe('RESERVED'); // Nov 11: batch 1 still 21 days out
    await tick({ db, paypal: { chargeVault }, now: () => INSIDE_B1 });
    expect(stateOf(a)).toBe('CHARGED');
  });
});
