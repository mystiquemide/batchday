import { useEffect, useState } from 'react';
import { api, formatDate, type PublicCampaign } from './api';

export function Reserve({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<PublicCampaign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getCampaign(workspaceId).then(setData, (err) => setError(err.message));
  }, [workspaceId]);

  async function reserve() {
    setBusy(true);
    setError(null);
    try {
      const { approveUrl } = await api.reserve(workspaceId);
      window.location.assign(approveUrl);
    } catch (err) {
      const debugId = (err as { debugId?: string | null }).debugId;
      setError(`${(err as Error).message}${debugId ? ` PayPal debug ID ${debugId}.` : ''}`);
      setBusy(false);
    }
  }

  if (error && !data) return <main className="page narrow"><p role="alert" className="error">{error}</p></main>;
  if (!data) return <main className="page narrow"><p role="status">Loading...</p></main>;

  const b = data.nextBatch;
  return (
    <main className="page narrow">
      <h1>{data.campaign.productName}</h1>
      <p className="price">${data.campaign.unitPrice} {data.campaign.currency}</p>
      {data.soldOut || !b ? (
        <p className="notice" role="status">Sold out. Every production batch is full.</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Your batch</dt><dd>Batch {b.number}</dd>
            <dt>Planned ship date</dt><dd>{formatDate(b.shipDate)}</dd>
            <dt>Earliest charge date</dt><dd>{b.inWindow ? 'As soon as you reserve' : formatDate(b.windowOpenDate)}</dd>
          </dl>
          <p className="rule">
            You will be charged when your batch is within {data.windowDays} days of shipping. Nothing is charged today.
            If the production plan changes, your charge date moves with it. You can cancel any time before you are charged.
          </p>
          {error && <p role="alert" className="error">{error}</p>}
          <button className="primary" onClick={reserve} disabled={busy}>
            {busy ? 'Opening PayPal...' : 'Reserve with PayPal'}
          </button>
        </>
      )}
    </main>
  );
}
