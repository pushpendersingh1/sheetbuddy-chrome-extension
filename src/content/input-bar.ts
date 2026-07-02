import { observeGridAnchor } from './grid-anchor';

const STYLES = `
  :host {
    position: fixed;
    bottom: 128px;
    right: 72px;
    width: 420px;
    z-index: 2147483647;
    pointer-events: none;
    display: block;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #fff;
    border: 1px solid #dadce0;
    border-radius: 24px;
    padding: 8px 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    pointer-events: auto;
  }

  .mic-btn {
    flex-shrink: 0;
    background: none;
    border: 1px solid #dadce0;
    border-radius: 20px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
    color: #3c4043;
  }

  .mic-btn--preparing {
    background: #e8f0fe;
    border-color: #4285f4;
    color: #4285f4;
    cursor: default;
    animation: pulse-border 1s ease-in-out infinite;
  }

  @keyframes pulse-border {
    0%, 100% { border-color: #4285f4; opacity: 1; }
    50%       { border-color: #aecbfa; opacity: 0.7; }
  }

  .mic-btn--recording {
    background: #fce8e6;
    border-color: #ea4335;
    color: #ea4335;
  }

  .text-input {
    flex: 1;
    border: none;
    outline: none;
    font-size: 14px;
    font-family: inherit;
    background: transparent;
    color: #202124;
    min-width: 0;
  }

  .text-input:read-only {
    color: #5f6368;
  }

  .send-btn {
    flex-shrink: 0;
    background: #4285f4;
    color: #fff;
    border: none;
    border-radius: 50%;
    width: 32px;
    height: 32px;
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .send-btn:hover {
    background: #1a73e8;
  }

  .usage-count {
    display: none;
    width: max-content;
    margin: 6px 12px 0 auto;
    padding: 2px 10px;
    font-size: 11px;
    color: #5f6368;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid #dadce0;
    border-radius: 10px;
    pointer-events: none;
  }
`;

export class InputBar {
  private host: HTMLElement;
  private bar: HTMLDivElement;
  private micBtn: HTMLButtonElement;
  private textInput: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private usageLabel: HTMLDivElement;
  private isRecording = false;
  private isOpen = false;

  onStartRecording: (() => void) | null = null;
  onStopRecording: (() => void) | null = null;
  onQuery: ((text: string) => void) | null = null;
  onDismiss: (() => void) | null = null;
  // Fires every time the bar opens — lets the content script refresh the
  // free-tier remaining count (via setRemaining) with a fresh storage read.
  onOpen: (() => void) | null = null;
  // Elements that should not trigger dismiss on mousedown (e.g. the creature host
  // that has its own click→toggle handler — mousedown would race with click).
  dismissExclusions: Element[] = [];

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'sheetbuddy-input-host';
    const shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.appendChild(style);

    this.bar = document.createElement('div');
    this.bar.className = 'bar';
    this.bar.style.display = 'none';

    this.micBtn = document.createElement('button');
    this.micBtn.type = 'button';
    this.micBtn.className = 'mic-btn';
    this.micBtn.textContent = '🎙 Tap to speak';

    this.textInput = document.createElement('input');
    this.textInput.type = 'text';
    this.textInput.className = 'text-input';
    this.textInput.placeholder = 'Type your question...';

    this.sendBtn = document.createElement('button');
    this.sendBtn.type = 'button';
    this.sendBtn.className = 'send-btn';
    this.sendBtn.textContent = '→';

    this.bar.appendChild(this.micBtn);
    this.bar.appendChild(this.textInput);
    this.bar.appendChild(this.sendBtn);
    shadow.appendChild(this.bar);

    this.usageLabel = document.createElement('div');
    this.usageLabel.className = 'usage-count';
    shadow.appendChild(this.usageLabel);

