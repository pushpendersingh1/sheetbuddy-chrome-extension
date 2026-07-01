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
`;

export class InputBar {
  private host: HTMLElement;
  private bar: HTMLDivElement;
  private micBtn: HTMLButtonElement;
  private textInput: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private isRecording = false;
  private isOpen = false;

  onStartRecording: (() => void) | null = null;
  onStopRecording: (() => void) | null = null;
  onQuery: ((text: string) => void) | null = null;
  onDismiss: (() => void) | null = null;

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

    this.micBtn.addEventListener('click', () => this.toggleRecording());
    this.sendBtn.addEventListener('click', () => this.submit());
    this.textInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') this.submit();
    });
  }

  mount(): void {
    document.body.appendChild(this.host);
    this.observeLayout();
    this.attachDismissListeners();
  }

  open(mode: 'voice' | 'text' | 'both'): void {
    this.bar.style.display = 'flex';
    this.isOpen = true;
    if (mode === 'voice') {
      this.startRecording();
    } else if (mode === 'text') {
      this.textInput.focus();
    }
  }

  close(): void {
    if (this.isRecording) this.stopRecording();
    this.bar.style.display = 'none';
    this.textInput.value = '';
    this.isOpen = false;
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
    this.micBtn.classList.add('mic-btn--recording');
    this.micBtn.textContent = '⏹ Stop';
    this.lockField();
    this.onStartRecording?.();
  }

  private stopRecording(): void {
    this.isRecording = false;
    this.micBtn.classList.remove('mic-btn--recording');
    this.micBtn.textContent = '🎙 Tap to speak';
    this.unlockField();
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
      if (!path.includes(this.host)) {
        this.onDismiss?.();
        this.close();
      }
    });
  }

  private observeLayout(): void {
    const GRID_SELECTORS = [
      '#waffle-grid-container',
      '#waffle-scrollable-wrapper',
      '.grid-scrollable-wrapper',
    ];
    const anchor =
      GRID_SELECTORS.map(s => document.querySelector<HTMLElement>(s)).find(Boolean)
      ?? document.body;

    const GAP = 16;
    const BAR_BOTTOM = 56 + 56 + GAP; // creature bottom + creature height + gap
    let rafId = 0;

    const reposition = () => {
      rafId = 0;
      const spaceOnRight = window.innerWidth - anchor.getBoundingClientRect().right;
      this.host.style.right = `${spaceOnRight + GAP}px`;
      this.host.style.bottom = `${BAR_BOTTOM}px`;
    };

    reposition();

    new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(reposition);
    }).observe(anchor);
  }
}
