import type { Message, PrimitiveResult, RunPrimitivePayload, TranscriptPayload } from '../types/messages';

// ─── Logging ─────────────────────────────────────────────────────────────────

const output = document.getElementById('output')!;

function log(kind: 'ok' | 'err' | 'info', msg: string): void {
  const el = document.createElement('div');
  el.className = `log ${kind}`;
  el.textContent = `${kind === 'ok' ? '✓' : kind === 'err' ? '✗' : '·'} ${msg}`;
  // Insert after the clear button (first child)
  output.insertBefore(el, output.children[1] ?? null);
}

function showBanner(msg: string): void {
  const banner = document.getElementById('error-banner')!;
  banner.textContent = msg;
  banner.style.display = 'block';
  setTimeout(() => { banner.style.display = 'none'; }, 4000);
}

// ─── Tab helpers ──────────────────────────────────────────────────────────────

async function getSheetsTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/spreadsheets/*' });
  if (tabs.length === 0) throw new Error('No Google Sheets tab found — open a sheet first');
  // Pick the most recently accessed one
  return tabs.reduce((a, b) => ((b.lastAccessed ?? 0) > (a.lastAccessed ?? 0) ? b : a));
}

async function activateSheetsTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.tabs.update(tab.id!, { active: true });
}

// ─── Run an isolated-world primitive via content script ───────────────────────

async function runPrimitive(name: string, args: unknown[] = []): Promise<PrimitiveResult> {
  const tab = await getSheetsTab();
  await activateSheetsTab(tab);
  return new Promise((resolve) => {
    const payload: RunPrimitivePayload = { name, args };
    chrome.tabs.sendMessage(tab.id!, { type: 'RUN_PRIMITIVE', payload }, (result) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(result as PrimitiveResult);
      }
    });
  });
}

// ─── Run a MAIN-world primitive via chrome.scripting ─────────────────────────

async function runMainPrimitive(name: string, args: unknown[] = []): Promise<PrimitiveResult> {
  const tab = await getSheetsTab();
  await activateSheetsTab(tab);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      world: 'MAIN',
      func: (fnName: string, fnArgs: unknown[]) => {
        const sb = (window as unknown as { __sheetbuddy?: Record<string, (...a: unknown[]) => unknown> }).__sheetbuddy;
        if (!sb || typeof sb[fnName] !== 'function') {
          return { ok: false, error: `MAIN-world function "${fnName}" not found — injected.js may not be loaded` };
        }
        return Promise.resolve(sb[fnName](...fnArgs))
          .then((result) => ({ ok: true, result }))
          .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      },
      args: [name, args],
    });
    const result = results[0]?.result as PrimitiveResult | undefined;
    return result ?? { ok: false, error: 'executeScript returned no result' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Send a fire-and-forget message to the active Sheets tab ─────────────────

async function sendCreatureMessage(msgType: string): Promise<void> {
  const tab = await getSheetsTab();
  await activateSheetsTab(tab);
  chrome.tabs.sendMessage(tab.id!, { type: msgType });
  log('info', `→ ${msgType}`);
}

// ─── Button wiring ────────────────────────────────────────────────────────────

// ─── Audio pipeline ───────────────────────────────────────────────────────────

function setMicStatus(recording: boolean): void {
  const status = document.getElementById('mic-status')!;
  const startBtn = document.getElementById('btn-record-start') as HTMLButtonElement;
  const stopBtn = document.getElementById('btn-record-stop') as HTMLButtonElement;
  status.textContent = recording ? '🔴 recording' : '● idle';
  status.style.color = recording ? '#dc2626' : '#6b7280';
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;
}

function appendTranscript(text: string, isFinal: boolean): void {
  const box = document.getElementById('transcript-box')!;
  const placeholder = box.querySelector('span');
  if (placeholder) placeholder.remove();
  const el = document.createElement('div');
  el.style.cssText = `opacity:${isFinal ? '1' : '0.55'}; margin:1px 0;`;
  el.textContent = (isFinal ? '✓ ' : '… ') + text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// Listen for transcripts broadcast by the offscreen document
chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'TRANSCRIPT_PARTIAL' || message.type === 'TRANSCRIPT_FINAL') {
    const { text, isFinal } = (message.payload ?? {}) as TranscriptPayload;
    appendTranscript(text, isFinal);
  }
  if (message.type === 'NARRATION_DONE') {
    log('ok', 'NARRATION_DONE — audio finished');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  // Re-wire clear button properly
  const clearBtn = document.getElementById('clear-btn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      Array.from(output.querySelectorAll('.log')).forEach((el) => el.remove());
    };
  }

  // Audio pipeline buttons
  document.getElementById('btn-record-start')!.addEventListener('click', async () => {
    log('info', 'Requesting mic permission…');
    try {
      // Must be called from a user gesture so Chrome anchors the prompt here
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop()); // permission granted — release immediately
      log('ok', 'Mic permission granted');
    } catch (err) {
      log('err', `Mic permission: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    chrome.runtime.sendMessage({ type: 'START_RECORDING' }, (r: unknown) => {
      const res = r as { ok: boolean; error?: string };
      if (res?.ok) {
        setMicStatus(true);
        log('ok', 'Recording started');
      } else {
        log('err', `START_RECORDING: ${res?.error ?? 'unknown error'}`);
      }
    });
  });

  document.getElementById('btn-record-stop')!.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (r: unknown) => {
      const res = r as { ok: boolean };
      if (res?.ok) {
        setMicStatus(false);
        log('ok', 'Recording stopped');
      }
    });
  });

  document.getElementById('btn-speak')!.addEventListener('click', () => {
    const text = (document.getElementById('tts-text') as HTMLInputElement).value.trim();
    if (!text) return;
    log('info', `SPEAK → "${text}"`);
    chrome.runtime.sendMessage({ type: 'SPEAK', payload: { text } }, (r: unknown) => {
      const res = r as { ok: boolean; error?: string };
      if (res?.ok) {
        log('ok', 'SPEAK → ok');
      } else {
        log('err', `SPEAK → ${res?.error ?? 'unknown error'}`);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('button[data-msg]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const msgType = btn.dataset.msg!;
      btn.disabled = true;
      try {
        await sendCreatureMessage(msgType);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('err', `${msgType}: ${msg}`);
        showBanner(msg);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('button[data-fn]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const fnName = btn.dataset.fn!;
      const isMain = btn.dataset.world === 'main';
      let args: unknown[] = [];

      // Resolve args from various data attributes
      if (btn.dataset.args) {
        args = JSON.parse(btn.dataset.args) as unknown[];
      } else if (btn.dataset.inputMenu && btn.dataset.inputPath) {
        // navigateMenu: first arg = menu name, rest = path items (comma-separated)
        const menu = (document.getElementById(btn.dataset.inputMenu) as HTMLInputElement).value;
        const pathStr = (document.getElementById(btn.dataset.inputPath) as HTMLInputElement).value;
        const path = pathStr.split(',').map((s) => s.trim()).filter(Boolean);
        args = [menu, ...path];
      } else if (btn.dataset.inputStart && btn.dataset.inputEnd) {
        const start = (document.getElementById(btn.dataset.inputStart) as HTMLInputElement).value;
        const end = (document.getElementById(btn.dataset.inputEnd) as HTMLInputElement).value;
        args = [start, end];
      } else if (btn.dataset.input) {
        const val = (document.getElementById(btn.dataset.input) as HTMLInputElement).value;
        args = [val];
        if (btn.dataset.overwrite) args = [...args, { overwrite: true }];
      }

      log('info', `${fnName}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
      btn.disabled = true;

      try {
        const res = isMain
          ? await runMainPrimitive(fnName, args)
          : await runPrimitive(fnName, args);

        if (res.ok) {
          log('ok', `${fnName} → ${JSON.stringify(res.result)}`);
        } else {
          log('err', `${fnName} → ${res.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('err', `${fnName} threw: ${msg}`);
        showBanner(msg);
      } finally {
        btn.disabled = false;
      }
    });
  });
});
