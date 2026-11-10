import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { BryntumGantt } from '@bryntum/gantt-react-community';
import type { PlanDependency, PlanTask, ProposedChange, TaskScheduleInput } from '../shared/types';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 20;

/** Buyer counts per batch, from the server. Dates come from Bryntum's live schedule. */
export interface BatchBuyers {
  number: number;
  charged: number;
  waiting: number;
  atRisk: number;
}

type ShipState = 'waiting' | 'open' | 'charged' | 'at-risk' | 'empty';

const STATE_LABEL: Record<ShipState, string> = {
  waiting: 'Outside the 20-day window',
  open: 'Inside the window: charging now',
  charged: 'Inside the window: charged',
  'at-risk': 'Charged buyers now at risk',
  empty: 'No reservations yet',
};

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Column format: "Dec 1". The tooltip carries the full date. */
function dayMonth(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates, matching the server's UTC date rule. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Bryntum loads 'YYYY-MM-DD' as local midnight, so format back in local time. */
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Props {
  tasks: PlanTask[];
  dependencies: PlanDependency[];
  buyers: BatchBuyers[];
  /** Bump to discard local edits and reload the given plan. */
  loadKey: number;
  onScheduleChange: (tasks: TaskScheduleInput[]) => void;
}

export interface PlanGanttHandle {
  /** Applies proposals to the chart; Bryntum reschedules successors and the normal save follows. */
  apply(changes: ProposedChange[]): Promise<void>;
}

function localDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The production plan. Bryntum's engine reschedules successors when a task moves;
 * once it settles, the full schedule is handed to onScheduleChange for the server to validate.
 */
export const PlanGantt = forwardRef<PlanGanttHandle, Props>(function PlanGantt(
  { tasks, dependencies, buyers, loadKey, onScheduleChange },
  handle,
) {
  const ref = useRef<BryntumGantt>(null);

  // Ship milestones and their batch, from the server-owned plan structure.
  const shipBatch = useRef(new Map<number, number>());
  shipBatch.current = new Map(tasks.filter((t) => t.kind === 'ship_batch').map((t) => [t.id, t.batchNumber!]));
  const buyersRef = useRef(buyers);
  buyersRef.current = buyers;

  /** Window state of a ship milestone, read from Bryntum's current dates for that task. */
  function shipInfo(record: any) {
    const batch = shipBatch.current.get(record.id);
    if (batch === undefined || !record.startDate) return null;
    const ship: Date = record.startDate;
    const shipIso = localIso(ship);
    const days = daysBetween(todayUtc(), shipIso);
    const opens = new Date(ship.getFullYear(), ship.getMonth(), ship.getDate() - WINDOW_DAYS);
    const b = buyersRef.current.find((x) => x.number === batch) ?? { number: batch, charged: 0, waiting: 0, atRisk: 0 };
    const inWindow = days <= WINDOW_DAYS;
    const state: ShipState = b.atRisk > 0 ? 'at-risk'
      : !inWindow ? (b.charged + b.waiting > 0 ? 'waiting' : 'empty')
      : b.waiting > 0 ? 'open' : b.charged > 0 ? 'charged' : 'empty';
    return { batch, ship, days, opens, inWindow, buyers: b, state };
  }

  function buyersText(b: BatchBuyers): string {
    const parts = [b.charged && `${b.charged} charged`, b.atRisk && `${b.atRisk} at risk`, b.waiting && `${b.waiting} waiting`].filter(Boolean);
    return parts.length ? parts.join(', ') : 'No buyers yet';
  }

  // Buyer counts change after saves and charges; redraw rows and bars without reloading the plan.
  useEffect(() => {
    const gantt: any = ref.current?.instance;
    gantt?.refreshRows?.();
  }, [buyers]);

  useImperativeHandle(handle, () => ({
    async apply(changes) {
      const gantt = ref.current?.instance;
      if (!gantt) throw new Error('The plan is not loaded yet.');
      for (const c of changes) {
        const task: any = gantt.taskStore.getById(c.taskId);
        if (!task) continue;
        const fields: Record<string, unknown> = {};
        if (c.after.startDate !== c.before.startDate) {
          // Same constraint Bryntum sets when a task is dragged, so the date survives rescheduling and reload.
          Object.assign(fields, { constraintType: 'startnoearlierthan', constraintDate: localDate(c.after.startDate) });
        }
        if (c.after.duration !== c.before.duration) Object.assign(fields, { duration: c.after.duration, durationUnit: 'day' });
        task.set(fields);
      }
      const project: any = gantt.project;
      if (typeof project.commitAsync === 'function') await project.commitAsync();
    },
  }));
  const onChange = useRef(onScheduleChange);
  onChange.current = onScheduleChange;

  // Rebuilt only when loadKey changes, so saving does not reset the chart.
  const project = useMemo(
    () => ({
      startDate: tasks.map((t) => t.startDate).sort()[0],
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        startDate: t.startDate,
        duration: t.duration,
        durationUnit: 'day',
        ...(t.constraintType ? { constraintType: t.constraintType, constraintDate: t.constraintDate } : {}),
      })),
      dependencies: dependencies.map((d) => ({ id: d.id, from: d.fromTask, to: d.toTask })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadKey],
  );

  // Created once: the Bryntum React wrapper reapplies any prop whose identity changes, and a new
  // subGridConfigs object on re-render rebuilds the grid. Renderers read live data through refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ganttConfig = useMemo(() => ({
    columns: [
        { type: 'name', width: 205, editor: false },
        { type: 'startdate', width: 95, format: 'MMM D' },
        { type: 'duration', width: 100 },
        {
          text: 'Ships',
          field: 'shipColumn',
          width: 95,
          editor: false,
          sortable: false,
          renderer: ({ record }: { record: any }) => {
            const info = shipInfo(record);
            return info ? dayMonth(info.ship) : '';
          },
        },
        {
          text: 'Charge opens',
          field: 'chargingColumn',
          width: 130,
          editor: false,
          sortable: false,
          renderer: ({ record, cellElement }: { record: any; cellElement: HTMLElement }) => {
            const info = shipInfo(record);
            cellElement.classList.toggle('bd-open', Boolean(info?.inWindow));
            if (!info) return '';
            return info.inWindow ? 'Open now' : dayMonth(info.opens);
          },
        },
        {
          text: 'Buyers',
          field: 'buyersColumn',
          width: 135,
          editor: false,
          sortable: false,
          renderer: ({ record }: { record: any }) => {
            const info = shipInfo(record);
            return info ? buyersText(info.buyers) : '';
          },
        },
    ],
    taskRenderer: ({ taskRecord, renderData }: { taskRecord: any; renderData: any }) => {
        const info = shipInfo(taskRecord);
        if (!info) return '';
        const cls = `bd-ship bd-ship-${info.state}`;
        if (typeof renderData.cls === 'string') renderData.cls += ` ${cls}`;
        else for (const c of cls.split(' ')) renderData.cls[c] = 1;
        // The 20-day charge window, drawn on the timeline as a band ending at the ship milestone.
        // Community edition has no time ranges feature, so the band hangs off the milestone itself.
        const gantt: any = ref.current?.instance;
        if (!gantt?.getCoordinateFromDate) return '';
        const width = gantt.getCoordinateFromDate(info.ship) - gantt.getCoordinateFromDate(info.opens);
        if (!(width > 0)) return '';
        return {
          tag: 'div',
          className: `bd-window bd-window-${info.inWindow ? 'open' : 'closed'}`,
          style: { width: `${width}px` },
          dataset: { layoutIgnore: 'true' },
          children: [{ tag: 'span', className: 'bd-window-label', text: info.inWindow ? 'Charging open' : `Charging opens ${dayMonth(info.opens)}` }],
        };
      },
    taskTooltipFeature: {
        template: ({ taskRecord }: { taskRecord: any }) => {
          const info = shipInfo(taskRecord);
          const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
          if (!info) {
            return `<div class="bd-tip"><strong>${esc(taskRecord.name)}</strong><br>${shortDate(taskRecord.startDate)} to ${shortDate(taskRecord.endDate)}</div>`;
          }
          return `<div class="bd-tip"><strong>${esc(taskRecord.name)}</strong>
            <div>Ships ${shortDate(info.ship)}, ${info.days} days from today</div>
            <div>Charging ${info.inWindow ? 'is open' : `opens ${shortDate(info.opens)}`}</div>
            <div>${buyersText(info.buyers)}</div>
            <div class="bd-tip-state">${STATE_LABEL[info.state]}</div>
            <div class="bd-tip-rule">Buyers are charged only once their batch is ${WINDOW_DAYS} days or less from shipping.</div></div>`;
        },
    },
    subGridConfigs: { locked: { width: 760 } },
    taskMenuFeature: false,
    cellMenuFeature: false,
    dependenciesFeature: { allowCreate: false },
  }), []);

  useEffect(() => {
    const gantt = ref.current?.instance;
    if (!gantt) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detach = gantt.project.on({
      dataReady: ({ isInitialCommit }: { isInitialCommit: boolean }) => {
        if (isInitialCommit) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const schedule: TaskScheduleInput[] = [];
          gantt.taskStore.traverse((t: any) => {
            if (t.isRoot) return;
            schedule.push({
              id: t.id,
              startDate: localIso(t.startDate),
              duration: Math.round((t.endDate.getTime() - t.startDate.getTime()) / DAY_MS),
              constraintType: t.constraintType || null,
              constraintDate: t.constraintType && t.constraintDate ? localIso(t.constraintDate) : null,
            });
          });
          onChange.current(schedule);
        }, 250);
      },
    });
    return () => {
      clearTimeout(timer);
      if (typeof detach === 'function') detach();
    };
  }, [project]);

  return (
    <BryntumGantt
      ref={ref}
      project={project}
      {...ganttConfig}
    />
  );
});
