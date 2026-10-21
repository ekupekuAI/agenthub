import { Container, Eyebrow, Logo, Reveal } from '../ui';
import { PlushTile } from './PlushTile';

const POINTS: { term: string; body: string }[] = [
  { term: 'Scanned', body: 'Every file, on upload and again on install.' },
  { term: 'Declared', body: 'Checked against the permissions the author wrote down.' },
  { term: 'Recorded', body: 'A SHA-256 hash per file in your lockfile.' },
];

/** The logo as a tactile object: what it stands for on the left, the plush icon on the right. */
export function BrandShowcase() {
  return (
    <section
      aria-labelledby="brand-heading"
      className="ambient border-border border-t py-14 [--ambient-k:14%] [--ambient-x:80%] [--ambient-y:45%] lg:py-24"
    >
      <Container className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
        <div className="min-w-0">
          <Eyebrow dot>The mark</Eyebrow>
          <h2 id="brand-heading" className="display-2 mt-4 text-text">
            An A that <em className="text-signal-ink italic">checks</em>.
          </h2>
          <p className="mt-4 max-w-[34rem] text-body text-muted">
            The A is for agenthub. Its crossbar is a check mark, because every skill goes through
            the same three steps before it reaches your agents.
          </p>
          <dl className="mt-8 grid gap-4">
            {POINTS.map((p) => (
              <div key={p.term} className="flex items-baseline gap-3">
                <Logo size={16} className="translate-y-0.5" />
                <div>
                  <dt className="inline font-medium text-text">{p.term}. </dt>
                  <dd className="inline text-muted">{p.body}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <Reveal delay={0.06} className="min-w-0">
          <div className="theme-dark relative mx-auto aspect-square w-full max-w-[560px] overflow-hidden rounded-panel border border-border-strong bg-[#090b07] shadow-pop">
            <PlushTile className="absolute inset-0" fallback={<Logo size={240} />} />
            <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center font-mono text-[0.75rem] text-subtle">
              Hover or drag to brush the fur
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
