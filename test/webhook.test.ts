import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { openDb, type Db } from '../src/server/db';
import { createWorkspace, randomId } from '../src/server/store';

const NOW = new Date('2026-11-08T12:00:00Z');
let db: Db;
let ws: string;
let base: string;
const verify = vi.fn(async (_raw: string, _h: Record<string, string | undefined>) => true);

function reserve(state: string, vault: string, capture: string | null = null) {
  const id = randomId();
  db.prepare(
    `INSERT INTO reservation (id, workspace_id, batch_number, state, vault_id, capture_id, public_token, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(id, ws, state, vault, capture, randomId(), NOW.toISOString());
  return id;
}
const stateOf = (id: string) => (db.prepare('SELECT state FROM reservation WHERE id = ?').get(id) as { state: string }).state;
const send = (event: object, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/paypal/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(event) });

beforeEach(async () => {
  verify.mockReset();
  verify.mockResolvedValue(true);
  db = openDb(':memory:');
  ws = createWorkspace(db, NOW);
  const app = createApp({ db, publicBaseUrl: 'http://bd.test', now: () => NOW, verifyWebhook: verify });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

describe('PayPal webhooks (FR-021)', () => {
  it('revokes reservations when PayPal reports the saved wallet deleted (AC-6.2)', async () => {
    const a = reserve('RESERVED', 'VT-1');
    const charged = reserve('CHARGED', 'VT-1', 'CAP-1');
    const res = await send({ id: 'WH-1', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'VT-1' } }, { 'paypal-transmission-id': 't' });
    expect(await res.json()).toEqual({ outcome: 'processed' });
    expect(stateOf(a)).toBe('REVOKED');
    expect(stateOf(charged)).toBe('CHARGED');
    expect(verify.mock.calls[0][1]['paypal-transmission-id']).toBe('t');
  });

  it('passes the raw body to verification unchanged', async () => {
    const raw = '{"id":"WH-raw","event_type":"PAYMENT.CAPTURE.COMPLETED",  "resource":{}}';
    await fetch(`${base}/api/paypal/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    expect(verify.mock.calls[0][0]).toBe(raw);
  });

  it('ignores an unverified event and changes nothing (AC-6.2)', async () => {
    verify.mockResolvedValue(false);
    const a = reserve('RESERVED', 'VT-2');
    const res = await send({ id: 'WH-2', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'VT-2' } });
    expect(await res.json()).toEqual({ outcome: 'ignored_unverified' });
    expect(stateOf(a)).toBe('RESERVED');
    expect(db.prepare('SELECT COUNT(*) n FROM webhook_event').get()).toEqual({ n: 0 });
  });

  it('treats a verification error as unverified', async () => {
    verify.mockRejectedValue(new Error('PayPal down'));
    const a = reserve('RESERVED', 'VT-3');
    await send({ id: 'WH-3', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'VT-3' } });
    expect(stateOf(a)).toBe('RESERVED');
  });

  it('processes each event id once', async () => {
    reserve('RESERVED', 'VT-4');
    const e = { id: 'WH-4', event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'VT-4' } };
    await send(e);
    expect(await (await send(e)).json()).toEqual({ outcome: 'duplicate' });
  });

  it('marks a charge refunded outside Batchday as REFUNDED', async () => {
    const a = reserve('AT_RISK', 'VT-5', 'CAP-5');
    await send({
      id: 'WH-5',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'RF-5', status: 'COMPLETED', links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP-5' }] },
    });
    expect(db.prepare('SELECT state, refund_id FROM reservation WHERE id = ?').get(a)).toEqual({ state: 'REFUNDED', refund_id: 'RF-5' });
  });

  it('rejects malformed bodies without calling PayPal', async () => {
    const res = await fetch(`${base}/api/paypal/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    expect(res.status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it('acknowledges unknown event types without acting', async () => {
    const res = await send({ id: 'WH-6', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} });
    expect(await res.json()).toEqual({ outcome: 'ignored_type' });
  });
});
