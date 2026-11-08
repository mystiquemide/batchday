import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { openDb, type Db } from '../src/server/db';
import { PayPalError } from '../src/server/paypal';

const NOW = new Date('2026-11-08T12:00:00Z');
let db: Db;
let base: string;
let close: () => void;
let vaultSeq = 0;

const paypal = {
  createSetupToken: vi.fn(async (o: { requestId: string; returnUrl: string; cancelUrl: string }) => ({
    setupTokenId: `ST-${o.requestId}`,
    approveUrl: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${o.requestId}`,
    debugId: 'dbg-setup',
  })),
  createPaymentToken: vi.fn(async (_o: { requestId: string; setupTokenId: string }) => ({
    vaultId: `VAULT-${++vaultSeq}`,
    customerId: `CUST-${vaultSeq}`,
    email: `buyer${vaultSeq}@example.com`,
    name: `Buyer ${vaultSeq}`,
    debugId: 'dbg-pt',
  })),
};

async function start() {
  db = openDb(':memory:');
  const app = createApp({ db, publicBaseUrl: 'http://bd.test', paypal: paypal as never, now: () => NOW });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
}

async function newWorkspace() {
  const res = await fetch(`${base}/api/workspace`, { method: 'POST' });
  const cookie = res.headers.get('set-cookie')!;
  const { workspaceId } = await res.json();
  return { workspaceId, cookie: cookie.split(';')[0], rawCookie: cookie };
}

async function reserveAndReturn(workspaceId: string) {
  const res = await fetch(`${base}/api/public/campaign/${workspaceId}/reserve`, { method: 'POST' });
  const body = await res.json();
  const returnUrl = paypal.createSetupToken.mock.lastCall![0].returnUrl.replace('http://bd.test', base);
  const ret = await fetch(returnUrl, { redirect: 'manual' });
  return { res, body, ret, publicToken: body.statusPath?.slice(3) as string };
}

beforeEach(async () => {
  close?.();
  vi.clearAllMocks();
  vaultSeq = 0;
  await start();
});

describe('workspace', () => {
  it('sets an HttpOnly SameSite=Lax cookie with a 128-bit id', async () => {
    const { workspaceId, rawCookie } = await newWorkspace();
    expect(workspaceId).toMatch(/^[0-9a-f]{32}$/);
    expect(rawCookie).toMatch(/HttpOnly/);
    expect(rawCookie).toMatch(/SameSite=Lax/);
  });

  it('rejects a missing or forged cookie', async () => {
    expect((await fetch(`${base}/api/workspace`)).status).toBe(404);
    const res = await fetch(`${base}/api/workspace`, { headers: { cookie: `bd_ws=${'0'.repeat(32)}` } });
    expect(res.status).toBe(404);
  });

  it('returns plan, batches with derived ship and window dates', async () => {
    const { cookie } = await newWorkspace();
    const data = await (await fetch(`${base}/api/workspace`, { headers: { cookie } })).json();
    expect(data.plan.tasks.length).toBeGreaterThanOrEqual(8);
    expect(data.batches.map((b: { number: number }) => b.number)).toEqual([1, 2, 3]);
    const ship1 = data.plan.tasks.find((t: { name: string }) => t.name === 'Ship batch 1');
    expect(data.batches[0].shipDate).toBe(ship1.startDate);
    expect(data.batches[0].daysToShip).toBe(24);
    expect(data.batches[0].inWindow).toBe(false);
  });
});

describe('reservation flow (Slice 1)', () => {
  it('creates a setup token with Batchday return and cancel URLs and redirects to status on return (AC-1.2, AC-1.3)', async () => {
    const { workspaceId, cookie } = await newWorkspace();
    const { res, body, ret, publicToken } = await reserveAndReturn(workspaceId);
    expect(res.status).toBe(201);
    expect(body.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    const call = paypal.createSetupToken.mock.lastCall![0];
    expect(call.returnUrl).toMatch(/^http:\/\/bd\.test\/api\/paypal\/return\?r=[0-9a-f]{32}$/);
    expect(call.cancelUrl).toMatch(/^http:\/\/bd\.test\/api\/paypal\/cancel\?r=[0-9a-f]{32}$/);
    expect(ret.status).toBe(303);
    expect(ret.headers.get('location')).toBe(`/s/${publicToken}`);

    const status = await (await fetch(`${base}/api/public/reservation/${publicToken}`)).json();
    expect(status.reservation.state).toBe('RESERVED');
    expect(status.batch.number).toBe(1);
    expect(status.batch.windowOpenDate).toBeTruthy();

    const row = db.prepare('SELECT vault_id, state FROM reservation').get() as { vault_id: string; state: string };
    expect(row).toEqual({ vault_id: 'VAULT-1', state: 'RESERVED' });

    const seller = await (await fetch(`${base}/api/workspace`, { headers: { cookie } })).json();
    expect(seller.reservations).toHaveLength(1);
    expect(seller.batches[0].reserved).toBe(1);
  });

  it('does not exchange the token twice when the return URL is hit again', async () => {
    const { workspaceId } = await newWorkspace();
    await reserveAndReturn(workspaceId);
    const returnUrl = paypal.createSetupToken.mock.lastCall![0].returnUrl.replace('http://bd.test', base);
    await fetch(returnUrl, { redirect: 'manual' });
    expect(paypal.createPaymentToken).toHaveBeenCalledTimes(1);
  });

  it('marks ABANDONED when the buyer cancels at PayPal (AC-1.4)', async () => {
    const { workspaceId } = await newWorkspace();
    const res = await fetch(`${base}/api/public/campaign/${workspaceId}/reserve`, { method: 'POST' });
    const { statusPath } = await res.json();
    const cancelUrl = paypal.createSetupToken.mock.lastCall![0].cancelUrl.replace('http://bd.test', base);
    const back = await fetch(cancelUrl, { redirect: 'manual' });
    expect(back.headers.get('location')).toBe(statusPath);
    const status = await (await fetch(`${base}/api/public/reservation/${statusPath.slice(3)}`)).json();
    expect(status.reservation.state).toBe('ABANDONED');
    expect(status.reservation.message).toMatch(/cancelled at PayPal/);
    expect(paypal.createPaymentToken).not.toHaveBeenCalled();
  });

  it('fills batches in order and reports Sold out without creating a setup token (FR-006, AC-1.5)', async () => {
    const { workspaceId, cookie } = await newWorkspace();
    for (let i = 0; i < 10; i++) await reserveAndReturn(workspaceId);
    const seller = await (await fetch(`${base}/api/workspace`, { headers: { cookie } })).json();
    expect(seller.batches.map((b: { reserved: number }) => b.reserved)).toEqual([2, 3, 5]);

    const pub = await (await fetch(`${base}/api/public/campaign/${workspaceId}`)).json();
    expect(pub.soldOut).toBe(true);
    const calls = paypal.createSetupToken.mock.calls.length;
    const res = await fetch(`${base}/api/public/campaign/${workspaceId}/reserve`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(paypal.createSetupToken.mock.calls.length).toBe(calls);
  });

  it('keeps PENDING_APPROVAL with a debug ID when PayPal has not approved the token', async () => {
    const { workspaceId } = await newWorkspace();
    paypal.createPaymentToken.mockRejectedValueOnce(new PayPalError('x', 422, 'dbg-422', 'SETUP_TOKEN_NOT_APPROVED'));
    const { publicToken } = await reserveAndReturn(workspaceId);
    const status = await (await fetch(`${base}/api/public/reservation/${publicToken}`)).json();
    expect(status.reservation.state).toBe('PENDING_APPROVAL');
    expect(status.reservation.message).toMatch(/dbg-422/);
  });

  it('abandons and shows the debug ID when PayPal rejects the setup token', async () => {
    const { workspaceId } = await newWorkspace();
    paypal.createSetupToken.mockRejectedValueOnce(new PayPalError('x', 500, 'dbg-500', 'INTERNAL_SERVER_ERROR'));
    const res = await fetch(`${base}/api/public/campaign/${workspaceId}/reserve`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect((await res.json()).debugId).toBe('dbg-500');
  });

  it('rejects unknown or malformed links', async () => {
    expect((await fetch(`${base}/api/public/campaign/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/public/reservation/${'a'.repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${base}/api/paypal/return?r=../../x`)).status).toBe(404);
  });
});

describe('vault_id never leaves the server (NFR-001, AC-1.6)', () => {
  it('is absent from every API response', async () => {
    const { workspaceId, cookie } = await newWorkspace();
    const { publicToken } = await reserveAndReturn(workspaceId);
    const bodies = await Promise.all(
      [
        fetch(`${base}/api/workspace`, { headers: { cookie } }),
        fetch(`${base}/api/public/campaign/${workspaceId}`),
        fetch(`${base}/api/public/reservation/${publicToken}`),
      ].map(async (p) => (await p).text()),
    );
    for (const b of bodies) {
      expect(b).not.toContain('VAULT-');
      expect(b).not.toMatch(/vault_?id/i);
      expect(b).not.toContain('CUST-');
    }
  });
});
