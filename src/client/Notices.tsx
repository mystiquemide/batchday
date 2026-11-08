import { useState } from 'react';
import type { NoticeDraft } from '../shared/types';
import { api } from './api';

export function Notices() {
  const [drafts, setDrafts] = useState<NoticeDraft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function draft() {
    setBusy(true);
    setError(null);
    try {
      setDrafts((await api.draftNotices()).drafts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function notified(batch: number) {
    try {
      await api.markNotified(batch);
      await draft();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="panel">
      <h2>Buyer notices</h2>
      <p className="muted small">Drafts for buyers whose ship date changed or whose charge is now at risk. Batchday never sends email; copy a draft into your own email tool.</p>
      <button onClick={draft} disabled={busy}>{busy ? 'Drafting...' : 'Draft buyer notices'}</button>
      {error && <p role="alert" className="error">{error}</p>}
      {drafts && drafts.length === 0 && <p className="muted">No buyers need a notice right now.</p>}
      {drafts?.map((d) => (
        <article className="draft" key={d.key} aria-label={`Notice for batch ${d.batchNumber}`}>
          <div className="row">
            <span className="tag draft-tag">Draft, not sent</span>
            <span className="muted small">
              Batch {d.batchNumber} · {d.kind === 'at_risk' ? 'Charged, now at risk' : 'Ship date changed'} · {d.recipients.length} recipient{d.recipients.length === 1 ? '' : 's'}
              {' · '}{d.source === 'ai' ? 'AI draft, fact-checked' : 'Template'}
            </span>
          </div>
          {d.sourceNote && <p className="muted small">{d.sourceNote}</p>}
          <p className="small"><strong>To:</strong> {d.recipients.join(', ') || 'No email on file'}</p>
          <p><strong>{d.subject}</strong></p>
          <pre>{d.body}</pre>
          <div className="row">
            <button onClick={() => navigator.clipboard.writeText(`${d.subject}\n\n${d.body}`)}>Copy</button>
            {d.kind === 'ship_date_changed' && <button onClick={() => notified(d.batchNumber)}>Mark batch {d.batchNumber} as notified</button>}
          </div>
        </article>
      ))}
    </div>
  );
}
