import { useEffect, useMemo, useState } from 'react';
import { BryntumGantt } from '@bryntum/gantt-react-community';
import { ApiFailure, api, formatDate, type WorkspaceData } from './api';
import { StateBadge } from './StateBadge';

export function Console() {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [status, setStatus] = useState<'loading' | 'none' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      setData(await api.getWorkspace());
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

  const project = useMemo(() => {
    if (!data) return null;
    return {
      startDate: data.plan.tasks.map((t) => t.startDate).sort()[0],
      tasks: data.plan.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        startDate: t.startDate,
        duration: t.duration,
        durationUnit: 'day',
      })),
      dependencies: data.plan.dependencies.map((d) => ({ id: d.id, from: d.fromTask, to: d.toTask })),
    };
  }, [data]);

  if (status === 'loading') return <main className="page"><p role="status">Loading workspace...</p></main>;
  if (status === 'error') return <main className="page"><p role="alert" className="error">{error}</p></main>;
  if (status === 'none' || !data || !project) {
    return (
      <main className="page narrow">
        <h1>Batchday</h1>
        <p>Take pre-order reservations with PayPal today. Each buyer is charged only when their production batch is within 20 days of shipping, driven by your live production plan.</p>
        <button className="primary" onClick={start}>Start a workspace</button>
      </main>
    );
  }

  const link = `${window.location.origin}/r/${data.campaign.workspaceId}`;
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

      <section className="gantt" aria-label="Production plan">
        <BryntumGantt
          project={project}
          readOnly
          columns={[
            { type: 'name', width: 220 },
            { type: 'startdate', width: 130 },
            { type: 'duration', width: 90 },
          ]}
        />
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
              <thead><tr><th>Buyer</th><th>Batch</th><th>State</th><th>Reserved</th></tr></thead>
              <tbody>
                {data.reservations.map((r, i) => (
                  <tr key={i}>
                    <td>{r.buyerName ?? r.buyerEmail ?? 'Unknown buyer'}<div className="muted small">{r.buyerEmail}</div></td>
                    <td>{r.batchNumber ?? '-'}</td>
                    <td><StateBadge state={r.state} /></td>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button className="secondary" onClick={load}>Refresh</button>
        </div>
      </section>
    </main>
  );
}
