import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { makeSheetsApi } from '../src/background/sheets-api';

function okResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('makeSheetsApi', () => {
  let fetchFn: MockInstance;
  let getAuthToken: MockInstance;
  let removeCachedToken: MockInstance;

  function makeApi() {
    return makeSheetsApi({
      fetchFn: fetchFn as unknown as typeof fetch,
      getAuthToken: getAuthToken as unknown as (interactive: boolean) => Promise<string>,
      removeCachedToken: removeCachedToken as unknown as (token: string) => Promise<void>,
    });
  }

  beforeEach(() => {
    fetchFn = vi.fn().mockResolvedValue(okResponse());
    getAuthToken = vi.fn().mockResolvedValue('tok-1');
    removeCachedToken = vi.fn().mockResolvedValue(undefined);
  });

  it('writeCell PUTs the value to the range as USER_ENTERED with a bearer token', async () => {
    await makeApi().writeCell('sheet-id-1', "'Sheet1'!B7", '=SUM(A1:A5)');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/sheet-id-1/values/${encodeURIComponent("'Sheet1'!B7")}?valueInputOption=USER_ENTERED`,
    );
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-1');
    expect(JSON.parse(init.body as string)).toEqual({ values: [['=SUM(A1:A5)']] });
  });

  it('uses a silent (non-interactive) token when one is available, without prompting', async () => {
    await makeApi().writeCell('sheet-id-1', 'B7', '42');

    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(getAuthToken).toHaveBeenCalledWith(false);
  });

  it('falls back to an interactive OAuth prompt on first use when no silent token exists', async () => {
    getAuthToken
      .mockRejectedValueOnce(new Error('The user is not signed in'))
      .mockResolvedValueOnce('tok-interactive');

    await makeApi().writeCell('sheet-id-1', 'B7', '42');

    expect(getAuthToken).toHaveBeenNthCalledWith(1, false);
    expect(getAuthToken).toHaveBeenNthCalledWith(2, true);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-interactive');
  });

  it('evicts a stale cached token on 401 and retries once with a fresh one', async () => {
    getAuthToken.mockResolvedValueOnce('tok-stale').mockResolvedValueOnce('tok-fresh');
    fetchFn
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(okResponse());

    await makeApi().writeCell('sheet-id-1', 'B7', '42');

    expect(removeCachedToken).toHaveBeenCalledWith('tok-stale');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>)['authorization']).toBe('Bearer tok-fresh');
  });

  it('rejects with a clear message when the API declines the write', async () => {
    fetchFn.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status: 403 }),
    );

    await expect(makeApi().writeCell('sheet-id-1', 'B7', '42')).rejects.toThrow(
      'Sheets API write failed (403): The caller does not have permission',
    );
  });

  it('rejects rather than retrying forever when the fresh token is also rejected', async () => {
    fetchFn.mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(makeApi().writeCell('sheet-id-1', 'B7', '42')).rejects.toThrow('Sheets API write failed (401)');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('readRange batchGets the requested ranges and returns their values', async () => {
    fetchFn.mockResolvedValue(
      okResponse({ valueRanges: [{ range: "'Sheet1'!B7", values: [['42']] }] }),
    );

    const values = await makeApi().readRange('sheet-id-1', ["'Sheet1'!B7"]);

    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/sheet-id-1/values:batchGet?ranges=${encodeURIComponent("'Sheet1'!B7")}`,
    );
    expect(values).toEqual([[['42']]]);
  });

  it('readRange joins multiple ranges as repeated query params', async () => {
    fetchFn.mockResolvedValue(okResponse({ valueRanges: [{ values: [['1']] }, { values: [['2']] }] }));

    const values = await makeApi().readRange('sheet-id-1', ['A1', 'B2']);

    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toContain('ranges=A1&ranges=B2');
    expect(values).toEqual([[['1']], [['2']]]);
  });
});
