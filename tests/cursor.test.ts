import { describe, it, expect, beforeEach } from 'vitest';
import { SheetBuddyCursor } from '../src/content/cursor';

// jsdom doesn't do real layout, so offsetWidth/offsetHeight are always 0
// unless mocked — these tests stub them per-case to simulate the label's
// rendered size when checking whether it overflows the viewport.
function stubLabelSize(label: HTMLElement, size: { width: number; height: number }): void {
  Object.defineProperty(label, 'offsetWidth', { configurable: true, value: size.width });
  Object.defineProperty(label, 'offsetHeight', { configurable: true, value: size.height });
}

describe('SheetBuddyCursor', () => {
  let cursor: SheetBuddyCursor;

  beforeEach(() => {
    document.body.innerHTML = '';
    cursor = new SheetBuddyCursor();
  });

  it('mount() appends the host element to document.body', () => {
    cursor.mount();
    expect(document.body.querySelector('#sheetbuddy-cursor-host')).not.toBeNull();
  });

  it('host has an open shadow root', () => {
    cursor.mount();
    const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
    expect(host.shadowRoot).not.toBeNull();
  });

  it('shadow root contains a <style> element', () => {
    cursor.mount();
    const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
    expect(host.shadowRoot!.querySelector('style')).not.toBeNull();
  });

  it('shadow root contains an arrow (svg) and a label element', () => {
    cursor.mount();
    const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
    expect(host.shadowRoot!.querySelector('svg.arrow')).not.toBeNull();
    expect(host.shadowRoot!.querySelector('.label')).not.toBeNull();
  });

  it('isVisible() defaults to false', () => {
    expect(cursor.isVisible()).toBe(false);
  });

  it('hasLandedOnCell() defaults to false', () => {
    expect(cursor.hasLandedOnCell()).toBe(false);
  });

  describe('show/hide', () => {
    beforeEach(() => { cursor.mount(); });

    it('show() makes the cursor visible', () => {
      cursor.show();
      expect(cursor.isVisible()).toBe(true);
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      expect(host.style.opacity).toBe('1');
    });

    it('hide() makes the cursor invisible', () => {
      cursor.show();
      cursor.hide();
      expect(cursor.isVisible()).toBe(false);
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      expect(host.style.opacity).toBe('0');
    });

    it('hide() resets hasLandedOnCell() to false, so a later run starts fresh', () => {
      cursor.moveTo({ x: 0, y: 0, width: 10, height: 10 });
      expect(cursor.hasLandedOnCell()).toBe(true);
      cursor.hide();
      expect(cursor.hasLandedOnCell()).toBe(false);
    });
  });

  describe('showAtHome', () => {
    beforeEach(() => { cursor.mount(); });

    it('snaps position to the given point and becomes visible', () => {
      cursor.showAtHome({ x: 500, y: 700 });
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      expect(host.style.left).toBe('500px');
      expect(host.style.top).toBe('700px');
      expect(cursor.isVisible()).toBe(true);
    });

    it('does not mark the cursor as landed on a cell', () => {
      cursor.showAtHome({ x: 0, y: 0 });
      expect(cursor.hasLandedOnCell()).toBe(false);
    });
  });

  describe('moveTo', () => {
    beforeEach(() => { cursor.mount(); });

    it('positions the arrow tip at the center of the given rect', () => {
      cursor.moveTo({ x: 45, y: 165, width: 102, height: 22 });
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      expect(host.style.left).toBe('96px'); // 45 + 102/2
      expect(host.style.top).toBe('176px'); // 165 + 22/2
    });

    it('marks the cursor as landed on a cell', () => {
      cursor.moveTo({ x: 0, y: 0, width: 10, height: 10 });
      expect(cursor.hasLandedOnCell()).toBe(true);
    });

    it('does not change visibility when moving', () => {
      cursor.moveTo({ x: 0, y: 0, width: 10, height: 10 });
      expect(cursor.isVisible()).toBe(false);
    });
  });

  describe('showLabel/hideLabel', () => {
    beforeEach(() => { cursor.mount(); });

    it('showLabel sets the label element text', () => {
      cursor.showLabel('Typing formula into B7');
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      expect(label.textContent).toBe('Typing formula into B7');
    });

    it('hideLabel clears the label element text', () => {
      cursor.showLabel('Selecting B7');
      cursor.hideLabel();
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      expect(label.textContent).toBe('');
    });

    it('does not flip when the label fits within the viewport', () => {
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      stubLabelSize(label, { width: 50, height: 20 });
      cursor.moveTo({ x: 100, y: 100, width: 0, height: 0 });

      cursor.showLabel('Selecting B7');

      expect(label.classList.contains('flip-x')).toBe(false);
      expect(label.classList.contains('flip-y')).toBe(false);
    });

    it('flips horizontally when the label would overflow the right edge (e.g. a cell near the right of the sheet)', () => {
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      stubLabelSize(label, { width: 200, height: 20 });
      // arrow tip at x=900: 900 + 18 (offset) + 200 (label width) = 1118 > jsdom's default innerWidth (1024)
      cursor.moveTo({ x: 892, y: 100, width: 16, height: 8 });

      cursor.showLabel('Navigating to cell Z1000 now.');

      expect(label.classList.contains('flip-x')).toBe(true);
      expect(label.classList.contains('flip-y')).toBe(false);
    });

    it('flips vertically when the label would overflow the bottom edge', () => {
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      stubLabelSize(label, { width: 50, height: 100 });
      // arrow tip at y=700: 700 + 16 (offset) + 100 (label height) = 816 > jsdom's default innerHeight (768)
      cursor.moveTo({ x: 100, y: 692, width: 16, height: 8 });

      cursor.showLabel('Committing the value now.');

      expect(label.classList.contains('flip-x')).toBe(false);
      expect(label.classList.contains('flip-y')).toBe(true);
    });

    it('flips both ways when the label would overflow the bottom-right corner', () => {
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      stubLabelSize(label, { width: 200, height: 100 });
      cursor.moveTo({ x: 892, y: 692, width: 16, height: 8 });

      cursor.showLabel('Selecting the final cell in the bottom-right corner.');

      expect(label.classList.contains('flip-x')).toBe(true);
      expect(label.classList.contains('flip-y')).toBe(true);
    });

    it('clears a previous flip once a new position no longer overflows', () => {
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      stubLabelSize(label, { width: 200, height: 20 });
      cursor.moveTo({ x: 892, y: 100, width: 16, height: 8 });
      cursor.showLabel('Near the edge');
      expect(label.classList.contains('flip-x')).toBe(true);

      cursor.moveTo({ x: 100, y: 100, width: 16, height: 8 });
      cursor.showLabel('Back in the middle');
      expect(label.classList.contains('flip-x')).toBe(false);
    });

    it('re-checks overflow using the target position, not a stale mid-transition DOM read, when a label is shown right after moveTo()', () => {
      // Regression test: showLabel() used to read this.labelEl.getBoundingClientRect()
      // synchronously right after moveTo() set a new (CSS-transitioning) host
      // position. That raced the transition and reported the arrow's PREVIOUS
      // location, so a label near the edge was measured as fitting when it
      // didn't. updateLabelPosition() must use the known target x/y instead.
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      stubLabelSize(label, { width: 200, height: 20 });

      cursor.showAtHome({ x: 100, y: 100 }); // starts near the left edge
      cursor.moveTo({ x: 892, y: 100, width: 16, height: 8 }); // then jumps to the right edge
      cursor.showLabel('Now typing into the cell.'); // narration shown immediately after landing

      expect(label.classList.contains('flip-x')).toBe(true);
    });
  });
});
