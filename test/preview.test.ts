import { describe, expect, it } from 'vitest';
import { previewCharges } from '../src/shared/preview';

const ship = [
  { id: 5, batchNumber: 1 },
  { id: 9, batchNumber: 2 },
];
const at = (id: number, startDate: string) => ({ id, startDate, duration: 0, constraintType: null, constraintDate: null });

describe('previewCharges', () => {
  it('counts reserved buyers in a batch that moves inside 20 days', () => {
    const p = previewCharges({
      schedule: [at(5, '2026-11-30'), at(9, '2026-12-20')],
      shipTasks: ship,
      reservations: [
        { batchNumber: 1, state: 'RESERVED', chargedAt: null },
        { batchNumber: 1, state: 'CHARGE_FAILED', chargedAt: null },
        { batchNumber: 1, state: 'CANCELLED', chargedAt: null },
        { batchNumber: 2, state: 'RESERVED', chargedAt: null },
      ],
      unitPrice: 49,
      today: '2026-11-10',
    });
    expect(p.toCharge).toBe(2);
    expect(p.amount).toBe(98);
    expect(p.batches.find((b) => b.batch === 2)?.toCharge).toBe(0);
  });

  it('charges at exactly 20 days and not at 21', () => {
    const base = { shipTasks: [ship[0]], reservations: [{ batchNumber: 1, state: 'RESERVED' as const, chargedAt: null }], unitPrice: 49, today: '2026-11-10' };
    expect(previewCharges({ ...base, schedule: [at(5, '2026-11-30')] }).toCharge).toBe(1);
    expect(previewCharges({ ...base, schedule: [at(5, '2026-12-01')] }).toCharge).toBe(0);
  });

  it('flags charged buyers whose batch slips past 20 days from their charge', () => {
    const p = previewCharges({
      schedule: [at(5, '2026-12-05')],
      shipTasks: [ship[0]],
      reservations: [
        { batchNumber: 1, state: 'CHARGED', chargedAt: '2026-11-10T09:00:00.000Z' },
        { batchNumber: 1, state: 'CHARGED', chargedAt: '2026-11-20T09:00:00.000Z' },
      ],
      unitPrice: 49,
      today: '2026-11-10',
    });
    expect(p.toRisk).toBe(1);
    expect(p.toCharge).toBe(0);
  });
});
