import { useState } from 'react';
import type { ProposedChange } from '../shared/types';
import { ApiFailure, api, formatDate, type UpdateWithImpact } from './api';

interface Props {
  updates: UpdateWithImpact[];
  onApply: (update: UpdateWithImpact) => Promise<void>;
  onChanged: () => Promise<void>;
}

const STATE_LABEL: Record<UpdateWithImpact['state'], string> = {
  RECEIVED: 'Reading',
  PROPOSED: 'Proposed',
  APPLIED: 'Applied',
  DISCARDED: 'Discarded',
  REJECTED_INVALID: 'No change',
};

function change(c: ProposedChange): string {
  const end = (s: { startDate: string; duration: number }) => {
    const d = new Date(`${s.startDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + s.duration);
    return d.toISOString().slice(0, 10);
  };
  return `${formatDate(c.before.startDate)} to ${formatDate(end(c.before))} becomes ${formatDate(c.after.startDate)} to ${formatDate(end(c.after))}`;
}

export function SupplierInbox({ updates, onApply, onChanged }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const current = updates[0];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.submitUpdate(text);
      setText('');
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Could not read the message.');
    } finally {
      setBusy(false);
    }
  }

  async function act(u: UpdateWithImpact, action: 'apply' | 'discard') {
    setActing(u.id);
    setError(null);
    try {
      if (action === 'apply') await onApply(u);
      else {
        await api.discardUpdate(u.id);
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="panel">
      <h2>Supplier updates</h2>
      <form onSubmit={submit}>
        <label htmlFor="supplier-text">Paste a message from your factory, QC, or freight partner</label>
        <textarea
          id="supplier-text"
          rows={4}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. QC on the first batch wrapped up early, freight leaves 4 days sooner than planned."
        />
        <div className="row">
          <button className="primary" type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Reading with AI...' : 'Read with AI'}
          </button>
          <span className="muted small">AI only proposes changes. Nothing moves until you apply it.</span>
        </div>
      </form>
      {error && <p role="alert" className="error">{error}</p>}

      {current && (
        <article className="update" aria-label="Latest supplier update">
          <header className="row">
            <span className={`badge u-${current.state.toLowerCase()}`}>{STATE_LABEL[current.state]}</span>
            <span className="muted small">{new Date(current.createdAt).toLocaleString()}{current.modelId ? ` · ${current.modelId}` : ''}</span>
          </header>
          <blockquote className="raw">{current.rawText}</blockquote>
          {current.error && <p className="notice">{current.error}</p>}
          {current.noChangeReason && <p className="notice">{current.noChangeReason}</p>}

          {current.proposals.length > 0 && (
            <>
              <h3>Proposed changes</h3>
              <ul className="proposals">
                {current.proposals.map((p) => (
                  <li key={p.taskId}>
                    <strong>{p.summary}</strong>
                    <div className="small">{change(p)}</div>
                    <q className="quote">{p.quote}</q>
                  </li>
                ))}
              </ul>
            </>
          )}
          {current.dropped.length > 0 && (
            <>
              <h3>Ignored</h3>
              <ul className="dropped">
                {current.dropped.map((d, i) => (
                  <li key={i}><span className="muted">{d.reason}.</span> {d.quote && <q className="quote">{d.quote}</q>}</li>
                ))}
              </ul>
            </>
          )}
          {current.state === 'PROPOSED' && current.impact && (
            <>
              <h3>If applied</h3>
              <table>
                <thead><tr><th>Batch</th><th>Ships now</th><th>Ships after</th><th>Charging</th></tr></thead>
                <tbody>
                  {current.impact.map((b) => (
                    <tr key={b.number} className={b.shipAfter !== b.shipBefore ? 'changed' : ''}>
                      <td>{b.number}</td>
                      <td>{formatDate(b.shipBefore)}</td>
                      <td>{formatDate(b.shipAfter)}</td>
                      <td>
                        {!b.inWindowBefore && b.inWindowAfter
                          ? `Opens now: ${b.reserved} reservation${b.reserved === 1 ? '' : 's'} will be charged`
                          : b.inWindowAfter
                            ? 'Inside 20 days'
                            : `Opens ${formatDate(b.windowOpenAfter)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row">
                <button className="primary" onClick={() => act(current, 'apply')} disabled={acting !== null}>
                  {acting === current.id ? 'Applying...' : 'Apply to plan'}
                </button>
                <button onClick={() => act(current, 'discard')} disabled={acting !== null}>Discard</button>
              </div>
            </>
          )}
        </article>
      )}

      {updates.length > 1 && (
        <details>
          <summary>Earlier updates ({updates.length - 1})</summary>
          <ul className="history">
            {updates.slice(1).map((u) => (
              <li key={u.id}>
                <span className={`badge u-${u.state.toLowerCase()}`}>{STATE_LABEL[u.state]}</span> {u.rawText.slice(0, 90)}{u.rawText.length > 90 ? '...' : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
