export interface DevReloaderDeps {
  fetchFn: typeof globalThis.fetch;
  reload: () => void;
  url: string;
}

/**
 * Returns a checkReload function that polls the dev build server.
 * First call seeds the version without reloading; subsequent calls
 * with a changed version trigger reload().
 * Injected deps make the logic unit-testable without Chrome APIs.
 */
export function makeDevReloader({ fetchFn, reload, url }: DevReloaderDeps) {
  let seededVersion: number | null = null;

  return async function checkReload(): Promise<void> {
    try {
      const res = await fetchFn(url, { cache: 'no-store' });
      if (!res.ok) return;
      const { v } = (await res.json()) as { v: number };
      if (seededVersion === null) { seededVersion = v; return; } // seed on first run
      if (v !== seededVersion) reload();
    } catch { /* dev server not running in production — no-op */ }
  };
}
