import { useEffect, useState } from 'react';
import { ArrowUpRight, Menu, PackageCheck, X } from 'lucide-react';

const REPO_URL = 'https://github.com/mystiquemide/batchday';

function Links({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <li><a href="#how-it-works" onClick={onNavigate}>How it works</a></li>
      <li><a href="#proof" onClick={onNavigate}>Proof</a></li>
      <li>
        <a href={REPO_URL} target="_blank" rel="noreferrer" onClick={onNavigate}>
          GitHub <ArrowUpRight size={18} strokeWidth={1.5} aria-hidden="true" />
        </a>
      </li>
    </>
  );
}

export function Nav() {
  // The workspace cookie is HttpOnly, so ask the server whether this visitor already has one.
  const [hasWorkspace, setHasWorkspace] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    fetch('/api/workspace', { credentials: 'same-origin' })
      .then((r) => setHasWorkspace(r.ok))
      .catch(() => setHasWorkspace(false));
  }, []);

  // Close the phone menu on Escape or when the screen widens past the mobile breakpoint.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const wide = window.matchMedia('(min-width: 768px)');
    const onWide = () => wide.matches && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    wide.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [menuOpen]);

  return (
    <header className="lp-nav">
      <nav className="lp-nav-inner" aria-label="Main">
        <a className="lp-brand" href="/" aria-label="Batchday home">
          <PackageCheck size={22} strokeWidth={2} aria-hidden="true" className="lp-brand-mark" />
          <span>Batchday</span>
        </a>
        <ul className="lp-nav-links">
          <Links />
        </ul>
        <a className="lp-btn lp-btn-primary" href="/app">
          {hasWorkspace ? 'Open your workspace' : 'Open the app'}
        </a>
        <button
          type="button"
          className="lp-menu-btn"
          aria-expanded={menuOpen}
          aria-controls="lp-mobile-menu"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <X size={18} strokeWidth={1.5} aria-hidden="true" /> : <Menu size={18} strokeWidth={1.5} aria-hidden="true" />}
        </button>
      </nav>
      <ul id="lp-mobile-menu" className="lp-mobile-menu" hidden={!menuOpen}>
        <Links onNavigate={() => setMenuOpen(false)} />
      </ul>
    </header>
  );
}
