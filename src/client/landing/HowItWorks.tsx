import reserveShot from './assets/step-reserve.webp';
import planShot from './assets/step-plan.webp';
import updateShot from './assets/step-update.webp';
import chargeShot from './assets/step-charge.webp';

interface Step {
  n: string;
  label: string;
  title: string;
  body: string;
  img: string;
  width: number;
  height: number;
  alt: string;
  narrow?: boolean;
}

const STEPS: Step[] = [
  {
    n: '01',
    label: 'Reserve',
    title: 'The buyer saves PayPal. Nothing is charged.',
    body: 'One PayPal approval saves the wallet. The buyer gets a status page showing their batch, the ship date, and the day charging opens.',
    img: reserveShot,
    width: 840,
    height: 882,
    alt: 'Buyer status page: Reserved for batch 2, ships Dec 12, 2026, expected charge date Nov 22, 2026, $49.00, with a note that charging opens under the 20-day rule and a Cancel reservation button.',
    narrow: true,
  },
  {
    n: '02',
    label: 'Plan',
    title: 'Your production plan lives in a Bryntum Gantt.',
    body: 'Factory runs, QC, freight, and one ship milestone per batch, linked by dependencies. Move a task and everything after it reschedules. Each milestone shows when charging opens and who has paid.',
    img: planShot,
    width: 1800,
    height: 540,
    alt: 'Gantt rows: Ship batch 1 on Nov 27 with charging open and 1 charged, shown as a green milestone. Ship batch 2 on Dec 12, charging opens Nov 22, 1 waiting, shown as a gray milestone.',
  },
  {
    n: '03',
    label: 'Update',
    title: 'Paste a supplier email. AI proposes the change.',
    body: 'Gemini reads the message and proposes schedule changes, each with the exact words it relied on. You see the effect on every ship date before anything moves, and nothing changes until you apply it.',
    img: updateShot,
    width: 1388,
    height: 800,
    alt: 'Supplier update proposed by gemini-3.6-flash: Freight, batch 2 finishes 4 days earlier, quoting "freight for batch 2 will take 4 days less than planned", with estimated ship dates per batch and Apply to plan and Discard buttons.',
  },
  {
    n: '04',
    label: 'Charge',
    title: 'Batches inside 20 days charge themselves.',
    body: 'When a batch comes within 20 days of shipping, every reserved buyer in it is charged through PayPal, once each. The order, capture, and debug IDs are logged for every charge.',
    img: chargeShot,
    width: 1246,
    height: 140,
    alt: 'Charge log row: $49.00, Captured, PayPal order 0H493664XK267533Y, capture 64R53992J5731530H, debug ID ca576acb90eb7, HTTP 201.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="lp-section lp-bg-band" aria-labelledby="lp-how-title">
      <div className="lp-container">
        <div className="lp-section-head">
          <p className="lp-label">How it works</p>
          <h2 id="lp-how-title" className="lp-h2">
            One production plan decides who pays, and when.
          </h2>
        </div>

        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <li key={s.n} className={`lp-step${i % 2 ? ' lp-step-flip' : ''}`}>
              <div className="lp-step-copy">
                <p className="lp-step-num">
                  <span className="lp-mono">{s.n}</span> {s.label}
                </p>
                <h3 className="lp-step-title">{s.title}</h3>
                <p className="lp-body">{s.body}</p>
              </div>
              <div className={`lp-step-shot${s.narrow ? ' lp-step-shot-narrow' : ''}`}>
                <div className="lp-frame" tabIndex={s.narrow ? undefined : 0} role={s.narrow ? undefined : 'region'} aria-label={s.narrow ? undefined : `${s.label} screenshot`}>
                  <img src={s.img} width={s.width} height={s.height} alt={s.alt} loading="lazy" decoding="async" />
                </div>
              </div>
            </li>
          ))}
        </ol>

        <p className="lp-source">All four images are captured from Batchday running against PayPal sandbox.</p>
      </div>
    </section>
  );
}
