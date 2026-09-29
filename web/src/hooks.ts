import { useCallback, useEffect, useRef, useState } from 'react';

/** Loads data on mount / when deps change; exposes reload for retry buttons. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fnRef.current()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);

  return { data, error, loading, reload, setData };
}

/** Calls fn every `ms` while `active`; stops when inactive or unmounted. */
export function useInterval(fn: () => void, ms: number, active = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => fnRef.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
