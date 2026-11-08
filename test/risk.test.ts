import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { openDb, type Db } from '../src/server/db';
import { runEngine } from '../src/server/engine';
import { draftNotices, factCheck, markNotified, noticeGroups, templateDraft } from '../src/server/notices';
import { PayPalError } from '../src/server/paypal';
import { evaluateRisk, refundReservation } from '../src/server/risk';
import { createWorkspace, randomId } from '../src/server/store';

// Template from Nov 8: batch 1 ships Dec 2 (freight batch 1 is task 4, Nov 25 + 7 days).
const CREATED = new Date('2026-11-08T12:00:00Z');
const NOW = new Date('2026-11-13T12:00:00Z');
let db: Db;
let ws: string;

function reserve(state: string, batch = 1, chargedAt: string | null = '2026-11-13T10:00:00Z', notified: string | null = '2026-12-02') {
  const id = randomId();
  db.prepare(
    `INSERT INTO reservation (id, workspace_id, batch_number, state, buyer_email, vault_id, public_token, created_at, charged_at, capture_id, notified_ship_date)
     VALUES (?, ?, ?, ?, ?, 'V', ?, ?, ?, ?, ?)`,
  ).run(id, ws, batch, state, `${id.slice(0, 4)}@example.com`, randomId(), CREATED.toISOString(), chargedAt, chargedAt ? `CAP-${id}` : null, notified);
  return id;
}
const stateOf = (id: string) => (db.prepare('SELECT state, message FROM reservation WHERE id = ?').get(id) as { state: string; message: string | null });
const setFreight = (days: number) => {
  db.prepare('UPDATE task SET duration = ? WHERE workspace_id = ? AND id = 4').run(days, ws);
  db.prepare("UPDATE task SET start_date = date('2026-11-25', '+' || ? || ' days') WHERE workspace_id = ? AND id = 5").run(days, ws);
};

beforeEach(() => {
  db = openDb(':memory:');
  ws = createWorkspace(db, CREATED);
});

describe('slip after charge (FR-018)', () => {
  it('marks a charged buyer AT_RISK when the batch ships more than 20 days after the charge (AC-5.1)', () => {
    const a = reserve('CHARGED');
    expect(evaluateRisk(db, ws, NOW)).toEqual({ atRisk: 0, recovered: 0 }); // Dec 2 is 19 days after Nov 13
    setFreight(12); // ships Dec 7, 24 days after the charge
    expect(evaluateRisk(db, ws, NOW)).toEqual({ atRisk: 1, recovered: 0 });
    expect(stateOf(a)).toEqual({
      state: 'AT_RISK',
      message: 'Batch 1 now ships Dec 7, 2026, 24 days after this buyer was charged on Nov 13, 2026. That breaks the 20-day promise. Refund, or move the plan back.',
    });
  });

  it('returns to CHARGED when the plan recovers (AC-5.3)', () => {
    const a = reserve('CHARGED');
    setFreight(12);
    evaluateRisk(db, ws, NOW);
    setFreight(7);
    expect(evaluateRisk(db, ws, NOW)).toEqual({ atRisk: 0, recovered: 1 });
    expect(stateOf(a)).toEqual({ state: 'CHARGED', message: null });
  });

  it('flags at exactly 21 days, not 20', () => {
    const a = reserve('CHARGED', 1, '2026-11-12T10:00:00Z'); // Dec 2 is 20 days later
    evaluateRisk(db, ws, NOW);
    expect(stateOf(a).state).toBe('CHARGED');
    setFreight(8); // Dec 3, 21 days
    evaluateRisk(db, ws, NOW);
    expect(stateOf(a).state).toBe('AT_RISK');
  });

  it('runs inside the engine and never re-charges AT_RISK or REFUNDED buyers', async () => {
    const a = reserve('CHARGED');
    const r = reserve('REFUNDED');
    setFreight(12);
    const chargeVault = vi.fn();
    const s = await runEngine({ db, paypal: { chargeVault }, now: () => NOW }, ws);
    expect(s.atRisk).toBe(1);
    expect(stateOf(a).state).toBe('AT_RISK');
    expect(stateOf(r).state).toBe('REFUNDED');
    expect(chargeVault).not.toHaveBeenCalled();
  });
});

