import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { openDb, type Db } from '../src/server/db';
import { runEngine, tick } from '../src/server/engine';
import { PayPalError } from '../src/server/paypal';
import { createWorkspace, randomId } from '../src/server/store';

const NOW = new Date('2026-11-08T12:00:00Z'); // batch 1 ships Dec 2 (24 days), batch 2 Dec 12 (34 days)
const INSIDE_B1 = new Date('2026-11-13T12:00:00Z');
let db: Db;
let ws: string;
let base: string;
const paypal = {
  createSetupToken: vi.fn(),
  createPaymentToken: vi.fn(),
  chargeVault: vi.fn(async (o: { requestId: string; referenceId: string }) => ({
    orderId: `O-${o.requestId}`, orderStatus: 'COMPLETED', captureId: `C-${o.requestId}`, captureStatus: 'COMPLETED', debugId: 'd',
  })),
  deletePaymentToken: vi.fn(async (_id: string) => ({ debugId: 'dbg-del', alreadyGone: false })),
};

function reserve(batch: number, state = 'RESERVED') {
  const id = randomId();
  const token = randomId();
  db.prepare(
    `INSERT INTO reservation (id, workspace_id, batch_number, state, buyer_email, vault_id, public_token, created_at)
     VALUES (?, ?, ?, ?, 'b@example.com', ?, ?, ?)`,
  ).run(id, ws, batch, state, `VAULT-${id}`, token, NOW.toISOString());
  return { id, token };
}
const row = (id: string) =>
  db.prepare('SELECT state, token_deleted_at, token_delete_debug_id FROM reservation WHERE id = ?').get(id) as {
    state: string; token_deleted_at: string | null; token_delete_debug_id: string | null;
  };
const cancel = (token: string) => fetch(`${base}/api/public/reservation/${token}/cancel`, { method: 'POST' });
const status = async (token: string) => (await fetch(`${base}/api/public/reservation/${token}`)).json();

