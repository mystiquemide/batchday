import { ArrowRight } from 'lucide-react';
import ganttShot from './assets/hero-gantt.webp';

export function Hero() {
  return (
    <section className="lp-hero" aria-labelledby="lp-hero-title">
      <div className="lp-container">
        <div className="lp-hero-copy">
          <h1 id="lp-hero-title" className="lp-h1">
            Pre-orders that charge only when the batch is ready to ship.
          </h1>
          <p className="lp-lead">
            Buyers save PayPal today. Batchday charges each one automatically once their batch is within 20 days of
            shipping, straight from your live production plan.
          </p>
          <div className="lp-hero-actions">
            <a className="lp-btn lp-btn-primary lp-btn-lg" href="/app">
              Open the app
            </a>
            <a className="lp-textlink" href="#how-it-works">
              See how it works <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </a>
          </div>
          <p className="lp-hero-note">PayPal sandbox. No signup.</p>
        </div>

        <figure className="lp-hero-shot">
          <div className="lp-frame" tabIndex={0} role="region" aria-label="Batchday Gantt screenshot">
            <img
              src={ganttShot}
              width={2800}
              height={1282}
              alt="Batchday production plan in a Bryntum Gantt. Ship batch 1 on Nov 27 is green with charging open and 1 buyer charged. Ship batch 2 on Dec 12 is gray, charging opens Nov 22, 1 buyer waiting. Ship batch 3 on Dec 22 has no buyers yet."
              fetchPriority="high"
              decoding="async"
            />
          </div>
          <figcaption className="lp-caption">
            Captured from the Batchday console. Each ship milestone shows when charging opens and who has been charged.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
