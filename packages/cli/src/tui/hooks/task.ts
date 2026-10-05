import { useCallback, useEffect, useRef, useState } from 'react';

export type TaskState<T> =
  | { status: 'loading' }
  | { status: 'done'; value: T }
  | { status: 'error'; error: unknown };

/**
 * Runs an async read when the component mounts and whenever `deps` change; results of a stale
 * run are dropped. `reload()` runs it again.
 */
export function useTask<T>(
  run: () => Promise<T>,
  deps: readonly unknown[],
): [TaskState<T>, () => void] {
  const [state, setState] = useState<TaskState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    runRef.current().then(
      (value) => {
        if (live) setState({ status: 'done', value });
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', error });
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return [state, reload];
}
