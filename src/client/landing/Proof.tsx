const STATS = [
  { value: '0', text: 'PayPal calls for batches more than 20 days from shipping' },
  { value: '12 of 12', text: 'supplier messages handled as expected, including an injection attempt' },
  { value: '1', text: 'capture per buyer, confirmed by replaying a PayPal request' },
  { value: '90', text: 'automated tests across the engine, plan, AI, refunds, and webhooks' },
];

const IDS = [
  { what: 'Supplier update applied on the live app, batch 1 charged', id: 'order 0SE11503D52576713, capture 18V916529P0391335' },
  { what: 'Plan change charged a buyer, order fetched back as COMPLETED', id: 'order 0SJ11939BJ923791S' },
  { what: 'Charge on a wallet removed at PayPal', id: 'HTTP 403 PERMISSION_DENIED, debug f5999007f5cf4' },
  { what: 'At-risk buyer refunded from the console', id: 'refund 9SV7710612642500S, COMPLETED' },
];

export function Proof() {
  return (
    <section id="proof" className="lp-section lp-bg-band" aria-labelledby="lp-proof-title">
      <div className="lp-container">
        <div className="lp-section-head">
          <p className="lp-label">Proof</p>
          <h2 id="lp-proof-title" className="lp-h2">
            Real money movement, in sandbox.
          </h2>
        </div>

        <ul className="lp-stats">
          {STATS.map((s) => (
            <li key={s.value + s.text} className="lp-stat">
              <p className="lp-stat-value">{s.value}</p>
              <p className="lp-body">{s.text}</p>
            </li>
          ))}
        </ul>

        <div className="lp-ids">
          <h3 className="lp-ids-title">PayPal sandbox IDs</h3>
          <dl className="lp-ids-list">
            {IDS.map((row) => (
              <div key={row.id} className="lp-ids-row">
                <dt>{row.what}</dt>
                <dd className="lp-mono">{row.id}</dd>
              </div>
            ))}
          </dl>
          <p className="lp-source">
            These IDs belong to the PayPal sandbox merchant used to build Batchday. Open the app and run the loop to see
            your own in the charge log.
          </p>
        </div>
      </div>
    </section>
  );
}
