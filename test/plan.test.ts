import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { addDays } from '../src/server/dates';
import { openDb, type Db } from '../src/server/db';
import { randomId } from '../src/server/store';
import type { PlanDependency, PlanTask, TaskScheduleInput } from '../src/shared/types';

const NOW = new Date('2026-11-08T12:00:00Z');
let db: Db;
let base: string;
let cookie: string;
let ws: string;
const chargeVault = vi.fn(async (o: { requestId: string }) => ({
  orderId: `O-${o.requestId}`, orderStatus: 'COMPLETED', captureId: `C-${o.requestId}`, captureStatus: 'COMPLETED', debugId: 'dbg',
}));

/** Finish-to-start forward pass, like Bryntum's engine for this plan. */
function reschedule(
  tasks: PlanTask[],
  deps: PlanDependency[],
  durations: Record<number, number>,
  snet: Record<number, string> = {},
): TaskScheduleInput[] {
  const out = new Map<number, TaskScheduleInput>();
  for (const t of tasks) {
    const preds = deps.filter((d) => d.toTask === t.id).map((d) => out.get(d.fromTask)!);
    const earliest = [...preds.map((p) => addDays(p.startDate, p.duration)), ...(snet[t.id] ? [snet[t.id]] : [])].sort().at(-1);
    out.set(t.id, {
      id: t.id,
      startDate: earliest ?? t.startDate,
      duration: durations[t.id] ?? t.duration,
      constraintType: snet[t.id] ? 'startnoearlierthan' : null,
      constraintDate: snet[t.id] ?? null,
    });
  }
  return [...out.values()];
}

async function getWs() {
  return (await fetch(`${base}/api/workspace`, { headers: { cookie } })).json();
}
async function save(body: unknown) {
  return fetch(`${base}/api/workspace/plan`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  chargeVault.mockClear();
  db = openDb(':memory:');
  const app = createApp({ db, publicBaseUrl: 'http://bd.test', paypal: { chargeVault } as never, now: () => NOW });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/workspace`, { method: 'POST' });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
  ws = (await res.json()).workspaceId;
});

describe('plan save (FR-003, FR-004)', () => {
  it('saves a rescheduled plan, bumps the version, and recomputes ship dates', async () => {
    const before = await getWs();
    const tasks = reschedule(before.plan.tasks, before.plan.dependencies, { 4: 12 }); // freight batch 1 slips 5 days
    const res = await save({ planVersion: before.planVersion, tasks });
    expect(res.status).toBe(200);
    const after = await res.json();
    expect(after.planVersion).toBe(before.planVersion + 1);
    expect(after.batches[0].shipDate).toBe('2026-12-07');
    expect(after.campaign.isTemplate).toBe(false);
    expect((await getWs()).plan.tasks.find((t: PlanTask) => t.id === 5).startDate).toBe('2026-12-07');
  });

  it('rejects a successor that starts before its predecessor ends, naming both tasks (AC-2.2)', async () => {
    const before = await getWs();
    const tasks = reschedule(before.plan.tasks, before.plan.dependencies, {});
    tasks.find((t) => t.id === 3)!.startDate = '2026-11-20'; // QC batch 1 before factory run ends Nov 22
    const res = await save({ planVersion: before.planVersion, tasks });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.problems).toContain('QC, batch 1 starts before Factory run, batch 1 ends');
    expect((await getWs()).planVersion).toBe(before.planVersion);
  });

  it('rejects a stale plan version with 409', async () => {
    const before = await getWs();
    const tasks = reschedule(before.plan.tasks, before.plan.dependencies, { 4: 8 });
    expect((await save({ planVersion: before.planVersion, tasks })).status).toBe(200);
    const again = reschedule(before.plan.tasks, before.plan.dependencies, { 4: 9 });
    expect((await save({ planVersion: before.planVersion, tasks: again })).status).toBe(409);
  });

  it('rejects missing, extra, or malformed tasks', async () => {
    const before = await getWs();
    const tasks = reschedule(before.plan.tasks, before.plan.dependencies, {});
    expect((await save({ planVersion: before.planVersion, tasks: tasks.slice(1) })).status).toBe(422);
    expect((await save({ planVersion: before.planVersion, tasks: [...tasks, { ...tasks[0], id: 99 }] })).status).toBe(422);
    expect((await save({ planVersion: before.planVersion, tasks: tasks.map((t, i) => (i ? t : { ...t, startDate: 'soon' })) })).status).toBe(422);
    expect((await save({ planVersion: before.planVersion, tasks: tasks.map((t, i) => (i ? t : { ...t, duration: -1 })) })).status).toBe(422);
    expect((await save({ planVersion: before.planVersion, tasks: tasks.map((t, i) => (i ? t : { ...t, constraintType: 'evil', constraintDate: '2026-11-09' })) })).status).toBe(422);
    expect((await save({ tasks })).status).toBe(422);
  });

  it('ignores client attempts to rename tasks or change batches', async () => {
    const before = await getWs();
    const tasks = reschedule(before.plan.tasks, before.plan.dependencies, { 4: 8 }).map((t) => ({ ...t, name: 'x', batchNumber: 9, kind: 'work' }));
    expect((await save({ planVersion: before.planVersion, tasks })).status).toBe(200);
    const after = await getWs();
    expect(after.plan.tasks.find((t: PlanTask) => t.id === 5)).toMatchObject({ name: 'Ship batch 1', kind: 'ship_batch', batchNumber: 1 });
  });

  it('persists constraints so a dragged task keeps its date', async () => {
    const before = await getWs();
    const tasks = reschedule(before.plan.tasks, before.plan.dependencies, {}, { 2: '2026-11-16' });
    expect((await save({ planVersion: before.planVersion, tasks })).status).toBe(200);
    expect((await getWs()).plan.tasks.find((t: PlanTask) => t.id === 2)).toMatchObject({
      startDate: '2026-11-16', constraintType: 'startnoearlierthan', constraintDate: '2026-11-16',
    });
  });

  it('runs the charge engine after a save that moves a batch into the window (AC-2.3)', async () => {
    const id = randomId();
    db.prepare(
      `INSERT INTO reservation (id, workspace_id, batch_number, state, buyer_email, vault_id, public_token, created_at)
       VALUES (?, ?, 1, 'RESERVED', 'b@example.com', 'VAULT-SECRET-1', ?, ?)`,
    ).run(id, ws, randomId(), NOW.toISOString());
    const before = await getWs();
    expect(before.batches[0].inWindow).toBe(false);
    const tasks = reschedule(before.plan.tasks, before.plan.dependencies, { 4: 2 }); // freight 5 days faster: ships Nov 27
    const res = await save({ planVersion: before.planVersion, tasks });
    const text = await res.text();
    const after = JSON.parse(text);
    expect(after.batches[0]).toMatchObject({ shipDate: '2026-11-27', daysToShip: 19, inWindow: true });
    expect(after.engine.charged).toBe(1);
    expect(after.reservations[0].state).toBe('CHARGED');
    expect(after.charges[0]).toMatchObject({ outcome: 'COMPLETED', orderId: `O-bd-${id}-1`, captureId: `C-bd-${id}-1`, paypalDebugId: 'dbg' });
    expect(text).not.toContain('VAULT-SECRET');
  });
});
