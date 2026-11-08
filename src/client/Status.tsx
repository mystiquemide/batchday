import { useEffect, useState } from 'react';
import { api, formatDate, type PublicReservation } from './api';
import { StateBadge } from './StateBadge';

export function Status({ publicToken }: { publicToken: string }) {
  const [data, setData] = useState<PublicReservation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      setData(await api.cancel(publicToken));
      setConfirming(false);
    } catch (err) {
      setCancelError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }

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
      {r.refusal && (
        <p className="rule">
          Not charged yet. {r.refusal.reason} Keep this page link to check your status.
        </p>
      )}
      {r.state === 'RESERVED' && !r.refusal && (
        <p className="rule">Your batch is within {data.windowDays} days of shipping. Your charge will be processed shortly.</p>
      )}
      {r.canCancel && (
        <div className="cancel">
          {cancelError && <p role="alert" className="error">{cancelError}</p>}
          {!confirming ? (
            <button onClick={() => setConfirming(true)}>Cancel reservation</button>
          ) : (
            <>
              <p>Cancel this reservation? Your saved PayPal wallet will be removed and you will not be charged.</p>
              <div className="row">
                <button className="danger" onClick={cancel} disabled={cancelling}>
                  {cancelling ? 'Cancelling...' : 'Yes, cancel'}
                </button>
                <button onClick={() => setConfirming(false)} disabled={cancelling}>Keep reservation</button>
              </div>
            </>
          )}
        </div>
      )}
    </main>
  );
}
