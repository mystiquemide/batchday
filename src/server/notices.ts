import { WINDOW_DAYS, type NoticeDraft, type ReservationState } from '../shared/types.js';
import type { Db } from './db.js';
import { GeminiError, generateJson } from './gemini.js';
import { daysBetween } from './dates.js';
import { getBatches, getCampaign } from './store.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The single spelling drafts must use for a date, e.g. "November 27, 2026". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export interface NoticeGroup {
  key: string;
  batchNumber: number;
  kind: NoticeDraft['kind'];
  recipients: string[];
  reservationIds: string[];
  facts: Record<string, string>;
}

/**
 * Buyers who need a notice: reserved buyers whose batch ship date changed since they were last
 * told, and charged buyers whose reservation is AT_RISK. Grouped so each group shares one set of facts.
 */
export function noticeGroups(db: Db, workspaceId: string, now = new Date()): NoticeGroup[] {
  const campaign = getCampaign(db, workspaceId)!;
  const batches = new Map(getBatches(db, workspaceId, now).map((b) => [b.number, b]));
  const rows = db
    .prepare(
      `SELECT id, state, batch_number, buyer_email, notified_ship_date, charged_at FROM reservation
        WHERE workspace_id = ? AND state IN ('RESERVED','CHARGED','AT_RISK') AND batch_number IS NOT NULL ORDER BY created_at`,
    )
    .all(workspaceId) as {
    id: string;
    state: ReservationState;
    batch_number: number;
    buyer_email: string | null;
    notified_ship_date: string | null;
    charged_at: string | null;
  }[];

  const groups = new Map<string, NoticeGroup>();
  for (const r of rows) {
    const b = batches.get(r.batch_number);
    if (!b) continue;
    let kind: NoticeDraft['kind'] | null = null;
    if (r.state === 'AT_RISK') kind = 'at_risk';
    else if (r.notified_ship_date && r.notified_ship_date !== b.shipDate) kind = 'ship_date_changed';
    if (!kind) continue;
    // Only a known, different earlier date is a fact; reservations made before baselines existed have none.
    const old = r.notified_ship_date && r.notified_ship_date !== b.shipDate ? r.notified_ship_date : null;
    const chargeStatus = r.state === 'RESERVED' ? 'not charged yet' : 'already charged';
    const chargedOn = r.charged_at?.slice(0, 10) ?? null;
    const key = `${kind}:${b.number}:${old ?? '-'}:${kind === 'at_risk' ? chargedOn : chargeStatus}`;
    const facts: Record<string, string> = {
      product: campaign.productName,
      amount: `$${campaign.unitPrice}`,
      batch: String(b.number),
      ...(old ? { previous_ship_date: longDate(old) } : {}),
      new_ship_date: longDate(b.shipDate),
      charging_rule: `Buyers are charged only once their batch is ${WINDOW_DAYS} days or less from shipping.`,
    };
    if (kind === 'ship_date_changed') {
      facts.charge_status = chargeStatus;
      if (r.state === 'RESERVED') facts.charging_opens = longDate(b.windowOpenDate);
    } else {
      facts.charged_on = longDate(chargedOn!);
      facts.days_from_charge_to_ship = `${daysBetween(chargedOn!, b.shipDate)} days`;
      facts.promise = `Shipment within ${WINDOW_DAYS} days of the charge.`;
      facts.seller_options = 'a full refund, or keeping the order';
    }
    const g = groups.get(key) ?? { key, batchNumber: b.number, kind, recipients: [], reservationIds: [], facts };
    if (r.buyer_email && !g.recipients.includes(r.buyer_email)) g.recipients.push(r.buyer_email);
    g.reservationIds.push(r.id);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Template used when the AI is unavailable or its draft fails the fact check. Uses only facts. */
export function templateDraft(g: Pick<NoticeGroup, 'kind' | 'facts'>): { subject: string; body: string } {
  const f = g.facts;
  if (g.kind === 'at_risk') {
    return {
      subject: `Update on your ${f.product} pre-order: batch ${f.batch} is delayed`,
      body: `Hi,\n\nYou were charged ${f.amount} on ${f.charged_on} for your ${f.product} pre-order in batch ${f.batch}. ${
        f.previous_ship_date ? `That batch was planned to ship ${f.previous_ship_date} and now ships ${f.new_ship_date}` : `That batch now ships ${f.new_ship_date}`
      }, ${f.days_from_charge_to_ship} after your charge. Our promise is shipment within ${WINDOW_DAYS} days of the charge.\n\nWe can give you a full refund, or you can keep your order. Reply to this email and let us know.\n\nThank you for your patience.`,
    };
  }
  const charge =
    f.charge_status === 'not charged yet'
      ? `You have not been charged yet. Your ${f.amount} charge now happens on or after ${f.charging_opens}. ${f.charging_rule}`
      : `Your ${f.amount} payment is unchanged.`;
  return {
    subject: `Your ${f.product} pre-order now ships ${f.new_ship_date}`,
    body: `Hi,\n\nThe ship date for batch ${f.batch} of ${f.product} has changed${f.previous_ship_date ? ` from ${f.previous_ship_date}` : ''} to ${f.new_ship_date}.\n\n${charge}\n\nYou can check your reservation status at any time using the link from your confirmation.\n\nThank you.`,
  };
}

const MONTH_NAMES = [...MONTHS, ...MONTHS.map((m) => m.slice(0, 3))].join('|');
const DATE_PATTERN = new RegExp(
  `\\b(?:${MONTH_NAMES})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_NAMES})\\b(?:,?\\s+\\d{4})?|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b`,
  'g',
);
const MONEY_PATTERN = /(?:\$|USD\s?)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|dollars)\b/gi;

/** FR-020: every date and amount in a draft must be one of the facts, written the same way. */
export function factCheck(text: string, facts: Record<string, string>): string[] {
  const allowed = new Set(Object.values(facts));
  const problems: string[] = [];
  for (const m of text.match(DATE_PATTERN) ?? []) {
    if (!allowed.has(m.trim())) problems.push(`date "${m.trim()}" is not in the facts`);
  }
  for (const m of text.match(MONEY_PATTERN) ?? []) {
    if (!allowed.has(m.replace(/\s/g, ''))) problems.push(`amount "${m.trim()}" is not in the facts`);
  }
  return problems;
}

const SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
};

