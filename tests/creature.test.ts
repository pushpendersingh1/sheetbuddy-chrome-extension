import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SheetBuddyCreature } from '../src/content/creature';
import { installResizeObserverStub } from './support/resize-observer-stub';

// jsdom does not implement ResizeObserver — stub it so mount() doesn't throw.
// We test that the observer is set up (creature doesn't crash) implicitly via
// the mount() tests; the reposition math is grid-anchor.test.ts's concern.
installResizeObserverStub();

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

    it('transitions to listening: getState returns listening and creature--listening class is added', () => {
      creature.setState('listening');
      expect(creature.getState()).toBe('listening');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(el.classList.contains('creature--listening')).toBe(true);
    });

    it('transitions to thinking: getState returns thinking and creature--thinking class is added', () => {
      creature.setState('thinking');
      expect(creature.getState()).toBe('thinking');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(el.classList.contains('creature--thinking')).toBe(true);
    });

    it('returns to idle from listening: creature--listening class is removed', () => {
      creature.setState('listening');
      creature.setState('idle');
      expect(creature.getState()).toBe('idle');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(el.classList.contains('creature--listening')).toBe(false);
    });

    it('returns to idle from thinking: creature--thinking class is removed', () => {
      creature.setState('thinking');
      creature.setState('idle');
      expect(creature.getState()).toBe('idle');
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(el.classList.contains('creature--thinking')).toBe(false);
    });
  });

  describe('onClick', () => {
    beforeEach(() => { creature.mount(); });

    it('calls onClick callback when creature element is clicked', () => {
      let called = false;
      creature.onClick = () => { called = true; };
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      el.click();
      expect(called).toBe(true);
    });

    it('does not throw when onClick is null', () => {
      creature.onClick = null;
      const host = document.body.querySelector('#sheetbuddy-creature-host') as HTMLElement;
      const el = host.shadowRoot!.querySelector('.creature') as HTMLElement;
      expect(() => el.click()).not.toThrow();
    });
  });
});
