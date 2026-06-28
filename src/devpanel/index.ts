import type { PrimitiveResult, RunPrimitivePayload } from '../types/messages';

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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  if (!tab.url?.includes('docs.google.com/spreadsheets')) {
    throw new Error('Active tab is not a Google Sheet');
  }
  return tab;
}

// ─── Run an isolated-world primitive via content script ───────────────────────

async function runPrimitive(name: string, args: unknown[] = []): Promise<PrimitiveResult> {
  const tab = await getSheetsTab();
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

// ─── Button wiring ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Re-wire clear button properly
  const clearBtn = document.getElementById('clear-btn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      Array.from(output.querySelectorAll('.log')).forEach((el) => el.remove());
    };
  }

  document.querySelectorAll<HTMLButtonElement>('button[data-fn]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const fnName = btn.dataset.fn!;
      const isMain = btn.dataset.world === 'main';
      let args: unknown[] = [];

      // Resolve args from various data attributes
      if (btn.dataset.args) {
        args = JSON.parse(btn.dataset.args) as unknown[];
      } else if (btn.dataset.inputStart && btn.dataset.inputEnd) {
        const start = (document.getElementById(btn.dataset.inputStart) as HTMLInputElement).value;
        const end = (document.getElementById(btn.dataset.inputEnd) as HTMLInputElement).value;
        args = [start, end];
      } else if (btn.dataset.input) {
        const val = (document.getElementById(btn.dataset.input) as HTMLInputElement).value;
        args = [val];
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
