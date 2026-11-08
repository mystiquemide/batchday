import type { PlanDependency, PlanTask } from '../shared/types.js';
import { addDays } from './dates.js';

interface TemplateTask {
  id: number;
  name: string;
  duration: number;
  kind: PlanTask['kind'];
  batchNumber: number | null;
  after: number[];
}

/** Starting plan for a new workspace. Labeled as a template in the UI; the seller edits it. */
export const TEMPLATE = {
  productName: 'Tidewater board game, first print run',
  unitPrice: '49.00',
  batches: [
    { number: 1, capacity: 2 },
    { number: 2, capacity: 3 },
    { number: 3, capacity: 5 },
  ],
  tasks: [
    { id: 1, name: 'Source components', duration: 6, kind: 'work', batchNumber: null, after: [] },
    { id: 2, name: 'Factory run, batch 1', duration: 8, kind: 'work', batchNumber: 1, after: [1] },
    { id: 3, name: 'QC, batch 1', duration: 3, kind: 'work', batchNumber: 1, after: [2] },
    { id: 4, name: 'Freight, batch 1', duration: 7, kind: 'work', batchNumber: 1, after: [3] },
    { id: 5, name: 'Ship batch 1', duration: 0, kind: 'ship_batch', batchNumber: 1, after: [4] },
    { id: 6, name: 'Factory run, batch 2', duration: 10, kind: 'work', batchNumber: 2, after: [2] },
    { id: 7, name: 'QC, batch 2', duration: 3, kind: 'work', batchNumber: 2, after: [6] },
    { id: 8, name: 'Freight, batch 2', duration: 7, kind: 'work', batchNumber: 2, after: [7] },
    { id: 9, name: 'Ship batch 2', duration: 0, kind: 'ship_batch', batchNumber: 2, after: [8] },
    { id: 10, name: 'Factory run, batch 3', duration: 10, kind: 'work', batchNumber: 3, after: [6] },
    { id: 11, name: 'QC, batch 3', duration: 3, kind: 'work', batchNumber: 3, after: [10] },
    { id: 12, name: 'Freight, batch 3', duration: 7, kind: 'work', batchNumber: 3, after: [11] },
    { id: 13, name: 'Ship batch 3', duration: 0, kind: 'ship_batch', batchNumber: 3, after: [12] },
  ] satisfies TemplateTask[],
};

/** Lays out the template with finish-to-start scheduling from the start date. */
export function buildTemplatePlan(start: string): { tasks: PlanTask[]; dependencies: PlanDependency[] } {
  const ends = new Map<number, string>();
  const tasks: PlanTask[] = [];
  const dependencies: PlanDependency[] = [];
  for (const t of TEMPLATE.tasks) {
    const startDate = t.after.length
      ? t.after.map((id) => ends.get(id)!).sort().at(-1)!
      : start;
    ends.set(t.id, addDays(startDate, t.duration));
    tasks.push({ id: t.id, name: t.name, startDate, duration: t.duration, kind: t.kind, batchNumber: t.batchNumber });
    for (const from of t.after) dependencies.push({ id: dependencies.length + 1, fromTask: from, toTask: t.id });
  }
  return { tasks, dependencies };
}
