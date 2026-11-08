import { useEffect, useState } from 'react';
import { api, formatDate, type PublicReservation } from './api';
import { StateBadge } from './StateBadge';

export function Status({ publicToken }: { publicToken: string }) {
  const [data, setData] = useState<PublicReservation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getReservation(publicToken).then(setData, (err) => setError(err.message));
  }, [publicToken]);

  if (error) return <main className="page narrow"><p role="alert" className="error">{error}</p></main>;
  if (!data) return <main className="page narrow"><p role="status">Loading...</p></main>;

  const { reservation: r, batch: b } = data;
  return (
    <main className="page narrow">
      <h1>{data.campaign.productName}</h1>
      <p><StateBadge state={r.state} /></p>
      {r.message && <p className="notice" role="status">{r.message}</p>}
      {b && (
        <dl className="facts">
          <dt>Batch</dt><dd>Batch {b.number}</dd>
          <dt>Planned ship date</dt><dd>{formatDate(b.shipDate)}</dd>
          {r.chargedAt ? (
            <><dt>Charged</dt><dd>{new Date(r.chargedAt).toLocaleDateString()}</dd></>
          ) : (
            <><dt>Expected charge date</dt><dd>{b.inWindow ? 'Charging is open for this batch' : formatDate(b.windowOpenDate)}</dd></>
          )}
          {r.captureId && <><dt>PayPal capture</dt><dd>{r.captureId}</dd></>}
          <dt>Price</dt><dd>${data.campaign.unitPrice} {data.campaign.currency}</dd>
        </dl>
      )}
      {r.state === 'RESERVED' && (
        <p className="rule">You will be charged when batch {b?.number} is within {data.windowDays} days of shipping. Keep this page link to check your status.</p>
      )}
    </main>
  );
}
