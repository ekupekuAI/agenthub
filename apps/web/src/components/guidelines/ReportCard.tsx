import { ArrowUpRightIcon, Eyebrow, ShieldCheckIcon } from '../ui';

/** A link for the configured security contact: an e-mail address or an https URL. */
export function contactHref(contact: string): string | null {
  if (/^https:\/\/[^\s]+$/i.test(contact)) return contact;
  if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(contact)) return `mailto:${contact}`;
  return null;
}

/** The security contact as a link when it is one, otherwise as text. */
export function SecurityContact({ contact }: { contact: string }) {
  const href = contactHref(contact);
  if (!href) return <span className="font-mono text-text [overflow-wrap:anywhere]">{contact}</span>;
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 font-mono [overflow-wrap:anywhere]"
      {...(href.startsWith('https:') ? { rel: 'noopener noreferrer', target: '_blank' } : {})}
    >
      {contact}
      {href.startsWith('https:') ? <ArrowUpRightIcon size={14} className="shrink-0" /> : null}
    </a>
  );
}

const INCLUDE = [
  'The skill name and version, or the skill page URL',
  'The content digest shown on the skill page',
  'The file and line, and what it does',
] as const;

/** The closing card of the Guidelines page: where to report a malicious skill. */
export function ReportCard({ contact }: { contact: string | null }) {
  return (
    <aside
      aria-labelledby="report-card-title"
      className="mt-20 overflow-hidden rounded-panel border border-border bg-surface-1 shadow-panel"
    >
      <div className="grid gap-8 px-5 py-7 sm:px-8 sm:py-9 md:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0">
          <Eyebrow className="mb-3">Report a problem</Eyebrow>
          <p
            id="report-card-title"
            className="font-display text-[2rem] text-text leading-[1.1] [text-wrap:balance]"
          >
            Found a skill that <em>should not</em> be here?
          </p>
          <p className="mt-3 text-muted text-small">
            Report it privately. Moderators can quarantine a version at once while they look into
            it.
          </p>
          <div className="mt-6 flex items-start gap-3 rounded-control border border-border-strong bg-surface-2 px-4 py-3">
            <ShieldCheckIcon size={18} className="mt-0.5 shrink-0 text-signal-ink" />
            <p className="min-w-0 text-small">
              <span className="block text-[0.75rem] text-muted">Security contact</span>
              {contact ? (
                <SecurityContact contact={contact} />
              ) : (
                <span className="text-text">
                  Use the published security contact of the operator of this registry.
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="min-w-0 border-border border-t pt-6 md:border-t-0 md:border-l md:pt-0 md:pl-8">
          <p className="eyebrow">Include</p>
          <ul className="m-0 mt-3 grid list-none gap-2.5 p-0 text-[0.8125rem] text-muted leading-5">
            {INCLUDE.map((item) => (
              <li key={item} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-subtle"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}
