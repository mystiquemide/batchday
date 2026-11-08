import { useEffect, useState } from 'react';
import { ArrowUpRight, PackageCheck } from 'lucide-react';

const REPO_URL = 'https://github.com/mystiquemide/batchday';

export function Nav() {
  // The workspace cookie is HttpOnly, so ask the server whether this visitor already has one.
  const [hasWorkspace, setHasWorkspace] = useState(false);
  useEffect(() => {
    fetch('/api/workspace', { credentials: 'same-origin' })
      .then((r) => setHasWorkspace(r.ok))
      .catch(() => setHasWorkspace(false));
  }, []);

  return (
    <header className="lp-nav">
      <nav className="lp-nav-inner" aria-label="Main">
        <a className="lp-brand" href="/" aria-label="Batchday home">
          <PackageCheck size={22} strokeWidth={2} aria-hidden="true" className="lp-brand-mark" />
          <span>Batchday</span>
        </a>
        <ul className="lp-nav-links">
          <li><a href="#how-it-works">How it works</a></li>
          <li><a href="#proof">Proof</a></li>
          <li>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
            </a>
          </li>
        </ul>
        <a className="lp-btn lp-btn-primary" href="/app">
          {hasWorkspace ? 'Open your workspace' : 'Open the app'}
        </a>
      </nav>
    </header>
  );
}