const SYSTEM = `You write short, plain, friendly emails from a small pre-order seller to buyers.
Use only the facts given. Do not invent dates, amounts, reasons for the delay, discounts, or promises.
Write every date and amount exactly as it appears in the facts. Do not write any other dates or amounts.
If a fact is missing (for example no previous_ship_date), do not mention it. Restate charging_rule and promise in plain words without reinterpreting them.
No greeting by name (the email goes to several buyers). No sign-off name. Under 120 words.`;

export type Drafter = (kind: NoticeDraft['kind'], facts: Record<string, string>) => Promise<{ subject: string; body: string }>;

export const geminiDrafter: Drafter = async (kind, facts) => {
  const purpose =
    kind === 'at_risk'
      ? 'The buyer was already charged and their batch now ships later than the window allows after their charge. Explain, and offer the options in seller_options.'
      : 'The batch ship date changed. Tell the buyer the new date and what it means for their charge.';
  const { data } = await generateJson<{ subject: string; body: string }>({
    system: SYSTEM,
    user: `${purpose}\n\nFacts (JSON):\n${JSON.stringify(facts)}`,
    schema: SCHEMA,
  });
  if (typeof data?.subject !== 'string' || typeof data?.body !== 'string') throw new GeminiError('bad draft', 200, 'bad_output');
  return data;
};

/** Drafts are shown to the seller only and labeled as not sent. Batchday never emails buyers. */
export async function draftNotices(db: Db, workspaceId: string, now = new Date(), drafter: Drafter = geminiDrafter): Promise<NoticeDraft[]> {
  const out: NoticeDraft[] = [];
  for (const g of noticeGroups(db, workspaceId, now)) {
    let draft: { subject: string; body: string } | null = null;
    let sourceNote: string | null = null;
    try {
      const ai = await drafter(g.kind, g.facts);
      const problems = factCheck(`${ai.subject}\n${ai.body}`, g.facts);
      if (problems.length) sourceNote = `AI draft replaced by template: ${problems.join('; ')}`;
      else draft = ai;
    } catch (err) {
      sourceNote = `AI draft unavailable (${err instanceof GeminiError ? err.kind : 'error'}), template used`;
    }
    const final = draft ?? templateDraft(g);
    out.push({
      key: g.key,
      batchNumber: g.batchNumber,
      kind: g.kind,
      recipients: g.recipients,
      facts: g.facts,
      subject: final.subject,
      body: final.body,
      source: draft ? 'ai' : 'template',
      sourceNote,
    });
  }
  return out;
}

/** After the seller has told buyers, the current ship date becomes their new baseline. */
export function markNotified(db: Db, workspaceId: string, batchNumber: number, now = new Date()): number {
  const b = getBatches(db, workspaceId, now).find((x) => x.number === batchNumber);
  if (!b) return 0;
  return db
    .prepare("UPDATE reservation SET notified_ship_date = ? WHERE workspace_id = ? AND batch_number = ? AND state IN ('RESERVED','CHARGED','AT_RISK')")
    .run(b.shipDate, workspaceId, batchNumber).changes;
}
