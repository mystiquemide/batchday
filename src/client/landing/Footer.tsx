import { PackageCheck } from 'lucide-react';

const REPO_URL = 'https://github.com/mystiquemide/batchday';

export function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-container">
        <div className="lp-footer-top">
          <a className="lp-brand lp-on-dark" href="/" aria-label="Batchday home">
            <PackageCheck size={22} strokeWidth={2} aria-hidden="true" className="lp-footer-mark" />
            <span>Batchday</span>
          </a>
          <p className="lp-footer-built">Built with PayPal, Bryntum Gantt, Gemini, and Render</p>
          <nav aria-label="Footer">
            <ul className="lp-footer-links">
              <li><a href="/app">Open the app</a></li>
              <li><a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a></li>
              <li><a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT License</a></li>
            </ul>
          </nav>
        </div>
        <p className="lp-footer-legal">
          &copy; 2026 MystiqueMide. Batchday runs on PayPal sandbox. No real money moves.
        </p>
      </div>
    </footer>
  );
}
