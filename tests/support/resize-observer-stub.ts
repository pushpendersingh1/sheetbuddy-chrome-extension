// jsdom does not implement ResizeObserver — this stub lets DOM code that
// constructs one run without throwing. Most callers only need that; grid-anchor.test.ts
// additionally needs to simulate a resize firing, so instances are tracked and
// exposed via trigger() rather than being invoked automatically.
export class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

export function installResizeObserverStub(): void {
  ResizeObserverStub.instances = [];
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}
