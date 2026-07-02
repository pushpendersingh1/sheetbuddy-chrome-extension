// Free-tier usage tracking (issue #23): 10 interactions per UTC day, stored in
// chrome.storage.local so the count is shared between the content script (which
// gates dispatch) and the background service worker (which increments on
// successful plan outcomes). Deps are injected so this is unit-testable without
// Chrome APIs, mirroring relay.ts/sheet-plan.ts.

export const DAILY_FREE_LIMIT = 10;

const STORAGE_KEY = 'sheetbuddy-usage';

interface UsageRecord {
  date: string; // UTC calendar day, e.g. "2026-07-03"
  count: number;
}

export interface UsageTrackerDeps {
  storageGet: (key: string) => Promise<Record<string, unknown>>;
  storageSet: (items: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

export function makeUsageTracker(deps: UsageTrackerDeps) {
  const { storageGet, storageSet } = deps;
  const now = deps.now ?? (() => new Date());

  function todayUTC(): string {
    return now().toISOString().slice(0, 10);
  }

  async function readCount(): Promise<number> {
    const items = await storageGet(STORAGE_KEY);
    const record = items[STORAGE_KEY] as UsageRecord | undefined;
    // A record from a previous UTC day is stale — the counter resets lazily at
    // midnight UTC by ignoring it, no alarm needed.
    if (!record || record.date !== todayUTC()) return 0;
    return record.count;
  }

  async function remaining(): Promise<number> {
    return Math.max(0, DAILY_FREE_LIMIT - (await readCount()));
  }

  async function increment(): Promise<void> {
    const count = await readCount();
    const record: UsageRecord = { date: todayUTC(), count: count + 1 };
    await storageSet({ [STORAGE_KEY]: record });
  }

  return { remaining, increment };
}
