import { ArrowUpRight } from 'lucide-react';

const REPO_URL = 'https://github.com/mystiquemide/batchday2';

export function FinalCta() {
  return (
    <section id="start" className="lp-section lp-bg-dark" aria-labelledby="lp-start-title">
      <div className="lp-container">
        <div className="lp-section-head">
          <h2 id="lp-start-title" className="lp-h2 lp-on-dark">
            Run the whole loop in two minutes
          </h2>
          <p className="lp-lead lp-on-dark-2">
            Reserve with a sandbox buyer, paste a supplier update, and watch PayPal charge only the batch that is ready
          </p>
          <div className="lp-hero-actions">
            <a className="lp-btn lp-btn-primary lp-btn-lg" href="/app">
              Open the app
            </a>
            <a className="lp-textlink lp-textlink-dark" href={REPO_URL} target="_blank" rel="noreferrer">
              View the code on GitHub <ArrowUpRight size={18} strokeWidth={1.5} aria-hidden="true" />
            </a>
          </div>
          <p className="lp-dark-note">
            The app runs on free hosting, so the first visit after a quiet spell takes about a minute while the server wakes up
          </p>
        </div>
      </div>
    </section>
  );
}
