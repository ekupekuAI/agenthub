'use client';

import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn';
import { describedBy, fieldIds } from './Field';
import { formatBytes } from './format';
import { FileIcon, TriangleAlertIcon, UploadIcon, XIcon } from './icons';

export interface DropzoneProps {
  /** Id of the file input. */
  id: string;
  /** Form field name of the file input. */
  name: string;
  /** Visible label. It is the accessible name of the file input. */
  label: ReactNode;
  /** Helper text under the drop area. */
  hint?: ReactNode;
  /** Error text from the server or the form. */
  error?: ReactNode;
  /** Passed to the input, e.g. ".skillpkg,application/gzip". */
  accept?: string;
  required?: boolean;
  disabled?: boolean;
  /** Client-side size limit in bytes. Larger files are refused with a message. */
  maxBytes?: number;
  /** Text inside the drop area. */
  prompt?: ReactNode;
  onFileChange?: (file: File | null) => void;
  className?: string;
}

/**
 * A file input with a drop area. It is a real <input type="file"> inside a form: Tab reaches
 * it, Enter or Space opens the file dialog, and the browser submits the chosen file. Dragging
 * a file over the area highlights it; dropping assigns the file to the input.
 */
export function Dropzone({
  id,
  name,
  label,
  hint,
  error,
  accept,
  required,
  disabled,
  maxBytes,
  prompt = 'Drop the file here, or browse',
  onFileChange,
  className,
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const ids = fieldIds(id);
  const labelId = `${id}-label`;
  const shownError = localError ?? error;

  // React resets the form after a server action; mirror that in the summary line.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const onReset = () => {
      setFile(null);
      setLocalError(null);
    };
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);

  function accepted(next: File | null): void {
    if (next && maxBytes !== undefined && next.size > maxBytes) {
      if (inputRef.current) inputRef.current.value = '';
      setFile(null);
      setLocalError(
        `That file is ${formatBytes(next.size)}. The limit is ${formatBytes(maxBytes)}.`,
      );
      onFileChange?.(null);
      return;
    }
    setLocalError(null);
    setFile(next ? { name: next.name, size: next.size } : null);
    onFileChange?.(next);
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    accepted(event.target.files?.[0] ?? null);
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (disabled || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (disabled || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (disabled) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const dropped = event.dataTransfer.files;
    const input = inputRef.current;
    if (!input || dropped.length === 0) return;
    const transfer = new DataTransfer();
    const first = dropped[0];
    if (first) transfer.items.add(first);
    input.files = transfer.files;
    accepted(first ?? null);
  }

  function clear() {
    if (inputRef.current) {
      inputRef.current.value = '';
      inputRef.current.focus();
    }
    accepted(null);
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label id={labelId} htmlFor={id} className="font-medium text-small text-text">
        {label}
      </label>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag and drop is an enhancement; the file input inside is the keyboard and screen-reader path */}
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-dragging={dragging || undefined}
        className={cn(
          'relative rounded-card border border-dashed bg-surface-1 transition-[border-color,background-color] duration-150',
          'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-ring has-[input:focus-visible]:outline-offset-2',
          dragging
            ? 'border-signal-ink bg-signal-tint'
            : shownError
              ? 'border-block'
              : 'border-border-field hover:border-subtle',
          disabled && 'opacity-60',
        )}
      >
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="file"
          accept={accept}
          required={required}
          disabled={disabled}
          onChange={onChange}
          aria-labelledby={labelId}
          aria-describedby={describedBy(id, { hint, error: shownError })}
          aria-invalid={shownError ? true : undefined}
          className="peer absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <div className="pointer-events-none flex min-h-28 flex-col items-center justify-center gap-2 px-4 py-5 text-center">
          {file ? (
            <>
              <FileIcon size={22} className="text-signal-ink" />
              <p className="max-w-full break-all font-mono text-mono text-text">{file.name}</p>
              <p className="text-[0.8125rem] text-muted leading-5">{formatBytes(file.size)}</p>
            </>
          ) : (
            <>
              <UploadIcon size={22} className={dragging ? 'text-signal-ink' : 'text-subtle'} />
              <p className="text-small text-text">
                {dragging ? 'Release to attach the file' : prompt}
              </p>
            </>
          )}
        </div>
        {file && !disabled ? (
          <button
            type="button"
            onClick={clear}
            className="hit-area absolute top-2 right-2 inline-flex size-8 items-center justify-center rounded-chip text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
          >
            <XIcon size={16} />
            <span className="sr-only">Remove {file.name}</span>
          </button>
        ) : null}
      </div>
      {shownError ? (
        <p id={ids.error} role="alert" className="flex items-start gap-1.5 text-block text-small">
          <TriangleAlertIcon size={15} className="mt-[3px]" />
          <span>{shownError}</span>
        </p>
      ) : null}
      {hint ? (
        <p id={ids.hint} className="text-[0.8125rem] text-muted leading-5">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
