import '@fontsource-variable/inter';
import './landing.css';
import { Hero } from './Hero';
import { HowItWorks } from './HowItWorks';
import { Nav } from './Nav';
import { Rule } from './Rule';

export function Landing() {
  return (
    <div className="lp">
      <Nav />
      <main id="main">
        <Hero />
        <Rule />
        <HowItWorks />
      </main>
    </div>
  );
}
