import { WINDOW_DAYS } from '../shared/types.js';

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function toMs(date: string): number {
  if (!isIsoDate(date)) throw new Error(`Invalid date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

/** BR-006: eligible when ship date minus today is WINDOW_DAYS or fewer. */
export function isInWindow(shipDate: string, today: string): boolean {
  return daysBetween(today, shipDate) <= WINDOW_DAYS;
}

export function windowOpenDate(shipDate: string): string {
  return addDays(shipDate, -WINDOW_DAYS);
}
