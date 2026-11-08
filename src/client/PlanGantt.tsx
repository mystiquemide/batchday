import { useEffect, useMemo, useRef } from 'react';
import { BryntumGantt } from '@bryntum/gantt-react-community';
import type { PlanDependency, PlanTask, TaskScheduleInput } from '../shared/types';

const DAY_MS = 86_400_000;

/** Bryntum loads 'YYYY-MM-DD' as local midnight, so format back in local time. */
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Props {
  tasks: PlanTask[];
  dependencies: PlanDependency[];
  /** Bump to discard local edits and reload the given plan. */
  loadKey: number;
  onScheduleChange: (tasks: TaskScheduleInput[]) => void;
}

/**
 * The production plan. Bryntum's engine reschedules successors when a task moves;
 * once it settles, the full schedule is handed to onScheduleChange for the server to validate.
 */
export function PlanGantt({ tasks, dependencies, loadKey, onScheduleChange }: Props) {
  const ref = useRef<BryntumGantt>(null);
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
      columns={[
        { type: 'name', width: 220, editor: false },
        { type: 'startdate', width: 130 },
        { type: 'duration', width: 90 },
      ]}
      taskMenuFeature={false}
      cellMenuFeature={false}
      dependenciesFeature={{ allowCreate: false }}
    />
  );
}
