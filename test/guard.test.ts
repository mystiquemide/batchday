import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { openDb } from '../src/server/db';

async function start(limits = { workspacesPerHour: 2, reservationsPerHour: 2, cancelsPerHour: 2 }) {
  const paypal = {
    createSetupToken: vi.fn(async (o: { requestId: string }) => ({ setupTokenId: 'ST-' + o.requestId, approveUrl: 'https://www.sandbox.paypal.com/x', debugId: 'd' })),
  };
  const app = createApp({ db: openDb(':memory:'), publicBaseUrl: 'http://bd.test', paypal: paypal as never, limits });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, paypal };
}

describe('rate limits', () => {
  it('limits workspace creation per client and says when to retry', async () => {
    const { base, server } = await start();
    expect((await fetch(`${base}/api/workspace`, { method: 'POST' })).status).toBe(201);
    expect((await fetch(`${base}/api/workspace`, { method: 'POST' })).status).toBe(201);
    const third = await fetch(`${base}/api/workspace`, { method: 'POST' });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await third.json()).error).toMatch(/Too many workspaces/);
    server.close();
  });

  it('counts each client IP separately behind the proxy', async () => {
    const { base, server } = await start();
    const post = (ip: string) => fetch(`${base}/api/workspace`, { method: 'POST', headers: { 'x-forwarded-for': ip } });
    expect((await post('203.0.113.1')).status).toBe(201);
    expect((await post('203.0.113.1')).status).toBe(201);
    expect((await post('203.0.113.1')).status).toBe(429);
    expect((await post('203.0.113.2')).status).toBe(201);
    server.close();
  });

  it('stops reservation spam before it reaches PayPal', async () => {
    const { base, server, paypal } = await start();
    const ws = (await (await fetch(`${base}/api/workspace`, { method: 'POST' })).json()).workspaceId;
    const reserve = () => fetch(`${base}/api/public/campaign/${ws}/reserve`, { method: 'POST' });
    expect((await reserve()).status).toBe(201);
    expect((await reserve()).status).toBe(201);
    expect((await reserve()).status).toBe(429);
    expect(paypal.createSetupToken).toHaveBeenCalledTimes(2);
    server.close();
  });
});

describe('security headers', () => {
  it('sets baseline headers on API responses', async () => {
    const { base, server } = await start();
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-powered-by')).toBeNull();
    server.close();
  });
});
