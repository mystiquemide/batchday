import express, { type Request, type Response } from 'express';
import type { Db } from './db.js';
import { PayPalError, createPaymentToken, createSetupToken } from './paypal.js';
import {
  abandon,
  attachSetupToken,
  createPendingReservation,
  createWorkspace,
  getBatches,
  getCampaign,
  getPlan,
  getReservationByPublicToken,
  listReservations,
  nextOpenBatch,
  setPendingMessage,
  toView,
  confirmReservation,
} from './store.js';
import { WINDOW_DAYS } from '../shared/types.js';

const COOKIE = 'bd_ws';
const HEX32 = /^[0-9a-f]{32}$/;

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function paypalErrorBody(err: unknown) {
  if (err instanceof PayPalError) {
    return { error: 'PayPal could not complete the request.', debugId: err.debugId, issue: err.issue };
  }
  return { error: 'Unexpected server error.' };
}

export interface AppDeps {
  db: Db;
  publicBaseUrl: string;
  paypal?: { createSetupToken: typeof createSetupToken; createPaymentToken: typeof createPaymentToken };
  now?: () => Date;
}

export function createApp({ db, publicBaseUrl, paypal = { createSetupToken, createPaymentToken }, now = () => new Date() }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ---- Seller workspace (FR-022 basic: unguessable ID in an HttpOnly cookie) ----

  function sellerWorkspace(req: Request, res: Response): string | null {
    const id = readCookie(req, COOKIE);
    if (!id || !HEX32.test(id) || !getCampaign(db, id)) {
      res.status(404).json({ error: 'No workspace. Start one first.' });
      return null;
    }
    return id;
  }

  app.post('/api/workspace', (_req, res) => {
    const id = createWorkspace(db, now());
    res.cookie(COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: publicBaseUrl.startsWith('https://'),
      maxAge: 60 * 86_400_000,
      path: '/',
    });
    res.status(201).json({ workspaceId: id });
  });

  app.get('/api/workspace', (req, res) => {
    const id = sellerWorkspace(req, res);
    if (!id) return;
    res.json({
      campaign: getCampaign(db, id),
      plan: getPlan(db, id),
      batches: getBatches(db, id, now()),
      reservations: listReservations(db, id).map((r) => toView(r, false)),
      windowDays: WINDOW_DAYS,
    });
  });

  // ---- Buyer pages ----

  app.get('/api/public/campaign/:workspaceId', (req, res) => {
    const id = req.params.workspaceId;
    const campaign = HEX32.test(id) ? getCampaign(db, id) : null;
    if (!campaign) return res.status(404).json({ error: 'This reservation link is not valid.' });
    const next = nextOpenBatch(db, id, now());
    res.json({ campaign, nextBatch: next, soldOut: next === null, windowDays: WINDOW_DAYS });
  });

  app.post('/api/public/campaign/:workspaceId/reserve', async (req, res) => {
    const id = req.params.workspaceId;
    const campaign = HEX32.test(id) ? getCampaign(db, id) : null;
    if (!campaign) return res.status(404).json({ error: 'This reservation link is not valid.' });
    if (!nextOpenBatch(db, id, now())) return res.status(409).json({ error: 'Sold out. Every batch is full.' });

    const reservation = createPendingReservation(db, id, now());
    const q = `r=${reservation.public_token}`;
    try {
      const token = await paypal.createSetupToken({
        requestId: `st-${reservation.id}`,
        returnUrl: `${publicBaseUrl}/api/paypal/return?${q}`,
        cancelUrl: `${publicBaseUrl}/api/paypal/cancel?${q}`,
        description: `${campaign.productName} reservation. Charged only when your batch is within ${WINDOW_DAYS} days of shipping.`,
      });
      attachSetupToken(db, reservation.id, token.setupTokenId);
      res.status(201).json({ approveUrl: token.approveUrl, statusPath: `/s/${reservation.public_token}` });
    } catch (err) {
      abandon(db, reservation.id, 'PayPal could not start the reservation.');
      console.error('setup token failed', err instanceof PayPalError ? { status: err.status, debugId: err.debugId, issue: err.issue } : err);
      res.status(502).json(paypalErrorBody(err));
    }
  });

  app.get('/api/paypal/return', async (req, res) => {
    const token = String(req.query.r ?? '');
    const r = HEX32.test(token) ? getReservationByPublicToken(db, token) : null;
    if (!r) return res.status(404).send('Reservation not found.');
    const statusUrl = `/s/${r.public_token}`;
    if (r.state !== 'PENDING_APPROVAL' || !r.setup_token_id) return res.redirect(303, statusUrl);

    try {
      const approved = await paypal.createPaymentToken({ requestId: `pt-${r.id}`, setupTokenId: r.setup_token_id });
      const outcome = confirmReservation(db, r.id, approved, now());
      if (outcome === 'sold_out') {
        abandon(db, r.id, 'Every batch filled up while you were at PayPal. You have not been charged.');
      }
    } catch (err) {
      const pe = err instanceof PayPalError ? err : null;
      console.error('payment token failed', pe ? { status: pe.status, debugId: pe.debugId, issue: pe.issue } : err);
      setPendingMessage(
        db,
        r.id,
        pe
          ? `PayPal has not confirmed approval yet (${pe.issue ?? `HTTP ${pe.status}`}, debug ID ${pe.debugId ?? 'none'}).`
          : 'Could not confirm approval with PayPal.',
      );
    }
    res.redirect(303, statusUrl);
  });

  app.get('/api/paypal/cancel', (req, res) => {
    const token = String(req.query.r ?? '');
    const r = HEX32.test(token) ? getReservationByPublicToken(db, token) : null;
    if (!r) return res.status(404).send('Reservation not found.');
    abandon(db, r.id, 'You cancelled at PayPal. No reservation was made and nothing was charged.');
    res.redirect(303, `/s/${r.public_token}`);
  });

  app.get('/api/public/reservation/:publicToken', (req, res) => {
    const token = req.params.publicToken;
    const r = HEX32.test(token) ? getReservationByPublicToken(db, token) : null;
    if (!r) return res.status(404).json({ error: 'Reservation not found.' });
    const campaign = getCampaign(db, r.workspace_id)!;
    const batch = r.batch_number === null ? null : getBatches(db, r.workspace_id, now()).find((b) => b.number === r.batch_number) ?? null;
    res.json({ campaign, reservation: toView(r, false), batch, windowDays: WINDOW_DAYS });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  return app;
}