    this.micBtn.addEventListener('click', () => this.toggleRecording());
    this.sendBtn.addEventListener('click', () => this.submit());
    this.textInput.addEventListener('keydown', (e: KeyboardEvent) => {
      // Keyboard events are composed and bubble out of shadow DOM, reaching
      // Sheets' global handlers. Stop them here so e.g. Ctrl+A selects text
      // in the input rather than all cells in the sheet.
      e.stopPropagation();
      if (e.key === 'Enter') this.submit();
      if (e.key === 'Escape') { this.onDismiss?.(); this.close(); }
    });
  }

  mount(): void {
    document.body.appendChild(this.host);
    const GAP = 16;
    const BAR_BOTTOM = 56 + 56 + GAP; // creature bottom (56) + creature height (56) + gap
    observeGridAnchor(rect => {
      const spaceOnRight = window.innerWidth - rect.right;
      this.host.style.right = `${spaceOnRight + GAP}px`;
      this.host.style.bottom = `${BAR_BOTTOM}px`;
    });
    this.attachDismissListeners();
  }

  open(mode: 'voice' | 'text' | 'both'): void {
    this.bar.style.display = 'flex';
    this.isOpen = true;
    if (this.usageLabel.textContent) this.usageLabel.style.display = 'block';
    this.onOpen?.();
    if (mode === 'voice') {
      this.startRecording();
      this.textInput.focus();
    } else if (mode === 'text') {
      this.textInput.focus();
    } else {
      // 'both': show bar with text field focused so user can type immediately
      this.textInput.focus();
    }
  }

  toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open('both');
    }
  }

  close(): void {
    if (this.isRecording) this.stopRecording();
    this.unlockField(); // always reset to editable when bar is closed
    this.bar.style.display = 'none';
    this.usageLabel.style.display = 'none';
    this.textInput.value = '';
    this.isOpen = false;
  }

  // The label renders whatever the last setRemaining call said — it does not
  // subscribe to storage, so callers must refresh it on every open (see onOpen).
  setRemaining(count: number): void {
    this.usageLabel.textContent =
      count === 0 ? 'No free interactions left today'
      : count === 1 ? '1 free interaction left today'
      : `${count} free interactions left today`;
    if (this.isOpen) this.usageLabel.style.display = 'block';
  }

  setTranscript(text: string): void {
    this.textInput.value = text;
  }

  lockField(): void {
    this.textInput.readOnly = true;
  }

  unlockField(): void {
    this.textInput.readOnly = false;
  }

  private startRecording(): void {
    this.isRecording = true;
    // Show preparing state immediately — mic + token aren't ready yet.
    // setMicReady() transitions this to the active recording state.
    this.micBtn.classList.add('mic-btn--preparing');
    this.micBtn.textContent = 'Starting...';
    this.micBtn.disabled = true;
    this.lockField();
    this.onStartRecording?.();
  }

  /** Called by the content script once START_RECORDING confirms the mic is live. */
  setMicReady(): void {
    if (!this.isRecording) return; // bar was closed before mic was ready
    this.micBtn.classList.remove('mic-btn--preparing');
    this.micBtn.classList.add('mic-btn--recording');
    this.micBtn.textContent = 'Stop';
    this.micBtn.disabled = false;
  }

  /** Called by the content script if START_RECORDING fails — resets to idle. */
  setMicError(): void {
    this.isRecording = false;
    this.micBtn.classList.remove('mic-btn--preparing', 'mic-btn--recording');
    this.micBtn.textContent = '🎙 Tap to speak';
    this.micBtn.disabled = false;
    this.unlockField();
  }

  private stopRecording(): void {
    this.isRecording = false;
    this.micBtn.classList.remove('mic-btn--preparing', 'mic-btn--recording');
    this.micBtn.textContent = '🎙 Tap to speak';
    this.micBtn.disabled = false;
    this.onStopRecording?.();
  }

  private toggleRecording(): void {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private submit(): void {
    const text = this.textInput.value.trim();
    if (!text) return;
    this.onQuery?.(text);
    this.close();
  }

  private attachDismissListeners(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.onDismiss?.();
        this.close();
      }
    });

    document.addEventListener('mousedown', (e: MouseEvent) => {
      if (!this.isOpen) return;
      const path = e.composedPath();
      const inBar = path.includes(this.host);
      const inExcluded = this.dismissExclusions.some(el => path.includes(el));
      if (!inBar && !inExcluded) {
        this.onDismiss?.();
        this.close();
      }
    });
  }

}
