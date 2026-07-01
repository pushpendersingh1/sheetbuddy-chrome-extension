import { observeGridAnchor } from './grid-anchor';

type CreatureState = 'idle' | 'active' | 'paused' | 'listening' | 'thinking';

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

  .creature--listening {
    animation: float 3s ease-in-out infinite, pulse-mic 0.8s ease-in-out infinite;
  }

  .creature--thinking {
    animation: float 3s ease-in-out infinite, spin-glow 1.5s linear infinite;
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50%       { transform: translateY(-7px); }
  }

  @keyframes glow {
    0%, 100% { filter: drop-shadow(0 0 4px rgba(66, 133, 244, 0.5)); }
    50%       { filter: drop-shadow(0 0 14px rgba(66, 133, 244, 1)); }
  }

  @keyframes pulse-mic {
    0%, 100% { filter: drop-shadow(0 0 6px rgba(234, 67, 53, 0.7)); }
    50%       { filter: drop-shadow(0 0 16px rgba(234, 67, 53, 1)); }
  }

  @keyframes spin-glow {
    0%, 100% { filter: drop-shadow(0 0 8px rgba(66, 133, 244, 0.7)); }
    50%       { filter: drop-shadow(0 0 18px rgba(66, 133, 244, 1)); }
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

  onClick: (() => void) | null = null;

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
    this.el.addEventListener('click', () => this.onClick?.());
    shadow.appendChild(this.el);
  }

  mount(): void {
    document.body.appendChild(this.host);
    const GAP = 16;
    observeGridAnchor(rect => {
      const spaceOnRight = window.innerWidth - rect.right;
      this.host.style.right = `${spaceOnRight + GAP}px`;
    });
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
