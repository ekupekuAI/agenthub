export type ClassValue = string | false | null | undefined;

/** Joins the truthy class names with a space. No merging: later classes do not override. */
export function cn(...parts: ClassValue[]): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    out = out ? `${out} ${part}` : part;
  }
  return out;
}