describe('refund (FR-019)', () => {
  const ok = vi.fn(async (o: { requestId: string; captureId: string; note: string }) => ({ refundId: `RF-${o.captureId}`, status: 'COMPLETED', debugId: 'dbg-rf' }));
  beforeEach(() => {
    ok.mockClear();
  });

  it('refunds an AT_RISK reservation once, with a stable request id (AC-5.2)', async () => {
    const a = reserve('AT_RISK');
    await refundReservation(db, ws, a, { refundCapture: ok, now: () => NOW });
    expect(ok).toHaveBeenCalledWith(expect.objectContaining({ requestId: `rf-${a}`, captureId: `CAP-${a}` }));
    expect(db.prepare('SELECT state, refund_id, refund_status, refunded_at, refund_debug_id FROM reservation WHERE id = ?').get(a)).toEqual({
      state: 'REFUNDED', refund_id: `RF-CAP-${a}`, refund_status: 'COMPLETED', refunded_at: NOW.toISOString(), refund_debug_id: 'dbg-rf',
    });
    await refundReservation(db, ws, a, { refundCapture: ok, now: () => NOW });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('allows refunding a CHARGED reservation, refuses everything else', async () => {
    await refundReservation(db, ws, reserve('CHARGED'), { refundCapture: ok });
    for (const s of ['RESERVED', 'CANCELLED', 'REVOKED', 'CHARGING']) {
      await expect(refundReservation(db, ws, reserve(s), { refundCapture: ok })).rejects.toMatchObject({ status: 409 });
    }
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('keeps the state and reports the debug id when PayPal refuses', async () => {
    const a = reserve('AT_RISK');
    const bad = vi.fn().mockRejectedValue(new PayPalError('x', 422, 'dbg-422', 'TRANSACTION_REFUSED'));
    await expect(refundReservation(db, ws, a, { refundCapture: bad })).rejects.toMatchObject({ status: 502, debugId: 'dbg-422' });
    expect(stateOf(a).state).toBe('AT_RISK');
  });

  it('records a capture already refunded at PayPal without a second refund', async () => {
    const a = reserve('CHARGED');
    const done = vi.fn().mockRejectedValue(new PayPalError('x', 422, 'dbg', 'CAPTURE_FULLY_REFUNDED'));
    await refundReservation(db, ws, a, { refundCapture: done });
    expect(stateOf(a).state).toBe('REFUNDED');
  });

  it('cannot refund another workspace reservation', async () => {
    const other = createWorkspace(db, CREATED);
    const a = reserve('CHARGED');
    await expect(refundReservation(db, other, a, { refundCapture: ok })).rejects.toMatchObject({ status: 404 });
  });
});

describe('notice drafts (FR-020)', () => {
  it('groups reserved buyers with a changed ship date and at-risk buyers', () => {
    reserve('RESERVED', 1, null);
    reserve('RESERVED', 2, null, '2026-12-12'); // batch 2 unchanged
    const risk = reserve('CHARGED');
    setFreight(12);
    evaluateRisk(db, ws, NOW);
    const groups = noticeGroups(db, ws, NOW);
    expect(groups.map((g) => [g.kind, g.batchNumber, g.reservationIds.length]).sort()).toEqual([
      ['at_risk', 1, 1],
      ['ship_date_changed', 1, 1],
    ]);
    const changed = groups.find((g) => g.kind === 'ship_date_changed')!;
    expect(changed.facts).toMatchObject({ previous_ship_date: 'December 2, 2026', new_ship_date: 'December 7, 2026', charging_opens: 'November 17, 2026', amount: '$49.00' });
    expect(groups.find((g) => g.kind === 'at_risk')!.reservationIds).toEqual([risk]);
  });

  it('fact check flags any date or amount not in the facts', () => {
    const facts = { amount: '$49.00', new_ship_date: 'December 7, 2026' };
    expect(factCheck('Ships December 7, 2026 for $49.00.', facts)).toEqual([]);
    expect(factCheck('Ships Dec 7 and costs $49.00', facts)).toEqual(['date "Dec 7" is not in the facts']);
    expect(factCheck('Ships December 9, 2026. Here is $10 off.', facts)).toEqual([
      'date "December 9, 2026" is not in the facts',
      'amount "$10" is not in the facts',
    ]);
    expect(factCheck('Arrives 7 December or 12/09. 49 USD.', facts)).toHaveLength(3);
  });

  it('templates always pass their own fact check', () => {
    reserve('RESERVED', 1, null);
    reserve('CHARGED');
    setFreight(12);
    evaluateRisk(db, ws, NOW);
    for (const g of noticeGroups(db, ws, NOW)) {
      const t = templateDraft(g);
      expect(factCheck(`${t.subject}\n${t.body}`, g.facts)).toEqual([]);
    }
  });

  it('replaces an AI draft that invents a date, and falls back when the AI fails (AC-5.4)', async () => {
    reserve('RESERVED', 1, null);
    setFreight(12);
    const liar = vi.fn(async () => ({ subject: 'New date', body: 'Your order now ships December 9, 2026 with 10% off.' }));
    const [d] = await draftNotices(db, ws, NOW, liar);
    expect(d.source).toBe('template');
    expect(d.sourceNote).toMatch(/December 9, 2026/);
    expect(d.body).toContain('December 7, 2026');

    const honest = vi.fn(async (_k: string, f: Record<string, string>) => ({ subject: `Now ships ${f.new_ship_date}`, body: `Batch ${f.batch} ships ${f.new_ship_date}. Charging opens ${f.charging_opens}.` }));
    expect((await draftNotices(db, ws, NOW, honest))[0].source).toBe('ai');

    const broken = vi.fn().mockRejectedValue(new Error('down'));
    expect((await draftNotices(db, ws, NOW, broken))[0]).toMatchObject({ source: 'template' });
  });

  it('mark notified resets the baseline so the batch drops out', () => {
    reserve('RESERVED', 1, null);
    setFreight(12);
    expect(noticeGroups(db, ws, NOW)).toHaveLength(1);
    markNotified(db, ws, 1, NOW);
    expect(noticeGroups(db, ws, NOW)).toHaveLength(0);
  });
});

describe('notice facts without a baseline', () => {
  it('omits previous_ship_date when it is unknown instead of repeating the new date', () => {
    reserve('CHARGED', 1, '2026-11-13T10:00:00Z', null);
    setFreight(12);
    evaluateRisk(db, ws, NOW);
    const [g] = noticeGroups(db, ws, NOW);
    expect(g.facts.previous_ship_date).toBeUndefined();
    expect(g.facts).toMatchObject({ charged_on: 'November 13, 2026', days_from_charge_to_ship: '24 days' });
    const t = templateDraft(g);
    expect(t.body).toContain('That batch now ships December 7, 2026, 24 days after your charge.');
    expect(factCheck(`${t.subject}\n${t.body}`, g.facts)).toEqual([]);
  });
});

describe('HTTP', () => {
  it('exposes reservation ids to the seller only, and refunds through the API', async () => {
    const refundCapture = vi.fn(async () => ({ refundId: 'RF-1', status: 'COMPLETED', debugId: 'd' }));
    const app = createApp({ db, publicBaseUrl: 'http://bd.test', now: () => NOW, paypal: { refundCapture } as never });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/workspace`, { method: 'POST' });
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    ws = (await res.json()).workspaceId;
    const a = reserve('CHARGED');
    const pub = db.prepare('SELECT public_token FROM reservation WHERE id = ?').get(a) as { public_token: string };

    const seller = await (await fetch(`${base}/api/workspace`, { headers: { cookie } })).json();
    expect(seller.reservations[0]).toMatchObject({ id: a, canRefund: true });
    const buyer = await (await fetch(`${base}/api/public/reservation/${pub.public_token}`)).json();
    expect(buyer.reservation.id).toBeUndefined();
    expect(buyer.reservation.canRefund).toBe(false);

    const noCookie = await fetch(`${base}/api/workspace/reservations/${a}/refund`, { method: 'POST' });
    expect(noCookie.status).toBe(404);
    const after = await (await fetch(`${base}/api/workspace/reservations/${a}/refund`, { method: 'POST', headers: { cookie } })).json();
    expect(after.reservations[0]).toMatchObject({ state: 'REFUNDED', refundId: 'RF-1', canRefund: false });
    server.close();
  });
});
