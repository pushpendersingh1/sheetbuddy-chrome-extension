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
    /* width:max-content (not just max-width) so the box sizes to its own
       content instead of shrink-to-fit against the :host's containing block
       (which has no explicit width here, but nested shadow-DOM positioning
       can still collapse this without it — see creature.ts's .bubble for the
       version where the host's own explicit width made this collapse for
       real). white-space:normal (not nowrap) so long narration sentences
       wrap across lines instead of truncating with an ellipsis. */
    width: max-content;
    max-width: 260px;
    padding: 4px 8px;
    background: #10B981;
    color: #fff;
    font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    border-radius: 4px;
    white-space: normal;
    word-wrap: break-word;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .label:not(:empty) {
    opacity: 1;
  }

  /* Flips applied in JS (see updateLabelPosition) once the label's rendered
     position would overflow the viewport — e.g. a target cell near the
     right or bottom edge of the screen. */
  .label.flip-x {
    left: auto;
    right: 18px;
  }

  .label.flip-y {
    top: auto;
    bottom: 16px;
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
  // The arrow's current/target x,y — tracked in JS rather than re-derived
  // via getBoundingClientRect() because the host's position transitions
  // over 0.3s; reading layout synchronously right after setting a new
  // left/top would race that transition (see updateLabelPosition()).
  private x = 0;
  private y = 0;

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
    this.x = point.x;
    this.y = point.y;
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
    this.x = rect.x + rect.width / 2;
    this.y = rect.y + rect.height / 2;
    this.host.style.left = `${this.x}px`;
    this.host.style.top = `${this.y}px`;
    this.updateLabelPosition();
  }

  showLabel(text: string): void {
    this.labelEl.textContent = text;
    this.updateLabelPosition();
  }

  hideLabel(): void {
    this.labelEl.textContent = '';
  }

  // Flips the label to the opposite side of the arrow when its default
  // position (right + below the tip) would render it off-screen — e.g. a
  // target cell near the right or bottom edge. Mirrors Clicky's own
  // repositionPanelNearCursor(), which does the same edge-flip for its
  // cursor-following response overlay.
  //
  // Computed arithmetically from the arrow's known target x/y and the
  // label's own offsetWidth/offsetHeight rather than
  // this.labelEl.getBoundingClientRect() — the host's left/top transitions
  // over 0.3s, and moveTo() followed immediately by showLabel() (the normal
  // sequence: cursor lands on a cell, then that step's narration shows)
  // reads the label's rect mid-transition, before the browser has committed
  // the new host position. That raced read reports the arrow's *previous*
  // location, so a label near the right/bottom edge was measured as if it
  // were still safely inside the viewport. The label's own dimensions
  // aren't affected by the host's position transition, so offsetWidth/
  // offsetHeight are safe to read synchronously.
  private updateLabelPosition(): void {
    this.labelEl.classList.remove('flip-x', 'flip-y');
    if (!this.labelEl.textContent) return;
    const width = this.labelEl.offsetWidth;
    const height = this.labelEl.offsetHeight;
    const LABEL_LEFT = 18;
    const LABEL_TOP = 16;
    if (this.x + LABEL_LEFT + width > window.innerWidth) this.labelEl.classList.add('flip-x');
    if (this.y + LABEL_TOP + height > window.innerHeight) this.labelEl.classList.add('flip-y');
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

