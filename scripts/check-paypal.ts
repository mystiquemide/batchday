// Fetches a PayPal OAuth token to confirm sandbox credentials work. Prints no secrets.
const base = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) {
  console.error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
  process.exit(1);
}
const res = await fetch(`${base}/v1/oauth2/token`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials',
});
const body = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string };
console.log(JSON.stringify({
  http: res.status,
  token_received: Boolean(body.access_token),
  expires_in: body.expires_in,
  vault_scope: body.scope?.includes('vault') ?? false,
  debug_id: res.headers.get('paypal-debug-id'),
}));
process.exit(res.ok && body.access_token ? 0 : 1);
export {};
