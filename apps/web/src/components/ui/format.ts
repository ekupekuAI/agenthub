/** `sha256:9f2c…e1`: the algorithm prefix, the first `head` and the last `tail` hex digits. */
export function shortenDigest(digest: string, head = 4, tail = 2): string {
  const match = /^([a-z0-9]+:)?([a-f0-9]+)$/i.exec(digest);
  if (!match) return digest;
  const prefix = match[1] ?? '';
  const hex = match[2] ?? '';
  if (hex.length <= head + tail + 1) return digest;
  return `${prefix}${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** `4 Oct 2026` in UTC, or an em dash when the value is missing or not a date. */
export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Human-readable byte size: `812 B`, `14.2 kB`, `3.1 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
