import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { makeDevReloader } from '../src/background/dev-reload';

function makeResponse(v: number, ok = true) {
  return {
    ok,
    json: () => Promise.resolve({ v }),
  } as unknown as Response;
}

describe('makeDevReloader', () => {
  let reload: MockInstance;
  let fetchFn: MockInstance;
  let checkReload: () => Promise<void>;

  beforeEach(() => {
    reload = vi.fn();
    fetchFn = vi.fn();
    checkReload = makeDevReloader({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      reload: reload as unknown as () => void,
      url: 'http://127.0.0.1:35729/',
    });
  });

  it('seeds version on first call without reloading', async () => {
    fetchFn.mockResolvedValue(makeResponse(1000));
    await checkReload();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when version is unchanged', async () => {
    fetchFn.mockResolvedValue(makeResponse(1000));
    await checkReload(); // seed
    await checkReload(); // same version
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when version changes after seeding', async () => {
    fetchFn.mockResolvedValueOnce(makeResponse(1000));
    await checkReload(); // seed v=1000
    fetchFn.mockResolvedValueOnce(makeResponse(2000));
    await checkReload(); // v changed → reload
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not re-seed after reload — third call with the same new version reloads again', async () => {
    fetchFn.mockResolvedValueOnce(makeResponse(1000));
    await checkReload(); // seed v=1000
    fetchFn.mockResolvedValueOnce(makeResponse(2000));
    await checkReload(); // v changed → first reload
    fetchFn.mockResolvedValueOnce(makeResponse(2000));
    await checkReload(); // v still 2000 but seededVersion is 1000 → reloads again
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('silently ignores a non-OK response', async () => {
    fetchFn.mockResolvedValue(makeResponse(1000, false));
    await checkReload(); // seed attempt with !ok
    fetchFn.mockResolvedValue(makeResponse(1000, false));
    await checkReload();
    expect(reload).not.toHaveBeenCalled();
  });

  it('silently ignores fetch errors (server not running)', async () => {
    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(checkReload()).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when server is down after seeding', async () => {
    fetchFn.mockResolvedValueOnce(makeResponse(1000));
    await checkReload(); // seed
    fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
    await checkReload(); // server down
    expect(reload).not.toHaveBeenCalled();
  });

  it('passes the correct URL and cache option to fetch', async () => {
    fetchFn.mockResolvedValue(makeResponse(1));
    await checkReload();
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:35729/', { cache: 'no-store' });
  });

  it('separate reloader instances have independent version state', async () => {
    const reload2: MockInstance = vi.fn();
    const check2 = makeDevReloader({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      reload: reload2 as unknown as () => void,
      url: 'http://127.0.0.1:35729/',
    });

    fetchFn.mockResolvedValue(makeResponse(1000));
    await checkReload(); // instance 1 seeds v=1000
    await check2();      // instance 2 seeds v=1000 independently

    fetchFn.mockResolvedValue(makeResponse(2000));
    await checkReload(); // instance 1 reloads
    expect(reload).toHaveBeenCalledOnce();
    expect(reload2).not.toHaveBeenCalled(); // instance 2 not yet polled
  });
});
