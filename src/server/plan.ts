import { CONSTRAINT_TYPES, type ConstraintType, type TaskScheduleInput } from '../shared/types.js';
import type { Db } from './db.js';
import { addDays, daysBetween, isIsoDate, todayUtc } from './dates.js';
import { getPlan } from './store.js';

export class PlanRejected extends Error {
  constructor(message: string, readonly problems: string[], readonly status = 422) {
    super(message);
  }
}

const MAX_DURATION = 365;
const MAX_RANGE_DAYS = 730;

function parseTasks(input: unknown): TaskScheduleInput[] {
  if (!Array.isArray(input)) throw new PlanRejected('tasks must be an array', ['tasks must be an array']);
  return input.map((raw, i) => {
    const t = raw as Record<string, unknown>;
    const where = `task at index ${i}`;
    if (!Number.isInteger(t.id)) throw new PlanRejected('Invalid plan', [`${where} has no valid id`]);
    if (!isIsoDate(t.startDate)) throw new PlanRejected('Invalid plan', [`${where} has an invalid start date`]);
    if (!Number.isInteger(t.duration) || (t.duration as number) < 0 || (t.duration as number) > MAX_DURATION) {
      throw new PlanRejected('Invalid plan', [`${where} has an invalid duration`]);
    }
    const constraintType = t.constraintType ?? null;
    const constraintDate = t.constraintDate ?? null;
    if (constraintType !== null && !CONSTRAINT_TYPES.includes(constraintType as ConstraintType)) {
      throw new PlanRejected('Invalid plan', [`${where} has an unsupported constraint`]);
    }
    if ((constraintType === null) !== (constraintDate === null) || (constraintDate !== null && !isIsoDate(constraintDate))) {
      throw new PlanRejected('Invalid plan', [`${where} has an incomplete constraint`]);
    }
    return {
      id: t.id as number,
      startDate: t.startDate as string,
      duration: t.duration as number,
      constraintType: constraintType as ConstraintType | null,
      constraintDate: constraintDate as string | null,
    };
  });
}

/**
 * FR-004: validates a full schedule from the console against the stored plan and saves it.
 * Task names, kinds, batches and dependencies are server-owned; only dates, durations
 * and constraints are accepted from the client.
 */
export function savePlan(db: Db, workspaceId: string, body: unknown, now = new Date()): { planVersion: number; changed: number } {
  const { planVersion, tasks: rawTasks } = (body ?? {}) as { planVersion?: unknown; tasks?: unknown };
  if (!Number.isInteger(planVersion)) throw new PlanRejected('planVersion is required', ['planVersion is required']);
  const incoming = parseTasks(rawTasks);
  const stored = getPlan(db, workspaceId);
  const byId = new Map(stored.tasks.map((t) => [t.id, t]));

  const ids = new Set(incoming.map((t) => t.id));
  if (ids.size !== incoming.length || incoming.length !== stored.tasks.length || incoming.some((t) => !byId.has(t.id))) {
    throw new PlanRejected('The plan must contain exactly the existing tasks.', ['Task list does not match the stored plan']);
  }

  const today = todayUtc(now);
  const outOfRange = incoming
    .filter((t) => Math.abs(daysBetween(today, t.startDate)) > MAX_RANGE_DAYS)
    .map((t) => `${byId.get(t.id)!.name} starts more than ${MAX_RANGE_DAYS} days from today`);
  if (outOfRange.length) throw new PlanRejected('Dates are out of range.', outOfRange);

  const next = new Map(incoming.map((t) => [t.id, t]));
  const violations: string[] = [];
  for (const d of stored.dependencies) {
    const from = next.get(d.fromTask)!;
    const to = next.get(d.toTask)!;
    const fromEnd = addDays(from.startDate, from.duration);
    if (daysBetween(fromEnd, to.startDate) < 0) {
      violations.push(`${byId.get(d.toTask)!.name} starts before ${byId.get(d.fromTask)!.name} ends`);
    }
  }
  if (violations.length) throw new PlanRejected('A task starts before the task it depends on ends.', violations);

  return db.transaction(() => {
    const ws = db.prepare('SELECT plan_version FROM workspace WHERE id = ?').get(workspaceId) as { plan_version: number };
    if (ws.plan_version !== planVersion) {
      throw new PlanRejected('The plan changed in another window. Reload to see the latest plan.', ['Stale plan version'], 409);
    }
    const update = db.prepare(
      `UPDATE task SET start_date = ?, duration = ?, constraint_type = ?, constraint_date = ?
        WHERE workspace_id = ? AND id = ?
          AND (start_date != ? OR duration != ? OR constraint_type IS NOT ? OR constraint_date IS NOT ?)`,
    );
    let changed = 0;
    for (const t of incoming) {
      changed += update.run(
        t.startDate, t.duration, t.constraintType, t.constraintDate, workspaceId, t.id,
        t.startDate, t.duration, t.constraintType, t.constraintDate,
      ).changes;
    }
    const version = changed ? planVersion + 1 : planVersion;
    if (changed) db.prepare('UPDATE workspace SET plan_version = ?, is_template = 0 WHERE id = ?').run(version, workspaceId);
    return { planVersion: version, changed };
  }).immediate();
}

export function getPlanVersion(db: Db, workspaceId: string): number {
  return (db.prepare('SELECT plan_version FROM workspace WHERE id = ?').get(workspaceId) as { plan_version: number }).plan_version;
}
