import { Container, Eyebrow, Stagger, StaggerItem } from '../ui';

const STEPS: { name: string; body: string; detail: string }[] = [
  {
    name: 'Detect',
    body: 'Finds the agents in your project and the skills folders each one reads.',
    detail: 'claude-code · codex · cursor · vscode',
  },
  {
    name: 'Scan',
    body: 'Checks every file against twelve rules and the permissions the skill declares.',
    detail: 'INFO · WARN · BLOCK',
  },
  {
    name: 'Install',
    body: 'Shows you the plan, then copies the files. Nothing in the skill is run.',
    detail: '+ .claude/skills/web-testing',
  },
  {
    name: 'Verify',
    body: 'Records a hash for every file in the lockfile so drift is caught later.',
    detail: 'agenthub verify web-testing',
  },
];

/** Detect → Scan → Install → Verify. */
export function HowItWorks() {
  return (
    <section aria-labelledby="how-heading" className="border-border border-t py-14 lg:py-24">
      <Container>
        <div className="max-w-2xl">
          <Eyebrow className="mb-3">How it works</Eyebrow>
          <h2 id="how-heading" className="display-2 text-text">
            Four steps, every <em className="text-signal-ink italic">install</em>.
          </h2>
        </div>

        <Stagger
          as="ol"
          className="m-0 mt-12 grid list-none gap-px overflow-hidden rounded-card border border-border bg-border p-0 sm:grid-cols-2 lg:grid-cols-4"
        >
          {STEPS.map((step, index) => (
            <StaggerItem as="li" key={step.name} className="flex min-w-0 flex-col bg-surface-1 p-6">
              <span className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 items-center justify-center rounded-full border border-signal-line font-mono text-[0.75rem] text-signal-ink"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              </span>
              <h3 className="mt-5 font-semibold text-h3 text-text">
                <span className="sr-only">Step {index + 1}: </span>
                {step.name}
              </h3>
              <p className="mt-2 text-muted text-small">{step.body}</p>
              <p className="mt-auto pt-5 font-mono text-[0.75rem] text-subtle leading-5 [overflow-wrap:anywhere]">
                {step.detail}
              </p>
            </StaggerItem>
          ))}
        </Stagger>
      </Container>
    </section>
  );
}
