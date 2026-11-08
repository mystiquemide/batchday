import type { Db } from './db.js';

/**
 * FR-021: PayPal webhooks. Every event is verified with PayPal before it changes anything,
 * and each event id is processed at most once.
 */

const HEADERS = {
  authAlgo: 'paypal-auth-algo',
  certUrl: 'paypal-cert-url',
  transmissionId: 'paypal-transmission-id',
  transmissionSig: 'paypal-transmission-sig',
  transmissionTime: 'paypal-transmission-time',
} as const;

export type VerifyFn = (rawBody: string, headers: Record<string, string | undefined>) => Promise<boolean>;

async function accessToken(): Promise<string> {
  const base = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed with HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Asks PayPal whether the event is genuine. The raw body is passed through unchanged so the signature still matches. */
export const verifyWithPayPal: VerifyFn = async (rawBody, headers) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const h = (k: string) => headers[k];
  if (Object.values(HEADERS).some((k) => !h(k))) return false;
  const base = process.env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com';
  const body =
    `{"auth_algo":${JSON.stringify(h(HEADERS.authAlgo))},"cert_url":${JSON.stringify(h(HEADERS.certUrl))},` +
    `"transmission_id":${JSON.stringify(h(HEADERS.transmissionId))},"transmission_sig":${JSON.stringify(h(HEADERS.transmissionSig))},` +
    `"transmission_time":${JSON.stringify(h(HEADERS.transmissionTime))},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`;
  const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) return false;
  return ((await res.json()) as { verification_status?: string }).verification_status === 'SUCCESS';
};

interface PayPalEvent {
  id?: string;
  event_type?: string;
  resource?: { id?: string; status?: string; links?: { rel?: string; href?: string }[] };
}

export type WebhookOutcome = 'ignored_unverified' | 'duplicate' | 'processed' | 'ignored_type' | 'bad_request';

export async function handleWebhook(
  db: Db,
  rawBody: string,
  headers: Record<string, string | undefined>,
  verify: VerifyFn,
  now = new Date(),
): Promise<{ outcome: WebhookOutcome; changed: number }> {
  let event: PayPalEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { outcome: 'bad_request', changed: 0 };
  }
  if (!event.id || !event.event_type) return { outcome: 'bad_request', changed: 0 };

  let verified = false;
  try {
    verified = await verify(rawBody, headers);
  } catch (err) {
    console.error('webhook verification failed', err instanceof Error ? err.message : err);
  }
  if (!verified) {
    console.warn('unverified webhook ignored', { type: event.event_type, id: event.id.slice(0, 12) });
    return { outcome: 'ignored_unverified', changed: 0 };
  }

  const inserted = db
    .prepare('INSERT OR IGNORE INTO webhook_event (id, type, verified, received_at) VALUES (?, ?, 1, ?)')
    .run(event.id, event.event_type, now.toISOString()).changes;
  if (!inserted) return { outcome: 'duplicate', changed: 0 };

  let changed = 0;
  const res = event.resource ?? {};
  switch (event.event_type) {
    case 'VAULT.PAYMENT-TOKEN.DELETED': {
      // The buyer removed the saved wallet at PayPal: nothing can be charged on it any more.
      if (!res.id) break;
      changed += db
        .prepare(
          `UPDATE reservation SET state = 'REVOKED', message = 'The buyer removed this saved PayPal wallet at PayPal.'
            WHERE vault_id = ? AND state IN ('RESERVED','CHARGE_FAILED')`,
        )
        .run(res.id).changes;
      changed += db
        .prepare("UPDATE reservation SET token_deleted_at = ? WHERE vault_id = ? AND token_deleted_at IS NULL AND state IN ('CANCELLED','REVOKED')")
        .run(now.toISOString(), res.id).changes;
      break;
    }
    case 'PAYMENT.CAPTURE.REFUNDED': {
      // Refund made outside Batchday (for example in the PayPal dashboard). The capture is the refund's "up" link.
      const up = res.links?.find((l) => l.rel === 'up')?.href ?? '';
      const captureId = up.split('/').pop();
      if (!captureId || !res.id) break;
      changed += db
        .prepare(
          `UPDATE reservation SET state = 'REFUNDED', refund_id = COALESCE(refund_id, ?), refund_status = ?, refunded_at = COALESCE(refunded_at, ?),
                  message = COALESCE(message, 'Refunded at PayPal.')
            WHERE capture_id = ? AND state IN ('CHARGED','AT_RISK')`,
        )
        .run(res.id, res.status ?? 'COMPLETED', now.toISOString(), captureId).changes;
      break;
    }
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.DENIED':
      // Charges are recorded from the Orders response; these events are kept for the audit trail only.
      break;
    default:
      db.prepare('UPDATE webhook_event SET processed_note = ? WHERE id = ?').run('unhandled type', event.id);
      return { outcome: 'ignored_type', changed: 0 };
  }
  db.prepare('UPDATE webhook_event SET processed_note = ? WHERE id = ?').run(`changed ${changed}`, event.id);
  console.log('verified webhook processed', { type: event.event_type, id: event.id.slice(0, 12), changed });
  return { outcome: 'processed', changed };
}
