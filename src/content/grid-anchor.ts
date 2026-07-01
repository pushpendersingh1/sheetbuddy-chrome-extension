const GRID_SELECTORS = [
  '#waffle-grid-container',
  '#waffle-scrollable-wrapper',
  '.grid-scrollable-wrapper',
];

// Sheets shrinks its grid container when the sidebar opens; observe that
// element so fixed-position widgets can reposition without polling.
export function observeGridAnchor(onReposition: (rect: DOMRect) => void): void {
  const anchor =
    GRID_SELECTORS.map(s => document.querySelector<HTMLElement>(s)).find(Boolean)
    ?? document.body;

  let rafId = 0;

  const reposition = () => {
    rafId = 0;
    onReposition(anchor.getBoundingClientRect());
  };

  // Run once immediately so the initial position is layout-accurate.
  reposition();

  new ResizeObserver(() => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(reposition);
  }).observe(anchor);
}
