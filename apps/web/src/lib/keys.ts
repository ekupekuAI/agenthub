/** Stable, unique React keys for list items without relying on array indexes. */
export function keyed<T>(
  items: readonly T[],
  base: (item: T) => string,
): { item: T; key: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const b = base(item);
    const n = seen.get(b) ?? 0;
    seen.set(b, n + 1);
    return { item, key: n === 0 ? b : `${b}#${n}` };
  });
}

export function findingKey(f: { ruleId: string; file: string; line: number }): string {
  return `${f.ruleId}:${f.file}:${f.line}`;
}
