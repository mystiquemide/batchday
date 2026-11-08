import { useEffect, useRef, useState } from 'react';
import type { TaskScheduleInput } from '../shared/types';
import { ApiFailure, api, formatDate, type EngineSummary, type UpdateWithImpact, type WorkspaceData } from './api';
import { ChargeLog } from './ChargeLog';
import { PlanGantt, type PlanGanttHandle } from './PlanGantt';
import { SupplierInbox } from './SupplierInbox';
import { Notices } from './Notices';
import { StateBadge } from './StateBadge';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; engine: EngineSummary | undefined }
  | { kind: 'rejected'; message: string; problems: string[] };

function engineText(e: EngineSummary | undefined): string {
  if (!e) return 'Plan saved.';
  const parts = [
    e.charged && `${e.charged} charged`,
    e.failed && `${e.failed} failed`,
    e.revoked && `${e.revoked} revoked at PayPal`,
    e.unknown && `${e.unknown} awaiting PayPal`,
    e.outsideWindow && `${e.outsideWindow} outside the 20-day window`,
    e.atRisk && `${e.atRisk} charged buyer${e.atRisk === 1 ? ' is' : 's are'} now at risk`,
    e.recovered && `${e.recovered} back within the promise`,
  ].filter(Boolean);
  return `Plan saved. ${parts.length ? parts.join(', ') + '.' : 'No reservations to charge.'}`;
}

