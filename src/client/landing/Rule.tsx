import { CalendarClock, ClipboardList, ShieldAlert } from 'lucide-react';

const FACTS = [
  {
    icon: CalendarClock,
    title: 'Factories slip',
    body: 'A late QC pass or a missed vessel moves the ship date. Pre-order sellers deal with this every week.',
  },
  {
    icon: ShieldAlert,
    title: 'Charge too early',
    body: 'Take payment months ahead and PayPal can hold the money. Leder Games and Portal Games both had pre-order funds frozen, one until six months after shipping.',
  },
  {
    icon: ClipboardList,
    title: 'Charge by hand',
    body: 'Track ship dates in a spreadsheet and you end up charging late, or charging buyers whose batch already slipped.',
  },
];

export function Rule() {
  return (
    <section id="rule" className="lp-section lp-bg-white" aria-labelledby="lp-rule-title">
      <div className="lp-container">
        <div className="lp-section-head">
          <p className="lp-label">The 20-day rule</p>
          <h2 id="lp-rule-title" className="lp-h2">
            PayPal allows pre{'\u2011'}sales only when you ship within 20 days of payment
          </h2>
        </div>

        <ul className="lp-facts">
          {FACTS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="lp-fact">
              <Icon size={18} strokeWidth={1.5} aria-hidden="true" className="lp-icon" />
              <h3 className="lp-h3">{title}</h3>
              <p className="lp-body">{body}</p>
            </li>
          ))}
        </ul>

        <p className="lp-source">
          Sources: PayPal pre-sale guidance (help article FAQ1488) and{' '}
          <a href="https://stonemaiergames.com/the-danger-of-accepting-pre-orders-via-paypal/" target="_blank" rel="noreferrer">
            Stonemaier Games, 2017
          </a>
        </p>
      </div>
    </section>
  );
}
