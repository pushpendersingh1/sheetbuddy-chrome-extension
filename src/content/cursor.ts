import type { CellRect } from '../types/messages';

// Do NOT reuse grid-anchor.ts here — that observes a stable container via
// ResizeObserver; the cursor's position is per-step, driven by the execution
// engine against a target cell/range's rect, not layout-shift anchoring.
const STYLES = `
  :host {
    position: fixed;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
    z-index: 2147483647;
    pointer-events: none;
    display: block;
    opacity: 0;
    transition: left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease, opacity 0.2s ease;
  }

  .cursor {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    border: 2px solid #10B981;
    border-radius: 4px;
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
  }
`;

export class SheetBuddyCursor {
  private host: HTMLElement;
  private visible = false;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'sheetbuddy-cursor-host';
    const shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.appendChild(style);

    const el = document.createElement('div');
    el.className = 'cursor';
    shadow.appendChild(el);
  }

  mount(): void {
    document.body.appendChild(this.host);
  }

  moveTo(rect: CellRect): void {
    this.host.style.left = `${rect.x}px`;
    this.host.style.top = `${rect.y}px`;
    this.host.style.width = `${rect.width}px`;
    this.host.style.height = `${rect.height}px`;
  }

  show(): void {
    this.visible = true;
    this.host.style.opacity = '1';
  }

  hide(): void {
    this.visible = false;
    this.host.style.opacity = '0';
  }

  isVisible(): boolean {
    return this.visible;
  }
}
