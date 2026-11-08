import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isInWindow, windowOpenDate } from '../src/server/dates';
import { buildTemplatePlan } from '../src/server/template';

describe('20-day window (BR-006)', () => {
  const today = '2026-11-08';
  it('is eligible at 19 and 20 days, not at 21', () => {
    expect(isInWindow(addDays(today, 19), today)).toBe(true);
    expect(isInWindow(addDays(today, 20), today)).toBe(true);
    expect(isInWindow(addDays(today, 21), today)).toBe(false);
  });
  it('window opens 20 days before ship', () => {
    expect(windowOpenDate('2026-12-02')).toBe('2026-11-12');
  });
  it('crosses month and year boundaries in UTC', () => {
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(daysBetween('2026-12-25', '2027-01-04')).toBe(10);
  });
});

describe('template plan (FR-001)', () => {
  const { tasks, dependencies } = buildTemplatePlan('2026-11-08');
  it('has at least 8 tasks across 3 batches with FS links', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(8);
    expect(new Set(tasks.filter((t) => t.batchNumber).map((t) => t.batchNumber))).toEqual(new Set([1, 2, 3]));
    expect(tasks.filter((t) => t.kind === 'ship_batch')).toHaveLength(3);
    expect(dependencies.length).toBeGreaterThanOrEqual(tasks.length - 1);
  });
  it('never starts a successor before its predecessor ends', () => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const d of dependencies) {
      const from = byId.get(d.fromTask)!;
      const to = byId.get(d.toTask)!;
      expect(daysBetween(addDays(from.startDate, from.duration), to.startDate)).toBeGreaterThanOrEqual(0);
    }
  });
  it('starts every batch outside the window so nothing is chargeable on day one', () => {
    for (const t of tasks.filter((t) => t.kind === 'ship_batch')) {
      expect(isInWindow(t.startDate, '2026-11-08')).toBe(false);
    }
  });
});
