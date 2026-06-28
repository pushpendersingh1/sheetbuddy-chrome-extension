import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { type Env } from './index';

// ---- Shared fetch mock ----

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

// ---- Helpers ----

const mockEnv: Env = {
  ANTHROPIC_API_KEY: 'test-anthropic',
  ELEVENLABS_API_KEY: 'test-eleven',
  ASSEMBLYAI_API_KEY: 'test-aai',
};

const validDomContext = {
  activeCell: 'C2',
  formulaBar: '',
  spreadsheetId: 'sheet-id-123',
  sheetGid: '0',
  sheetName: 'Sheet1',
  columnHeaders: ['Name', 'Sales'],
  availableSheets: ['Sheet1'],
};

const validChatBody = { text: 'sum column B into C2', domContext: validDomContext };

function makeRequest(path: string, body: unknown): Request {
  return new Request(`http://worker${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function anthropicOk(text: string): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// ---- CORS preflight ----

describe('CORS preflight', () => {
  it('OPTIONS returns 204 with CORS headers', async () => {
    const res = await worker.fetch(
      new Request('http://worker/chat', { method: 'OPTIONS' }),
      mockEnv,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

// ---- Method + route guard ----

describe('method and route guard', () => {
  it('GET returns 405', async () => {
    const res = await worker.fetch(
      new Request('http://worker/chat', { method: 'GET' }),
      mockEnv,
    );
    expect(res.status).toBe(405);
  });

  it('unknown path returns 404', async () => {
    const res = await worker.fetch(makeRequest('/unknown', {}), mockEnv);
    expect(res.status).toBe(404);
  });

  it('error responses include CORS header', async () => {
    const res = await worker.fetch(makeRequest('/unknown', {}), mockEnv);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

// ---- POST /chat ----

describe('POST /chat', () => {
  it('returns SheetPlan JSON on success', async () => {
    const plan = { totalSteps: 2, summary: 'Writing formula', steps: [] };
    mockFetch.mockResolvedValueOnce(anthropicOk(JSON.stringify(plan)));

    const res = await worker.fetch(makeRequest('/chat', validChatBody), mockEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toMatchObject({ totalSteps: 2, summary: 'Writing formula' });
  });

  it('falls back to advisor when Claude returns non-JSON', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk('VLOOKUP looks up a value in a table.'));

    const res = await worker.fetch(makeRequest('/chat', validChatBody), mockEnv);
    const body = await res.json() as { totalSteps: number; summary: string; steps: unknown[] };

    expect(res.status).toBe(200);
    expect(body.totalSteps).toBe(0);
    expect(body.steps).toEqual([]);
    expect(body.summary).toContain('VLOOKUP');
  });

  it('returns 400 when text is missing', async () => {
    const res = await worker.fetch(
      makeRequest('/chat', { domContext: validDomContext }),
      mockEnv,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when domContext is missing', async () => {
    const res = await worker.fetch(makeRequest('/chat', { text: 'hi' }), mockEnv);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await worker.fetch(
      new Request('http://worker/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
  });

  it('propagates upstream error status from Claude', async () => {
    mockFetch.mockResolvedValueOnce(new Response('overloaded', { status: 529 }));
    const res = await worker.fetch(makeRequest('/chat', validChatBody), mockEnv);
    expect(res.status).toBe(529);
  });

  it('includes screenshot as image block in Claude payload when provided', async () => {
    let capturedBody: { messages: Array<{ content: Array<{ type: string }> }> } | null = null;
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return anthropicOk('{"totalSteps":0,"summary":"ok","steps":[]}');
    });

    await worker.fetch(
      makeRequest('/chat', { ...validChatBody, screenshot: 'base64data' }),
      mockEnv,
    );

    const content = capturedBody!.messages[0].content;
    expect(content.some((b: { type: string }) => b.type === 'image')).toBe(true);
  });

  it('omits image block when no screenshot provided', async () => {
    let capturedBody: { messages: Array<{ content: Array<{ type: string }> }> } | null = null;
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return anthropicOk('{"totalSteps":0,"summary":"ok","steps":[]}');
    });

    await worker.fetch(makeRequest('/chat', validChatBody), mockEnv);

    const content = capturedBody!.messages[0].content;
    expect(content.every((b: { type: string }) => b.type !== 'image')).toBe(true);
  });
});

// ---- POST /tts ----

describe('POST /tts', () => {
  it('streams audio with correct content-type on success', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const res = await worker.fetch(makeRequest('/tts', { text: 'Hello SheetBuddy' }), mockEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('uses custom voice ID from env when set', async () => {
    let capturedUrl = '';
    mockFetch.mockImplementationOnce(async (url: string) => {
      capturedUrl = url;
      return new Response(new Uint8Array([0]), { status: 200 });
    });

    await worker.fetch(
      makeRequest('/tts', { text: 'Hello' }),
      { ...mockEnv, ELEVENLABS_VOICE_ID: 'custom-voice-xyz' },
    );

    expect(capturedUrl).toContain('custom-voice-xyz');
  });

  it('uses default voice ID when env voice not set', async () => {
    let capturedUrl = '';
    mockFetch.mockImplementationOnce(async (url: string) => {
      capturedUrl = url;
      return new Response(new Uint8Array([0]), { status: 200 });
    });

    await worker.fetch(makeRequest('/tts', { text: 'Hello' }), mockEnv);

    expect(capturedUrl).toContain('JBFqnCBsd6RMkjVDRZzb');
  });

  it('returns 400 when text is missing', async () => {
    const res = await worker.fetch(makeRequest('/tts', {}), mockEnv);
    expect(res.status).toBe(400);
  });

  it('propagates upstream error status from ElevenLabs', async () => {
    mockFetch.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const res = await worker.fetch(makeRequest('/tts', { text: 'Hello' }), mockEnv);
    expect(res.status).toBe(429);
  });
});

// ---- POST /transcribe-token ----

describe('POST /transcribe-token', () => {
  it('returns token on success', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'aai-tok-123' }), { status: 200 }),
    );

    const res = await worker.fetch(makeRequest('/transcribe-token', {}), mockEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({ token: 'aai-tok-123' });
  });

  it('propagates upstream error status from AssemblyAI', async () => {
    mockFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const res = await worker.fetch(makeRequest('/transcribe-token', {}), mockEnv);
    expect(res.status).toBe(401);
  });
});
