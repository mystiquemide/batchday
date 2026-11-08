import '@fontsource-variable/inter';
import './landing.css';
import { FinalCta } from './FinalCta';
import { Fit } from './Fit';
import { Hero } from './Hero';
import { HowItWorks } from './HowItWorks';
import { Nav } from './Nav';
import { Proof } from './Proof';
import { Refusals } from './Refusals';
import { Rule } from './Rule';

export function Landing() {
  return (
    <div className="lp">
      <Nav />
      <main id="main">
        <Hero />
        <Rule />
        <HowItWorks />
        <Refusals />
        <Proof />
        <Fit />
        <FinalCta />
      </main>
    </div>
  );
}
