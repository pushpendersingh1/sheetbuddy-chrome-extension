type CreatureState = 'idle' | 'active' | 'paused';

const STYLES = `
  :host {
    position: fixed;
    bottom: 56px;
    right: 72px;
    width: 56px;
    height: 56px;
    z-index: 2147483647;
    pointer-events: none;
    display: block;
  }

  .creature {
    width: 56px;
    height: 56px;
    cursor: pointer;
    pointer-events: auto;
    animation: float 3s ease-in-out infinite;
    transition: opacity 0.3s ease, filter 0.3s ease;
  }

  .creature--active {
    animation: float 3s ease-in-out infinite, glow 1s ease-in-out infinite;
  }

  .creature--paused {
    animation: none;
    opacity: 0.35;
    filter: grayscale(70%);
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50%       { transform: translateY(-7px); }
  }

  @keyframes glow {
    0%, 100% { filter: drop-shadow(0 0 4px rgba(66, 133, 244, 0.5)); }
    50%       { filter: drop-shadow(0 0 14px rgba(66, 133, 244, 1)); }
  }
`;

const SVG = `<svg width="56" height="56" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
  <circle cx="28" cy="28" r="24" fill="#4285F4"/>
  <circle cx="20" cy="25" r="5.5" fill="white"/>
  <circle cx="36" cy="25" r="5.5" fill="white"/>
  <circle cx="21" cy="26.5" r="2.8" fill="#202124"/>
  <circle cx="37" cy="26.5" r="2.8" fill="#202124"/>
  <circle cx="22.2" cy="24.5" r="1.2" fill="white"/>
  <circle cx="38.2" cy="24.5" r="1.2" fill="white"/>
  <path d="M21 35 Q28 42 35 35" stroke="white" stroke-width="2.5" fill="none" stroke-linecap="round"/>
</svg>`;

export class SheetBuddyCreature {
  private host: HTMLElement;
  private el: HTMLElement;
  private state: CreatureState = 'idle';

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'sheetbuddy-creature-host';
    const shadow = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.appendChild(style);

    this.el = document.createElement('div');
    this.el.className = 'creature';
    this.el.innerHTML = SVG;
    this.el.addEventListener('click', () => console.log('input bar triggered'));
    shadow.appendChild(this.el);
  }

  mount(): void {
    document.body.appendChild(this.host);
    this.observeLayout();
  }

  private observeLayout(): void {
    // Sheets shrinks its grid container when the sidebar opens; observe that
    // element so we can reposition without polling.
    const GRID_SELECTORS = [
      '#waffle-grid-container',
      '#waffle-scrollable-wrapper',
      '.grid-scrollable-wrapper',
    ];
    const anchor =
      GRID_SELECTORS.map(s => document.querySelector<HTMLElement>(s)).find(Boolean)
      ?? document.body;

    const GAP = 16;
    let rafId = 0;

    const reposition = () => {
      rafId = 0;
      const spaceOnRight = window.innerWidth - anchor.getBoundingClientRect().right;
      this.host.style.right = `${spaceOnRight + GAP}px`;
    };

    // Run once immediately so the initial position is layout-accurate.
    reposition();

    new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(reposition);
    }).observe(anchor);
  }

  setState(state: CreatureState): void {
    if (this.state === state) return;
    this.state = state;
    this.el.className = state === 'idle' ? 'creature' : `creature creature--${state}`;
  }

  getState(): CreatureState {
    return this.state;
  }
}
