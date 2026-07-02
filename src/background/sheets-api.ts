// Google Sheets REST API client for graceful degradation (issue #23): when a
// DOM primitive fails (e.g. Google ships a Sheets update that breaks a
// selector), writes fall back to spreadsheets.values.update and reads to
// values.batchGet. Deps are injected so this is unit-testable without Chrome
// APIs, mirroring sheet-plan.ts/relay.ts.

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface SheetsApiDeps {
  fetchFn: typeof fetch;
  // Wraps chrome.identity.getAuthToken({ interactive }) — resolves the OAuth
  // token, rejecting if the user declines or no client is configured.
  getAuthToken: (interactive: boolean) => Promise<string>;
  // Wraps chrome.identity.removeCachedAuthToken — evicts a stale token so the
  // 401 retry below fetches a fresh one.
  removeCachedToken: (token: string) => Promise<void>;
}

export type SheetsApiClient = ReturnType<typeof makeSheetsApi>;

export function makeSheetsApi(deps: SheetsApiDeps) {
  const { fetchFn, getAuthToken, removeCachedToken } = deps;

  // Silent first, prompt only when silent fails: the first-ever use pops
  // Chrome's OAuth consent screen; once granted, Chrome caches the grant and
  // every later call resolves non-interactively.
  async function acquireToken(): Promise<string> {
    try {
      return await getAuthToken(false);
    } catch {
      return getAuthToken(true);
    }
  }

  async function authorizedFetch(url: string, init: Omit<RequestInit, 'headers'>): Promise<Response> {
    const token = await acquireToken();
    const withAuth = (t: string): Promise<Response> =>
      fetchFn(url, { ...init, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' } });

    const res = await withAuth(token);
    // Chrome's token cache outlives Google-side revocation/expiry — a 401 means
    // this cached token is dead, not that the user lacks access. Evict and retry
    // once with a fresh token; a second 401 is a real authorization failure.
    if (res.status === 401) {
      await removeCachedToken(token);
      return withAuth(await acquireToken());
    }
    return res;
  }

  async function expectOk(res: Response, action: string): Promise<void> {
    if (res.ok) return;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`Sheets API ${action} failed (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
  }

  // Writes a single value (formula or literal) to a cell. USER_ENTERED makes
  // the API parse "=SUM(...)" as a formula, exactly as if the user typed it.
  async function writeCell(spreadsheetId: string, range: string, value: string): Promise<void> {
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    const res = await authorizedFetch(url, {
      method: 'PUT',
      body: JSON.stringify({ values: [[value]] }),
    });
    await expectOk(res, 'write');
  }

  // Reads one or more ranges in a single call, returning each range's rows of
  // cell values (empty for ranges with no data).
  async function readRange(spreadsheetId: string, ranges: string[]): Promise<string[][][]> {
    const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values:batchGet?${query}`;
    const res = await authorizedFetch(url, { method: 'GET' });
    await expectOk(res, 'read');
    const body = (await res.json()) as { valueRanges?: Array<{ values?: string[][] }> };
    return (body.valueRanges ?? []).map((vr) => vr.values ?? []);
  }

  return { writeCell, readRange };
}