export function Console() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [status, setStatus] = useState<'loading' | 'none' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [refunding, setRefunding] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);

  async function refund(reservationId: string) {
    setRefunding(reservationId);
    setRefundError(null);
    try {
      const next = await api.refund(reservationId);
      version.current = next.planVersion;
      setData(next);
    } catch (err) {
      const f = err instanceof ApiFailure ? err : null;
      setRefundError(`${f?.message ?? 'Refund failed.'}${f?.debugId ? ` PayPal debug ID ${f.debugId}.` : ''}`);
    } finally {
      setRefunding(null);
    }
  }
  const version = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const gantt = useRef<PlanGanttHandle>(null);
  /** Supplier update being applied; marked APPLIED only once its plan save is accepted. */
  const applying = useRef<{ id: string; settle: (ok: boolean, message?: string) => void } | null>(null);

  async function load() {
    try {
      const next = await api.getWorkspace();
      version.current = next.planVersion;
      setData(next);
      setLoadKey((k) => k + 1);
      setStatus('ready');
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 404) setStatus('none');
      else {
        setError(err instanceof Error ? err.message : 'Could not load workspace.');
        setStatus('error');
      }
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function start() {
    setStatus('loading');
    try {
      await api.startWorkspace();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a workspace.');
      setStatus('error');
    }
  }

  async function refresh() {
    try {
      const next = await api.getWorkspace();
      version.current = next.planVersion;
      setData(next);
    } catch {
      /* keep the current view; the next save or refresh will retry */
    }
  }

  // Saves run one at a time so each carries the version returned by the previous one.
  function saveSchedule(tasks: TaskScheduleInput[]) {
    queue.current = queue.current.then(async () => {
      setSave({ kind: 'saving' });
      try {
        const next = await api.savePlan(version.current, tasks);
        version.current = next.planVersion;
        setData(next);
        setSave({ kind: 'saved', engine: next.engine });
        applying.current?.settle(true);
      } catch (err) {
        const f = err instanceof ApiFailure ? err : null;
        setSave({ kind: 'rejected', message: f?.message ?? 'Could not save the plan.', problems: f?.problems ?? [] });
        applying.current?.settle(false, f?.message);
        await load(); // put the chart back on the last accepted plan
      }
    });
  }

  // AC-4.3: a supplier proposal goes through Bryntum and the same save and charge path as a manual edit.
  async function applyUpdate(u: UpdateWithImpact) {
    if (!gantt.current) throw new Error('The plan is not loaded yet.');
    const saved = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        applying.current = null;
        reject(new Error('The plan did not change, so nothing was applied.'));
      }, 15_000);
      applying.current = {
        id: u.id,
        settle: (ok, message) => {
          clearTimeout(timer);
          applying.current = null;
          if (ok) resolve();
          else reject(new Error(message ?? 'The plan change was rejected.'));
        },
      };
    });
    await gantt.current.apply(u.proposals);
    await saved;
    await api.applyUpdate(u.id);
    await refresh();
  }

  if (status === 'loading') return <main className="page"><p role="status">Loading workspace...</p></main>;
  if (status === 'error') return <main className="page"><p role="alert" className="error">{error}</p></main>;
  if (status === 'none' || !data) {
    return (
      <main className="page narrow">
        <h1>Batchday</h1>
        <p>Take pre-order reservations with PayPal today. Each buyer is charged only when their production batch is within 20 days of shipping, driven by your live production plan.</p>
        <button className="primary" onClick={start}>Start a workspace</button>
      </main>
    );
  }

  const link = `${window.location.origin}/r/${data.campaign.workspaceId}`;
  const buyersByBatch = data.batches.map((b) => {
    const rs = data.reservations.filter((r) => r.batchNumber === b.number);
    return {
      number: b.number,
      charged: rs.filter((r) => r.state === 'CHARGED').length,
      waiting: rs.filter((r) => r.state === 'RESERVED' || r.state === 'CHARGING' || r.state === 'CHARGE_FAILED').length,
      atRisk: rs.filter((r) => r.state === 'AT_RISK').length,
    };
  });
  return (
    <main className="console">
      <header className="bar">
        <div>
          <h1>{data.campaign.productName}</h1>
          <p className="muted">
            ${data.campaign.unitPrice} {data.campaign.currency} per unit
            {data.campaign.isTemplate && <span className="tag">Template plan, edit to match your production</span>}
          </p>
        </div>
        <div className="link">
          <label htmlFor="reserve-link">Buyer reservation link</label>
          <div className="row">
            <input id="reserve-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </header>

      <div className="savebar" aria-live="polite">
        {save.kind === 'idle' && <span className="muted">Drag or edit tasks. Downstream tasks reschedule, then the plan saves and the charge engine runs.</span>}
        {save.kind === 'saving' && <span>Saving plan and running the charge engine...</span>}
        {save.kind === 'saved' && <span className="ok">{engineText(save.engine)}</span>}
        {save.kind === 'rejected' && (
          <span role="alert" className="error">
            {save.message} {save.problems.join('. ')}. The last saved plan was restored.
          </span>
        )}
      </div>

      <div className="legend" aria-label="Ship milestone colors">
        <span><i className="sw sw-waiting" /> Outside 20-day window</span>
        <span><i className="sw sw-open" /> Inside window, charging</span>
        <span><i className="sw sw-charged" /> Charged</span>
        <span><i className="sw sw-at-risk" /> Charged, now at risk</span>
        <span><i className="sw sw-empty" /> No buyers</span>
      </div>

      <section className="gantt" aria-label="Production plan">
        <PlanGantt ref={gantt} buyers={buyersByBatch} tasks={data.plan.tasks} dependencies={data.plan.dependencies} loadKey={loadKey} onScheduleChange={saveSchedule} />
      </section>

      <section className="panels">
        <div className="panel">
          <h2>Batches</h2>
          <table>
            <thead>
              <tr><th>Batch</th><th>Ships</th><th>Charging opens</th><th>Reserved</th><th>Window</th></tr>
            </thead>
            <tbody>
              {data.batches.map((b) => (
                <tr key={b.number}>
                  <td>{b.number}</td>
                  <td>{formatDate(b.shipDate)}</td>
                  <td>{formatDate(b.windowOpenDate)}</td>
                  <td>{b.reserved} of {b.capacity}</td>
                  <td>{b.inWindow ? 'Inside 20 days' : `${b.daysToShip} days out`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>Reservations</h2>
          {data.reservations.length === 0 ? (
            <p className="muted">No reservations yet. Share the buyer link above.</p>
          ) : (
            <table>
              <thead><tr><th>Buyer</th><th>Batch</th><th>State</th><th>Reserved</th><th>Charged</th></tr></thead>
              <tbody>
                {data.reservations.map((r, i) => (
                  <tr key={i}>
                    <td>{r.buyerName ?? r.buyerEmail ?? 'Unknown buyer'}<div className="muted small">{r.buyerEmail}</div></td>
                    <td>{r.batchNumber ?? '-'}</td>
                    <td><StateBadge state={r.state} /></td>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>
                      {r.chargedAt ? new Date(r.chargedAt).toLocaleString() : r.refusal ? `Opens ${formatDate(r.refusal.windowOpenDate)}` : '-'}
                      {r.refusal && <div className="muted small">{r.refusal.reason}</div>}
                      {r.message && <div className={r.state === 'AT_RISK' ? 'error small' : 'muted small'}>{r.message}</div>}
                      {r.refundId && <div className="muted small mono">Refund {r.refundId}</div>}
                      {r.canRefund && r.id && (
                        <button
                          className={r.state === 'AT_RISK' ? 'danger small-btn' : 'small-btn'}
                          onClick={() => refund(r.id!)}
                          disabled={refunding !== null}
                        >
                          {refunding === r.id ? 'Refunding...' : 'Refund'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {refundError && <p role="alert" className="error">{refundError}</p>}
          <button className="secondary" onClick={refresh}>Refresh</button>
        </div>
      </section>

      <section className="panels single">
        <SupplierInbox updates={data.updates} onApply={applyUpdate} onChanged={refresh} />
      </section>

      <section className="panels single">
        <Notices />
      </section>

      <section className="panels single">
        <ChargeLog rows={data.charges} />
      </section>
    </main>
  );
}