beforeEach(async () => {
  Object.values(paypal).forEach((f) => f.mockClear());
  db = openDb(':memory:');
  ws = createWorkspace(db, NOW);
  const app = createApp({ db, publicBaseUrl: 'http://bd.test', paypal: paypal as never, now: () => NOW });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

describe('refusal display (FR-011, AC-3.1)', () => {
  it('explains ship date, window-open date and the rule for an out-of-window reservation', async () => {
    const r = reserve(2);
    const s = await status(r.token);
    expect(s.reservation.refusal).toMatchObject({
      code: 'NOT_YET_ELIGIBLE', shipDate: '2026-12-12', windowOpenDate: '2026-11-22', daysToShip: 34,
    });
    expect(s.reservation.refusal.reason).toBe(
      'Batch 2 ships Dec 12, 2026, 34 days away. Charging opens Nov 22, 2026 under the 20-day rule.',
    );
  });

  it('makes zero PayPal calls for a batch 30 or more days out', async () => {
    reserve(2);
    const summary = await runEngine({ db, paypal, now: () => NOW }, ws);
    expect(summary.outsideWindow).toBe(1);
    expect(paypal.chargeVault).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM charge_attempt').get()).toEqual({ n: 0 });
  });

  it('has no refusal once the batch is inside the window', async () => {
    const r = reserve(1);
    const app = createApp({ db, publicBaseUrl: 'http://bd.test', paypal: paypal as never, now: () => INSIDE_B1 });
    const server = app.listen(0);
    await new Promise((res) => server.once('listening', res));
    const s = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public/reservation/${r.token}`)).json();
    server.close();
    expect(s.reservation.refusal).toBeNull();
  });
});

describe('buyer cancel (FR-013)', () => {
  it('deletes the saved wallet at PayPal and sets CANCELLED (AC-3.2)', async () => {
    const r = reserve(2);
    const res = await cancel(r.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reservation).toMatchObject({ state: 'CANCELLED', canCancel: false, refusal: null });
    expect(paypal.deletePaymentToken).toHaveBeenCalledWith(`VAULT-${r.id}`);
    expect(row(r.id)).toMatchObject({ state: 'CANCELLED', token_delete_debug_id: 'dbg-del' });
    expect(row(r.id).token_deleted_at).toBe(NOW.toISOString());
    expect(JSON.stringify(body)).not.toContain('VAULT-');
  });

  it('is not offered and is refused after the buyer is charged (AC-3.3)', async () => {
    const r = reserve(1, 'CHARGED');
    expect((await status(r.token)).reservation.canCancel).toBe(false);
    const res = await cancel(r.token);
    expect(res.status).toBe(409);
    expect(paypal.deletePaymentToken).not.toHaveBeenCalled();
    expect(row(r.id).state).toBe('CHARGED');
  });

  it('refuses while a charge is in flight', async () => {
    const r = reserve(1, 'CHARGING');
    expect((await cancel(r.token)).status).toBe(409);
    expect(row(r.id).state).toBe('CHARGING');
  });

  it('allows cancelling after a failed charge', async () => {
    const r = reserve(1, 'CHARGE_FAILED');
    expect((await cancel(r.token)).status).toBe(200);
    expect(row(r.id).state).toBe('CANCELLED');
  });

  it('is idempotent: a second cancel does not call PayPal again', async () => {
    const r = reserve(2);
    await cancel(r.token);
    const again = await cancel(r.token);
    expect(again.status).toBe(200);
    expect(paypal.deletePaymentToken).toHaveBeenCalledTimes(1);
  });

  it('stays CANCELLED when the PayPal delete fails, and the tick finishes the delete', async () => {
    const r = reserve(2);
    paypal.deletePaymentToken.mockRejectedValueOnce(new PayPalError('x', 503, 'dbg-503', null));
    expect((await cancel(r.token)).status).toBe(200);
    expect(row(r.id)).toMatchObject({ state: 'CANCELLED', token_deleted_at: null });
    await tick({ db, paypal, now: () => NOW });
    expect(paypal.deletePaymentToken).toHaveBeenCalledTimes(2);
    expect(row(r.id).token_deleted_at).toBe(NOW.toISOString());
  });

  it('treats a token already gone at PayPal as deleted', async () => {
    const r = reserve(2);
    paypal.deletePaymentToken.mockResolvedValueOnce({ debugId: 'dbg-404', alreadyGone: true });
    await cancel(r.token);
    expect(row(r.id).token_deleted_at).not.toBeNull();
  });

  it('turns an unapproved reservation into ABANDONED without calling PayPal', async () => {
    const r = reserve(1, 'PENDING_APPROVAL');
    const body = await (await cancel(r.token)).json();
    expect(body.reservation.state).toBe('ABANDONED');
    expect(paypal.deletePaymentToken).not.toHaveBeenCalled();
  });

  it('rejects unknown links', async () => {
    expect((await cancel('f'.repeat(32))).status).toBe(404);
    expect((await cancel('nope')).status).toBe(404);
  });
});

describe('shared saved wallets', () => {
  it('does not delete a wallet another live reservation still needs, and deletes it once nothing does', async () => {
    const a = reserve(2);
    const b = reserve(2);
    db.prepare('UPDATE reservation SET vault_id = ? WHERE id IN (?, ?)').run('VAULT-SHARED', a.id, b.id);
    expect((await cancel(a.token)).status).toBe(200);
    expect(paypal.deletePaymentToken).not.toHaveBeenCalled();
    await tick({ db, paypal, now: () => NOW });
    expect(paypal.deletePaymentToken).not.toHaveBeenCalled();
    expect(row(b.id).state).toBe('RESERVED');

    await cancel(b.token); // last user of the wallet: deleted now
    expect(paypal.deletePaymentToken).toHaveBeenCalledWith('VAULT-SHARED');
    await tick({ db, paypal, now: () => NOW }); // a's pending delete is satisfied by the 404 path or a second call
    expect(row(b.id).token_deleted_at).not.toBeNull();
  });
});

describe('cancelled and revoked never charged (AC-3.5)', () => {
  it('skips them when their batch enters the window', async () => {
    const c = reserve(1);
    await cancel(c.token);
    const v = reserve(1);
    paypal.chargeVault.mockRejectedValueOnce(new PayPalError('x', 403, 'dbg-403', 'PERMISSION_DENIED'));
    await runEngine({ db, paypal, now: () => INSIDE_B1 }, ws);
    expect(row(v.id).state).toBe('REVOKED');
    await runEngine({ db, paypal, now: () => INSIDE_B1 }, ws);
    await tick({ db, paypal, now: () => INSIDE_B1 });
    expect(paypal.chargeVault).toHaveBeenCalledTimes(1);
    expect(paypal.chargeVault.mock.calls[0][0].referenceId).toBe(v.id);
    expect(row(c.id).state).toBe('CANCELLED');
  });
});
