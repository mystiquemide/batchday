// Registers the Batchday webhook with the PayPal app and prints its id for PAYPAL_WEBHOOK_ID.
// Usage: npm run webhook:register -- https://your-app.onrender.com
import fs from 'node:fs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const origin = process.argv[2]?.replace(/\/$/, '');
if (!origin?.startsWith('https://')) {
  console.error('Pass the public https origin, e.g. npm run webhook:register -- https://batchday.onrender.com');
  process.exit(1);
}
const base = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
  method: 'POST',
  headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
const { access_token } = (await tokenRes.json()) as { access_token: string };
const url = `${origin}/api/paypal/webhook`;

const existing = (await (await fetch(`${base}/v1/notifications/webhooks`, { headers: { Authorization: `Bearer ${access_token}` } })).json()) as {
  webhooks?: { id: string; url: string }[];
};
const found = existing.webhooks?.find((w) => w.url === url);
if (found) {
  console.log(`Already registered. PAYPAL_WEBHOOK_ID=${found.id}`);
  process.exit(0);
}

const res = await fetch(`${base}/v1/notifications/webhooks`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url,
    event_types: ['VAULT.PAYMENT-TOKEN.DELETED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED'].map((name) => ({ name })),
  }),
});
const body = (await res.json()) as { id?: string; message?: string; details?: unknown };
if (!res.ok || !body.id) {
  console.error(`PayPal returned HTTP ${res.status}`, body.message ?? '', JSON.stringify(body.details ?? ''));
  process.exit(1);
}
console.log(`Registered ${url}\nPAYPAL_WEBHOOK_ID=${body.id}`);
export {};
