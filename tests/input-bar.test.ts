import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InputBar } from '../src/content/input-bar';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });

function getHost(): HTMLElement {
  return document.body.querySelector('#sheetbuddy-input-host') as HTMLElement;
}

function getBar(): HTMLElement {
  return getHost().shadowRoot!.querySelector('.bar') as HTMLElement;
}

function getMicBtn(): HTMLButtonElement {
  return getHost().shadowRoot!.querySelector('.mic-btn') as HTMLButtonElement;
}

function getTextInput(): HTMLInputElement {
  return getHost().shadowRoot!.querySelector('.text-input') as HTMLInputElement;
}

function getSendBtn(): HTMLButtonElement {
  return getHost().shadowRoot!.querySelector('.send-btn') as HTMLButtonElement;
}

describe('InputBar', () => {
  let inputBar: InputBar;

  beforeEach(() => {
    document.body.innerHTML = '';
    inputBar = new InputBar();
    inputBar.mount();
  });

  describe('mount', () => {
    it('appends host element to document.body', () => {
      expect(document.body.querySelector('#sheetbuddy-input-host')).not.toBeNull();
    });

    it('host has an open shadow root', () => {
      const host = document.body.querySelector('#sheetbuddy-input-host') as HTMLElement;
      expect(host.shadowRoot).not.toBeNull();
    });

    it('shadow root contains a .bar element', () => {
      expect(getBar()).not.toBeNull();
    });

    it('bar is hidden on mount', () => {
      expect(getBar().style.display).toBe('none');
    });
  });

  describe('open', () => {
    it('open("both") makes bar visible', () => {
      inputBar.open('both');
      expect(getBar().style.display).not.toBe('none');
    });

    it('open("both") does not call onStartRecording', () => {
      const cb = vi.fn();
      inputBar.onStartRecording = cb;
      inputBar.open('both');
      expect(cb).not.toHaveBeenCalled();
    });

    it('open("voice") makes bar visible', () => {
      inputBar.open('voice');
      expect(getBar().style.display).not.toBe('none');
    });

    it('open("voice") calls onStartRecording', () => {
      const cb = vi.fn();
      inputBar.onStartRecording = cb;
      inputBar.open('voice');
      expect(cb).toHaveBeenCalledOnce();
    });

    it('open("voice") locks the text field', () => {
      inputBar.open('voice');
      expect(getTextInput().readOnly).toBe(true);
    });

    it('open("text") makes bar visible', () => {
      inputBar.open('text');
      expect(getBar().style.display).not.toBe('none');
    });

    it('open("text") does not call onStartRecording', () => {
      const cb = vi.fn();
      inputBar.onStartRecording = cb;
      inputBar.open('text');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('hides the bar', () => {
      inputBar.open('both');
      inputBar.close();
      expect(getBar().style.display).toBe('none');
    });

    it('clears the text field', () => {
      inputBar.open('both');
      getTextInput().value = 'hello';
      inputBar.close();
      expect(getTextInput().value).toBe('');
    });

    it('calls onStopRecording when closed during active recording', () => {
      const cb = vi.fn();
      inputBar.onStopRecording = cb;
      inputBar.open('voice');
      inputBar.close();
      expect(cb).toHaveBeenCalledOnce();
    });

    it('does not call onStopRecording when closed while not recording', () => {
      const cb = vi.fn();
      inputBar.onStopRecording = cb;
      inputBar.open('both');
      inputBar.close();
      expect(cb).not.toHaveBeenCalled();
    });

    it('unlocks the text field when closed during recording', () => {
      inputBar.open('voice');
      inputBar.close();
      expect(getTextInput().readOnly).toBe(false);
    });
  });

  describe('setTranscript', () => {
    it('sets the text field value', () => {
      inputBar.open('voice');
      inputBar.setTranscript('hello world');
      expect(getTextInput().value).toBe('hello world');
    });
  });

  describe('lockField / unlockField', () => {
    it('lockField makes text input readonly', () => {
      inputBar.lockField();
      expect(getTextInput().readOnly).toBe(true);
    });

    it('unlockField removes readonly', () => {
      inputBar.lockField();
      inputBar.unlockField();
      expect(getTextInput().readOnly).toBe(false);
    });
  });

  describe('mic button toggle', () => {
    beforeEach(() => { inputBar.open('both'); });

    it('first click starts recording and calls onStartRecording', () => {
      const cb = vi.fn();
      inputBar.onStartRecording = cb;
      getMicBtn().click();
      expect(cb).toHaveBeenCalledOnce();
    });

    it('first click locks the text field', () => {
      getMicBtn().click();
      expect(getTextInput().readOnly).toBe(true);
    });

    it('second click stops recording and calls onStopRecording', () => {
      const cb = vi.fn();
      inputBar.onStopRecording = cb;
      getMicBtn().click();
      getMicBtn().click();
      expect(cb).toHaveBeenCalledOnce();
    });

    it('second click does not unlock the field — unlock is delegated to onStopRecording / TRANSCRIPT_FINAL', () => {
      getMicBtn().click(); // lock
      getMicBtn().click(); // stop — field stays locked until TRANSCRIPT_FINAL arrives
      expect(getTextInput().readOnly).toBe(true);
    });
  });

  describe('send button', () => {
    beforeEach(() => { inputBar.open('both'); });

    it('calls onQuery with trimmed text field value', () => {
      const cb = vi.fn();
      inputBar.onQuery = cb;
      getTextInput().value = '  sum column A  ';
      getSendBtn().click();
      expect(cb).toHaveBeenCalledWith('sum column A');
    });

    it('closes the bar after sending', () => {
      inputBar.onQuery = vi.fn();
      getTextInput().value = 'hello';
      getSendBtn().click();
      expect(getBar().style.display).toBe('none');
    });

    it('does not call onQuery when text field is empty', () => {
      const cb = vi.fn();
      inputBar.onQuery = cb;
      getTextInput().value = '';
      getSendBtn().click();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('Enter key', () => {
    beforeEach(() => { inputBar.open('both'); });

    it('pressing Enter calls onQuery with text field value', () => {
      const cb = vi.fn();
      inputBar.onQuery = cb;
      getTextInput().value = 'count rows';
      getTextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(cb).toHaveBeenCalledWith('count rows');
    });

    it('pressing Enter closes the bar', () => {
      inputBar.onQuery = vi.fn();
      getTextInput().value = 'count rows';
      getTextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(getBar().style.display).toBe('none');
    });

    it('pressing Enter on empty field does not call onQuery', () => {
      const cb = vi.fn();
      inputBar.onQuery = cb;
      getTextInput().value = '';
      getTextInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('toggle', () => {
    it('opens the bar when closed', () => {
      inputBar.toggle();
      expect(getBar().style.display).not.toBe('none');
    });

    it('closes the bar when open', () => {
      inputBar.open('both');
      inputBar.toggle();
      expect(getBar().style.display).toBe('none');
    });

    it('re-opens after close', () => {
      inputBar.toggle(); // open
      inputBar.toggle(); // close
      inputBar.toggle(); // open again
      expect(getBar().style.display).not.toBe('none');
    });
  });

  describe('Escape key dismiss', () => {
    it('closes the bar when Escape is pressed while open', () => {
      inputBar.open('both');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(getBar().style.display).toBe('none');
    });

    it('calls onDismiss when Escape is pressed while open', () => {
      const cb = vi.fn();
      inputBar.onDismiss = cb;
      inputBar.open('both');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(cb).toHaveBeenCalledOnce();
    });

    it('does not close the bar when Escape is pressed while closed', () => {
      inputBar.open('both');
      inputBar.close();
      const cb = vi.fn();
      inputBar.onDismiss = cb;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
