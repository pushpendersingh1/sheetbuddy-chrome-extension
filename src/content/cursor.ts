import type { CellRect } from '../types/messages';

// Do NOT reuse grid-anchor.ts here — that observes a stable container via
// ResizeObserver; the cursor's position is per-step, driven by the execution
// engine against a target cell/range's rect, not layout-shift anchoring.
const STYLES = `
  :host {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 2147483647;
    pointer-events: none;
    display: block;
    opacity: 0;
    transition: left 0.3s ease, top 0.3s ease, opacity 0.2s ease;
  }

  .wrap {
    position: relative;
  }

  .arrow {
    display: block;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
  }

  .label {
    position: absolute;
    left: 18px;
    top: 16px;
    max-width: 220px;
    padding: 4px 8px;
    background: #10B981;
    color: #fff;
    font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    border-radius: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .label:not(:empty) {
    opacity: 1;
  }
`;

// A tilted arrow pointer with its hotspot at the tip (top-left of the glyph) —
// the same visual language as collaborative cursors (Figma, Google Docs):
// a colored arrow plus a name-tag label, so it reads as "someone is pointing
// here" rather than a selection highlight.
const ARROW_SVG = `<svg class="arrow" width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
  <path d="M1 1 L1 15.5 L5 12 L7.8 18 L10.4 16.8 L7.6 10.8 L13 10.8 Z" fill="#10B981" stroke="white" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`;

export class SheetBuddyCursor {
  private host: HTMLElement;
  private labelEl: HTMLElement;
  private visible = false;
  private landed = false;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'sheetbuddy-cursor-host';
    const shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = ARROW_SVG;
    shadow.appendChild(wrap);

    this.labelEl = document.createElement('div');
    this.labelEl.className = 'label';
    wrap.appendChild(this.labelEl);
  }

  mount(): void {
    document.body.appendChild(this.host);
  }

  // Snaps (no transition) to a resting point — the creature's position — and
  // becomes visible there. Called at task start, before any cell is known, so
  // the first real moveTo() visibly flies FROM the creature rather than
  // teleporting in already at the target.
  showAtHome(point: { x: number; y: number }): void {
    this.landed = false;
    this.host.style.transition = 'none';
    this.host.style.left = `${point.x}px`;
    this.host.style.top = `${point.y}px`;
    void this.host.offsetHeight; // force reflow so the snap applies before re-enabling transition
    this.host.style.transition = '';
    this.show();
  }

  // Animates the arrow's tip to the center of the target cell/range.
  moveTo(rect: CellRect): void {
    this.landed = true;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    this.host.style.left = `${x}px`;
    this.host.style.top = `${y}px`;
  }

  showLabel(text: string): void {
    this.labelEl.textContent = text;
  }

  hideLabel(): void {
    this.labelEl.textContent = '';
  }

  show(): void {
    this.visible = true;
    this.host.style.opacity = '1';
  }

  hide(): void {
    this.visible = false;
    this.landed = false;
    this.host.style.opacity = '0';
    this.hideLabel();
  }

  isVisible(): boolean {
    return this.visible;
  }

  // Whether the cursor currently sits at a confirmed cell (vs. still at its
  // creature "home" position) — content/index.ts uses this to decide whether
  // narration text attaches to the cursor or to the creature.
  hasLandedOnCell(): boolean {
    return this.landed;
  }
}
