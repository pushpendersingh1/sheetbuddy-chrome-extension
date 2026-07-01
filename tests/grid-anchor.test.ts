import { describe, it, expect, beforeEach, vi } from 'vitest';
import { observeGridAnchor } from '../src/content/grid-anchor';
import { installResizeObserverStub, ResizeObserverStub } from './support/resize-observer-stub';

describe('observeGridAnchor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installResizeObserverStub();
  });

  it('calls onReposition once immediately, before any resize', () => {
    const onReposition = vi.fn();

    observeGridAnchor(onReposition);

    expect(onReposition).toHaveBeenCalledTimes(1);
    expect(onReposition).toHaveBeenCalledWith(expect.objectContaining({ top: 0, left: 0, right: 0, bottom: 0 }));
  });

  it('resolves #waffle-grid-container when present', () => {
    const grid = document.createElement('div');
    grid.id = 'waffle-grid-container';
    const getRectSpy = vi.spyOn(grid, 'getBoundingClientRect');
    document.body.appendChild(grid);

    observeGridAnchor(vi.fn());

    expect(getRectSpy).toHaveBeenCalled();
  });

  it('falls back to #waffle-scrollable-wrapper when the grid container is absent', () => {
    const wrapper = document.createElement('div');
    wrapper.id = 'waffle-scrollable-wrapper';
    const getRectSpy = vi.spyOn(wrapper, 'getBoundingClientRect');
    document.body.appendChild(wrapper);

    observeGridAnchor(vi.fn());

    expect(getRectSpy).toHaveBeenCalled();
  });

  it('falls back to .grid-scrollable-wrapper when neither #waffle selector is present', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'grid-scrollable-wrapper';
    const getRectSpy = vi.spyOn(wrapper, 'getBoundingClientRect');
    document.body.appendChild(wrapper);

    observeGridAnchor(vi.fn());

    expect(getRectSpy).toHaveBeenCalled();
  });

  it('falls back to document.body when no known selector matches', () => {
    const getRectSpy = vi.spyOn(document.body, 'getBoundingClientRect');

    observeGridAnchor(vi.fn());

    expect(getRectSpy).toHaveBeenCalled();
  });

  it('calls onReposition again when the observed anchor resizes', () => {
    const onReposition = vi.fn();

    observeGridAnchor(onReposition);
    onReposition.mockClear();
    ResizeObserverStub.instances[0].trigger();

    return vi.waitFor(() => expect(onReposition).toHaveBeenCalledTimes(1));
  });

  it('debounces rapid resize firings into a single onReposition call via requestAnimationFrame', async () => {
    const onReposition = vi.fn();

    observeGridAnchor(onReposition);
    onReposition.mockClear();
    const observer = ResizeObserverStub.instances[0];
    observer.trigger();
    observer.trigger();
    observer.trigger();

    await vi.waitFor(() => expect(onReposition).toHaveBeenCalled());
    expect(onReposition).toHaveBeenCalledTimes(1);
  });
});
