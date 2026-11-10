import { WINDOW_DAYS, type ReservationState, type TaskScheduleInput } from './types';

const DAY_MS = 86_400_000;

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export interface PreviewBatch {
  batch: number;
  shipDate: string;
  daysToShip: number;
  /** Reserved buyers the engine would charge on save. */
  toCharge: number;
  /** Charged buyers whose batch would ship more than 20 days after their charge. */
  toRisk: number;
}

export interface ChargePreview {
  batches: PreviewBatch[];
  toCharge: number;
  toRisk: number;
  /** Total that would be charged, in the campaign currency. */
  amount: number;
}

const CHARGEABLE: ReservationState[] = ['RESERVED', 'CHARGE_FAILED'];

/**
 * What saving this schedule would do to buyers, using the same rules as the server:
 * a batch is chargeable when its ship date is WINDOW_DAYS or fewer from today (UTC),
 * and a charged buyer is at risk when their batch ships more than WINDOW_DAYS after the charge.
 * The server re-checks everything on save. This only decides whether to ask the seller first.
 */
export function previewCharges(input: {
  schedule: TaskScheduleInput[];
  shipTasks: { id: number; batchNumber: number }[];
  reservations: { batchNumber: number | null; state: ReservationState; chargedAt: string | null }[];
  unitPrice: number;
  today: string;
}): ChargePreview {
  const start = new Map(input.schedule.map((t) => [t.id, t.startDate]));
  const batches: PreviewBatch[] = [];
  for (const s of input.shipTasks) {
    const shipDate = start.get(s.id);
    if (!shipDate) continue;
    const daysToShip = days(input.today, shipDate);
    const rs = input.reservations.filter((r) => r.batchNumber === s.batchNumber);
    const toCharge = daysToShip <= WINDOW_DAYS ? rs.filter((r) => CHARGEABLE.includes(r.state)).length : 0;
    const toRisk = rs.filter(
      (r) => r.state === 'CHARGED' && r.chargedAt && days(r.chargedAt.slice(0, 10), shipDate) > WINDOW_DAYS,
    ).length;
    batches.push({ batch: s.batchNumber, shipDate, daysToShip, toCharge, toRisk });
  }
  const toCharge = batches.reduce((n, b) => n + b.toCharge, 0);
  const toRisk = batches.reduce((n, b) => n + b.toRisk, 0);
  return { batches, toCharge, toRisk, amount: Math.round(toCharge * input.unitPrice * 100) / 100 };
}
