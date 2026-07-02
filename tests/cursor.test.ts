import { describe, it, expect, beforeEach } from 'vitest';
import { SheetBuddyCursor } from '../src/content/cursor';

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
  });

  describe('moveTo', () => {
    beforeEach(() => { cursor.mount(); });

    it('positions the arrow tip at the center of the given rect', () => {
      cursor.moveTo({ x: 45, y: 165, width: 102, height: 22 }, 'Selecting B7');
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      expect(host.style.left).toBe('96px'); // 45 + 102/2
      expect(host.style.top).toBe('176px'); // 165 + 22/2
    });

    it('sets the label text to the given description', () => {
      cursor.moveTo({ x: 0, y: 0, width: 10, height: 10 }, 'Typing formula into B7');
      const host = document.body.querySelector('#sheetbuddy-cursor-host') as HTMLElement;
      const label = host.shadowRoot!.querySelector('.label') as HTMLElement;
      expect(label.textContent).toBe('Typing formula into B7');
    });

    it('does not change visibility when moving', () => {
      cursor.moveTo({ x: 0, y: 0, width: 10, height: 10 }, 'Selecting A1');
      expect(cursor.isVisible()).toBe(false);
    });
  });
});
