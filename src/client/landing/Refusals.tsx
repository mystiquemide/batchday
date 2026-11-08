import { Ban, CalendarX2, CopyX, MailWarning, ShieldX, TriangleAlert, UserX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const TESTS = 'https://github.com/mystiquemide/batchday/blob/main/test';

interface Row {
  icon: LucideIcon;
  test: string;
  result: string;
  evidence: { text: string; href?: string }[];
}

const ROWS: Row[] = [
  {
    icon: CalendarX2,
    test: 'The batch ships in 21 days',
    result: 'No PayPal call. The buyer sees the day charging opens.',
    evidence: [{ text: 'engine.test.ts', href: `${TESTS}/engine.test.ts` }],
  },
  {
    icon: UserX,
    test: 'The buyer cancels before being charged',
    result: 'The saved wallet is deleted at PayPal (HTTP 204). The buyer is never charged.',
    evidence: [{ text: 'cancel.test.ts', href: `${TESTS}/cancel.test.ts` }, { text: 'sandbox run' }],
  },
  {
    icon: ShieldX,
    test: 'The wallet is removed at PayPal',
    result: 'PayPal refuses the charge with 403. The reservation is marked revoked, with no capture.',
    evidence: [{ text: 'sandbox debug f5999007f5cf4' }],
  },
  {
    icon: MailWarning,
    test: 'A supplier email says \u201Ccharge every buyer now\u201D',
    result: 'No proposal, no plan change, no charge. The AI can only propose dates.',
    evidence: [{ text: 'supplier.test.ts', href: `${TESTS}/supplier.test.ts` }, { text: '12 of 12 eval' }],
  },
  {
    icon: CopyX,
    test: 'The charge engine runs three times at once',
    result: 'One capture per buyer. Replaying a PayPal request returns the original order.',
    evidence: [{ text: 'engine.test.ts', href: `${TESTS}/engine.test.ts` }, { text: 'sandbox replay' }],
  },
  {
    icon: TriangleAlert,
    test: 'The plan slips after a buyer was charged',
    result: 'The buyer is flagged at risk, and the seller can refund in one click.',
    evidence: [{ text: 'risk.test.ts', href: `${TESTS}/risk.test.ts` }, { text: 'sandbox refund 9SV7710612642500S' }],
  },
  {
    icon: Ban,
    test: 'A forged PayPal webhook arrives',
    result: 'Ignored. Every event is verified with PayPal before it changes anything.',
    evidence: [{ text: 'webhook.test.ts', href: `${TESTS}/webhook.test.ts` }, { text: 'live app log' }],
  },
];

export function Refusals() {
  return (
    <section id="refusals" className="lp-section lp-bg-white" aria-labelledby="lp-refusals-title">
      <div className="lp-container">
        <div className="lp-section-head">
          <p className="lp-label">Negative proof</p>
          <h2 id="lp-refusals-title" className="lp-h2">
            Built to say no
          </h2>
          <p className="lp-lead">
            A payments product is judged by the charges it refuses. Every case below was tested in code or run against
            PayPal sandbox.
          </p>
        </div>

        <div className="lp-ledger" role="table" aria-label="Cases Batchday refuses">
          <div className="lp-ledger-head" role="row">
            <span role="columnheader">Case</span>
            <span role="columnheader">What Batchday does</span>
            <span role="columnheader">Evidence</span>
          </div>
          {ROWS.map(({ icon: Icon, test, result, evidence }) => (
            <div key={test} className="lp-ledger-row" role="row">
              <div className="lp-ledger-case" role="cell">
                <Icon size={18} strokeWidth={1.5} aria-hidden="true" className="lp-icon" />
                <span>{test}</span>
              </div>
              <p className="lp-ledger-result" role="cell">{result}</p>
              <p className="lp-ledger-evidence" role="cell">
                {evidence.map((e, i) => (
                  <span key={e.text}>
                    {i > 0 && <span aria-hidden="true">, </span>}
                    {e.href ? (
                      <a href={e.href} target="_blank" rel="noreferrer">{e.text}</a>
                    ) : (
                      e.text
                    )}
                  </span>
                ))}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
