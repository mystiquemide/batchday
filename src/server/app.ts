import express, { type Request, type Response } from 'express';
import type { Db } from './db.js';
import { PayPalError, chargeVault, createPaymentToken, createSetupToken, deletePaymentToken, refundCapture } from './paypal.js';
import { RefundRejected, evaluateRisk, refundReservation } from './risk.js';
import { type Drafter, draftNotices, geminiDrafter, markNotified } from './notices.js';
import { chargeLog, runEngine, type EngineSummary } from './engine.js';
import { PlanRejected, getPlanVersion, savePlan } from './plan.js';
import { UpdateRejected, geminiParser, getUpdate, listUpdates, previewImpact, resolveUpdate, submitUpdate } from './supplier.js';
import {
  abandon,
  attachSetupToken,
  cancelReservation,
  markTokenDeleted,
  tokenNeededElsewhere,
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
  type ReservationRow,
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
  paypal?: {
    createSetupToken: typeof createSetupToken;
    createPaymentToken: typeof createPaymentToken;
    chargeVault: typeof chargeVault;
    deletePaymentToken: typeof deletePaymentToken;
    refundCapture: typeof refundCapture;
  };
  now?: () => Date;
  parseSupplierText?: typeof geminiParser;
  draftNotice?: Drafter;
}

export function createApp({
  db,
  publicBaseUrl,
  paypal = { createSetupToken, createPaymentToken, chargeVault, deletePaymentToken, refundCapture },
  now = () => new Date(),
  parseSupplierText = geminiParser,
  draftNotice = geminiDrafter,
}: AppDeps) {
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

  const workspaceView = (id: string, engine?: EngineSummary) => {
    const batches = getBatches(db, id, now());
    return {
    campaign: getCampaign(db, id),
    planVersion: getPlanVersion(db, id),
    plan: getPlan(db, id),
    batches,
    reservations: listReservations(db, id).map((r) => toView(r, false, batches, true)),
    charges: chargeLog(db, id),
    updates: listUpdates(db, id).map((u) => (u.state === 'PROPOSED' ? { ...u, impact: previewImpact(db, id, u.proposals, now()) } : u)),
    windowDays: WINDOW_DAYS,
    ...(engine ? { engine } : {}),
    };
  };

  app.get('/api/workspace', (req, res) => {
    const id = sellerWorkspace(req, res);
    if (!id) return;
    evaluateRisk(db, id, now()); // keep AT_RISK current even between engine runs
    res.json(workspaceView(id));
  });

  // FR-019: seller refunds a charged reservation in full.
  app.post('/api/workspace/reservations/:reservationId/refund', async (req, res) => {
    const id = sellerWorkspace(req, res);
    if (!id) return;
    const rid = req.params.reservationId;
    if (!HEX32.test(rid)) return res.status(404).json({ error: 'Reservation not found.' });
    try {
      await refundReservation(db, id, rid, { refundCapture: paypal.refundCapture, now });
      res.json(workspaceView(id));
    } catch (err) {
      if (err instanceof RefundRejected) return res.status(err.status).json({ error: err.message, debugId: err.debugId });
      throw err;
    }
  });

  // FR-020: drafts for buyers affected by plan changes. Never sent by Batchday.
  app.post('/api/workspace/notices/draft', async (req, res) => {
    const id = sellerWorkspace(req, res);
    if (!id) return;
    evaluateRisk(db, id, now());
    res.json({ drafts: await draftNotices(db, id, now(), draftNotice) });
  });

  app.post('/api/workspace/notices/mark-notified', (req, res) => {
    const id = sellerWorkspace(req, res);
    if (!id) return;
    const batch = req.body?.batchNumber;
    if (!Number.isInteger(batch)) return res.status(422).json({ error: 'batchNumber is required.' });
    res.json({ updated: markNotified(db, id, batch, now()) });
  });

  // FR-003, FR-004, FR-008: save the rescheduled plan, then run the charge engine on it.
  app.put('/api/workspace/plan', async (req, res) => {
    const id = sellerWorkspace(req, res);
    if (!id) return;
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required.' });
    try {
      savePlan(db, id, req.body, now());
    } catch (err) {
      if (err instanceof PlanRejected) return res.status(err.status).json({ error: err.message, problems: err.problems });
      throw err;
    }
    const engine = await runEngine({ db, paypal, now }, id);
    res.json(workspaceView(id, engine));
  });

  // ---- Supplier updates (Slice 4). The model only proposes; the seller applies through the plan save path. ----

  app.post('/api/workspace/updates', async (req, res) => {
    const id = sellerWorkspace(req, res);
    if (!id) return;
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required.' });
    try {
      const update = await submitUpdate(db, id, req.body?.text, now(), parseSupplierText);
      const impact = update.state === 'PROPOSED' ? previewImpact(db, id, update.proposals, now()) : null;
      res.status(201).json({ update: { ...update, impact } });
    } catch (err) {
      if (err instanceof UpdateRejected) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

  for (const [action, state] of [['apply', 'APPLIED'], ['discard', 'DISCARDED']] as const) {
    app.post(`/api/workspace/updates/:updateId/${action}`, (req, res) => {
      const id = sellerWorkspace(req, res);
      if (!id) return;
      const updateId = req.params.updateId;
      if (!HEX32.test(updateId) || !getUpdate(db, id, updateId)) return res.status(404).json({ error: 'Update not found.' });
      try {
        res.json({ update: resolveUpdate(db, id, updateId, state) });
      } catch (err) {
        if (err instanceof UpdateRejected) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    });
  }

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
    res.json(publicReservation(r.id));
  });

  function publicReservation(reservationId: string) {
    const r = db.prepare('SELECT * FROM reservation WHERE id = ?').get(reservationId) as ReservationRow;
    const batches = getBatches(db, r.workspace_id, now());
    const batch = r.batch_number === null ? null : batches.find((b) => b.number === r.batch_number) ?? null;
    return { campaign: getCampaign(db, r.workspace_id)!, reservation: toView(r, false, batches), batch, windowDays: WINDOW_DAYS };
  }

  // FR-013: buyer cancels before being charged; the saved wallet is deleted at PayPal.
  app.post('/api/public/reservation/:publicToken/cancel', async (req, res) => {
    const token = req.params.publicToken;
    const r = HEX32.test(token) ? getReservationByPublicToken(db, token) : null;
    if (!r) return res.status(404).json({ error: 'Reservation not found.' });

    const outcome = cancelReservation(db, r.id);
    if (outcome === 'in_progress') {
      return res.status(409).json({ error: 'A charge for this reservation is being processed right now. Refresh in a moment.' });
    }
    if (outcome === 'not_cancellable') {
      return res.status(409).json({ error: 'This reservation can no longer be cancelled here.' });
    }
    // A wallet shared with another live reservation is deleted later by the tick, once nothing needs it.
    if (outcome === 'cancelled' && r.vault_id && !tokenNeededElsewhere(db, r.id, r.vault_id)) {
      try {
        const del = await paypal.deletePaymentToken(r.vault_id);
        markTokenDeleted(db, r.id, del.debugId, now());
      } catch (err) {
        // The reservation is already CANCELLED and excluded from charging; the tick retries the delete.
        const pe = err instanceof PayPalError ? err : null;
        console.error('token delete failed', pe ? { status: pe.status, debugId: pe.debugId, issue: pe.issue } : err);
      }
    }
    res.json(publicReservation(r.id));
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  return app;
}
