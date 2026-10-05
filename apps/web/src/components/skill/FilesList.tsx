import type { FileEntry } from '../../lib/registry';
import { Badge, FileIcon, FileTextIcon, formatBytes, shortenDigest } from '../ui';

export interface FilesListProps {
  files: readonly FileEntry[];
}

/** The files of the version as a manifest: path, kind, size and the short SHA-256 of each. */
export function FilesList({ files }: FilesListProps) {
  if (files.length === 0) {
    return <p className="text-muted text-small">No file list was recorded for this version.</p>;
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="overflow-clip rounded-card border border-border bg-surface-1">
      <ul className="m-0 list-none p-0">
        {sorted.map((file) => (
          <li
            key={file.path}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-b px-4 py-2.5 last:border-b-0 sm:flex-nowrap"
          >
            <span className="flex min-w-0 flex-1 basis-full items-center gap-2.5 sm:basis-auto">
              {file.kind === 'text' ? (
                <FileTextIcon size={15} className="text-subtle" />
              ) : (
                <FileIcon size={15} className="text-subtle" />
              )}
              <span className="min-w-0 break-all font-mono text-mono text-text">{file.path}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 pl-[1.6rem] sm:pl-0">
              {file.executable ? (
                <Badge tone="warn" mono title="The file has the executable bit set">
                  exec
                </Badge>
              ) : null}
              {file.kind === 'binary' ? (
                <Badge mono title="Binary file; it is not shown as text">
                  binary
                </Badge>
              ) : null}
              <span
                title={file.sha256}
                className="hidden font-mono text-[0.75rem] text-subtle leading-5 md:inline"
              >
                <span className="sr-only">SHA-256 </span>
                {shortenDigest(file.sha256, 6, 2)}
              </span>
              <span className="w-[4.5rem] text-right font-mono text-[0.8125rem] text-muted leading-5">
                {formatBytes(file.size)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between gap-3 border-border border-t bg-surface-2 px-4 py-2.5 font-mono text-[0.8125rem] text-muted leading-5">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        <span>{formatBytes(total)}</span>
      </p>
    </div>
  );
}
