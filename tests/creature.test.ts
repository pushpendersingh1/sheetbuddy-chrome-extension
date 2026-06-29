import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SheetBuddyCreature } from '../src/content/creature';

// jsdom does not implement ResizeObserver — stub it so mount() doesn't throw.
// We test that the observer is set up (creature doesn't crash) implicitly via
// the mount() tests; the reposition math is a browser-layout concern.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });

describe('SheetBuddyCreature', () => {
  let creature: SheetBuddyCreature;

  beforeEach(() => {
    document.body.innerHTML = '';
    creature = new SheetBuddyCreature();
  });

  it('mount() appends the host element to document.body', () => {
    creature.mount();
    expect(document.body.querySelector('#sheetbuddy-creature-host')).not.toBeNull();
  });

  it('host has an open shadow root', () => {
    creature.mount();
    const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
    expect(host.shadowRoot).not.toBeNull();
  });

  it('shadow root contains a <style> element', () => {
    creature.mount();
    const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
    expect(host.shadowRoot!.querySelector('style')).not.toBeNull();
  });

  it('shadow root contains a .creature element', () => {
    creature.mount();
    const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
    expect(host.shadowRoot!.querySelector('.creature')).not.toBeNull();
  });

  it('getState() defaults to idle', () => {
    expect(creature.getState()).toBe('idle');
  });

  describe('setState', () => {
    beforeEach(() => { creature.mount(); });

    it('transitions to active: getState returns active and creature--active class is added', () => {
      creature.setState('active');
      expect(creature.getState()).toBe('active');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(el.classList.contains('creature--active')).toBe(true);
    });

    it('transitions to paused: getState returns paused and creature--paused class is added', () => {
      creature.setState('paused');
      expect(creature.getState()).toBe('paused');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(el.classList.contains('creature--paused')).toBe(true);
    });

    it('returns to idle from active: creature--active class is removed', () => {
      creature.setState('active');
      creature.setState('idle');
      expect(creature.getState()).toBe('idle');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(el.classList.contains('creature--active')).toBe(false);
    });

    it('returns to idle from paused: creature--paused class is removed', () => {
      creature.setState('paused');
      creature.setState('idle');
      expect(creature.getState()).toBe('idle');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(el.classList.contains('creature--paused')).toBe(false);
    });

    it('same-state call is a no-op: className does not change', () => {
      creature.setState('active');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      const before = el.className;
      creature.setState('active');
      expect(el.className).toBe(before);
    });
  });

  describe('click', () => {
    it('logs "input bar triggered" when creature element is clicked', () => {
      creature.mount();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      el.click();
      expect(spy).toHaveBeenCalledWith('input bar triggered');
      spy.mockRestore();
    });
  });
});
