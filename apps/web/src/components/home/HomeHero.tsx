import {
  ArrowRightIcon,
  Container,
  CopyCommand,
  Eyebrow,
  Reveal,
  ShimmerButton,
  Terminal,
} from '../ui';
import { HERO_SCENARIOS } from './hero-scenarios';

/** Home hero: the promise on the left, the real CLI output on the right. */
export function HomeHero() {
  return (
    <section aria-labelledby="hero-title" className="dot-grid overflow-hidden">
      <Container
        width="wide"
        className="grid items-center gap-12 pt-12 pb-14 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16 lg:pt-24 lg:pb-20"
      >
        <div className="min-w-0">
          <Eyebrow dot>Package manager · trust layer</Eyebrow>
          <h1 id="hero-title" className="display-1 mt-5 text-text">
            Install agent skills you can <em className="text-signal-ink italic">trust</em>.
          </h1>
          <p className="mt-6 max-w-[36rem] text-[1.125rem] text-muted leading-7">
            One command installs a skill into Claude Code, Codex, Cursor and VS Code. agenthub scans
            it first, checks it against what it declares, and records every byte so you can verify,
            update and roll back.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <ShimmerButton href="#skills">
              Browse skills
              <ArrowRightIcon size={16} />
            </ShimmerButton>
            <CopyCommand command="agenthub install web-testing" className="sm:w-auto" />
          </div>
          <p className="mt-6 font-mono text-[0.8125rem] text-subtle leading-5">
            Every skill. Every agent. Nothing you didn&apos;t approve.
          </p>
        </div>

        <Reveal delay={0.08} className="min-w-0">
          <Terminal scenarios={HERO_SCENARIOS} title="~/my-app" />
          <p className="mt-3 px-1 font-mono text-[0.75rem] text-subtle leading-5">
            Three recorded sessions. Pick a tab to replay one.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
