import { describe, it, expect, beforeEach } from 'vitest';
import { makeUsageTracker, DAILY_FREE_LIMIT } from '../src/usage';

// In-memory stand-in for chrome.storage.local — same get/set shape.
function makeFakeStorage(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
    set: (items: Record<string, unknown>) => {
      Object.assign(store, items);
      return Promise.resolve();
    },
  };
}

describe('makeUsageTracker', () => {
  let storage: ReturnType<typeof makeFakeStorage>;

  beforeEach(() => {
    storage = makeFakeStorage();
  });

  it('a brand-new user has the full daily allowance remaining', async () => {
    const usage = makeUsageTracker({ storageGet: storage.get, storageSet: storage.set });
    expect(await usage.remaining()).toBe(DAILY_FREE_LIMIT);
  });

  it('each increment consumes one interaction from the allowance', async () => {
    const usage = makeUsageTracker({ storageGet: storage.get, storageSet: storage.set });
    await usage.increment();
    await usage.increment();
    expect(await usage.remaining()).toBe(DAILY_FREE_LIMIT - 2);
  });

  it('remaining reaches 0 after the full allowance is used and never goes negative', async () => {
    const usage = makeUsageTracker({ storageGet: storage.get, storageSet: storage.set });
    for (let i = 0; i < DAILY_FREE_LIMIT + 1; i++) await usage.increment();
    expect(await usage.remaining()).toBe(0);
  });

  it('the count survives across tracker instances via storage (content and background share it)', async () => {
    const first = makeUsageTracker({ storageGet: storage.get, storageSet: storage.set });
    await first.increment();
    const second = makeUsageTracker({ storageGet: storage.get, storageSet: storage.set });
    expect(await second.remaining()).toBe(DAILY_FREE_LIMIT - 1);
  });

  it('the counter resets at midnight UTC', async () => {
    let clock = new Date('2026-07-03T23:59:00Z');
    const usage = makeUsageTracker({
      storageGet: storage.get,
      storageSet: storage.set,
      now: () => clock,
    });
    for (let i = 0; i < DAILY_FREE_LIMIT; i++) await usage.increment();
    expect(await usage.remaining()).toBe(0);

    clock = new Date('2026-07-04T00:01:00Z');
    expect(await usage.remaining()).toBe(DAILY_FREE_LIMIT);
  });

  it('an increment after midnight starts a fresh day rather than resurrecting the stale count', async () => {
    let clock = new Date('2026-07-03T12:00:00Z');
    const usage = makeUsageTracker({
      storageGet: storage.get,
      storageSet: storage.set,
      now: () => clock,
    });
    for (let i = 0; i < 5; i++) await usage.increment();

    clock = new Date('2026-07-04T08:00:00Z');
    await usage.increment();
    expect(await usage.remaining()).toBe(DAILY_FREE_LIMIT - 1);
  });
});
