import { ArrowRightIcon, BookOpenIcon, Button, Container, Reveal, Seal } from '../ui';

/** Closing band: read the rules before installing or publishing. */
export function GuidelinesCta() {
  return (
    <section aria-labelledby="cta-heading" className="pt-4 pb-14 lg:pb-24">
      <Container>
        <Reveal>
          <div className="relative overflow-hidden rounded-panel border border-border-strong bg-surface-1 p-6 shadow-panel sm:p-10 lg:p-12">
            <Seal
              size={168}
              className="pointer-events-none absolute -top-10 -right-10 opacity-[0.07] sm:-top-6 sm:-right-6"
            />
            <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="max-w-2xl">
                <p className="eyebrow mb-3">Guidelines</p>
                <h2 id="cta-heading" className="display-2 text-text">
                  Know the <em className="text-signal-ink italic">rules</em> before you install.
                </h2>
                <p className="mt-4 text-body text-muted">
                  What each scanner rule catches, how install policy decides, how to write a skill
                  that passes, and how to report one that should not.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  href="/guidelines"
                  variant="primary"
                  size="lg"
                  leadingIcon={<BookOpenIcon size={16} />}
                >
                  Read the guidelines
                </Button>
                <Button
                  href="/guidelines#security-model"
                  variant="secondary"
                  size="lg"
                  trailingIcon={<ArrowRightIcon size={16} />}
                >
                  Security model
                </Button>
              </div>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
