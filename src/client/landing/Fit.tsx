import { Check, X } from 'lucide-react';

const FOR = [
  'Board game publishers running reprints and second print runs',
  'Keyboard, merch, and hardware makers who sell restocks in batches',
  'Any seller who pays the factory up front and wants reservations without PayPal risk',
];

const NOT_FOR = [
  'Sellers who need pre-order cash to pay the factory. With Batchday the money arrives close to shipping.',
  'Deposits or escrow. Batchday never takes money before a batch is inside the 20-day window.',
  'Live PayPal today. Batchday runs in PayPal sandbox, and saving PayPal wallets in live mode needs PayPal approval for the merchant.',
];

export function Fit() {
  return (
    <section id="fit" className="lp-section lp-bg-white" aria-labelledby="lp-fit-title">
      <div className="lp-container">
        <div className="lp-section-head">
          <p className="lp-label">Who it&rsquo;s for</p>
          <h2 id="lp-fit-title" className="lp-h2">
            Made for sellers who can fund the batch
          </h2>
        </div>

        <div className="lp-fit">
          <div className="lp-fit-col">
            <h3 className="lp-fit-title">A good fit</h3>
            <ul className="lp-fit-list">
              {FOR.map((t) => (
                <li key={t}>
                  <Check size={18} strokeWidth={1.5} aria-hidden="true" className="lp-fit-yes" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="lp-fit-col">
            <h3 className="lp-fit-title">Not a fit</h3>
            <ul className="lp-fit-list">
              {NOT_FOR.map((t) => (
                <li key={t}>
                  <X size={18} strokeWidth={1.5} aria-hidden="true" className="lp-fit-no" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
