import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InputBar } from '../src/content/input-bar';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });

function getBar(inputBar: InputBar): HTMLElement {
  const host = document.body.querySelector('#sheetbuddy-input-host') as HTMLElement;
  return host.shadowRoot!.querySelector('.bar') as HTMLElement;
}

function getMicBtn(inputBar: InputBar): HTMLButtonElement {
  const host = document.body.querySelector('#sheetbuddy-input-host') as HTMLElement;
  return host.shadowRoot!.querySelector('.mic-btn') as HTMLButtonElement;
}

function getTextInput(inputBar: InputBar): HTMLInputElement {
  const host = document.body.querySelector('#sheetbuddy-input-host') as HTMLElement;
  return host.shadowRoot!.querySelector('.text-input') as HTMLInputElement;
}

function getSendBtn(inputBar: InputBar): HTMLButtonElement {
  const host = document.body.querySelector('#sheetbuddy-input-host') as HTMLElement;
  return host.shadowRoot!.querySelector('.send-btn') as HTMLButtonElement;
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
      expect(getBar(inputBar)).not.toBeNull();
    });

    it('bar is hidden on mount', () => {
      expect(getBar(inputBar).style.display).toBe('none');
    });
  });

  describe('open', () => {
    it('open("both") makes bar visible', () => {
      inputBar.open('both');
      expect(getBar(inputBar).style.display).not.toBe('none');
    });

    it('open("both") does not call onStartRecording', () => {
      const cb = vi.fn();
      inputBar.onStartRecording = cb;
      inputBar.open('both');
      expect(cb).not.toHaveBeenCalled();
    });

    it('open("voice") makes bar visible', () => {
      inputBar.open('voice');
      expect(getBar(inputBar).style.display).not.toBe('none');
    });

    it('open("voice") calls onStartRecording', () => {
      const cb = vi.fn();
      inputBar.onStartRecording = cb;
      inputBar.open('voice');
      expect(cb).toHaveBeenCalledOnce();
    });

    it('open("voice") locks the text field', () => {
      inputBar.open('voice');
      expect(getTextInput(inputBar).readOnly).toBe(true);
    });

    it('open("text") makes bar visible', () => {
      inputBar.open('text');
      expect(getBar(inputBar).style.display).not.toBe('none');
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
      expect(getBar(inputBar).style.display).toBe('none');
    });

    it('clears the text field', () => {
      inputBar.open('both');
      getTextInput(inputBar).value = 'hello';
      inputBar.close();
      expect(getTextInput(inputBar).value).toBe('');
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
      expect(getTextInput(inputBar).readOnly).toBe(false);
    });
  });

  describe('setTranscript', () => {
    it('sets the text field value', () => {
      inputBar.open('voice');
      inputBar.setTranscript('hello world');
      expect(getTextInput(inputBar).value).toBe('hello world');
    });
  });

  describe('lockField / unlockField', () => {
    it('lockField makes text input readonly', () => {
      inputBar.lockField();
      expect(getTextInput(inputBar).readOnly).toBe(true);
    });

    it('unlockField removes readonly', () => {
      inputBar.lockField();
      inputBar.unlockField();
      expect(getTextInput(inputBar).readOnly).toBe(false);
    });
  });

  describe('mic button toggle', () => {
    beforeEach(() => { inputBar.open('both'); });

    it('first click starts recording and calls onStartRecording', () => {
      const cb = vi.fn();
      inputBar.onStartRecording = cb;
      getMicBtn(inputBar).click();
      expect(cb).toHaveBeenCalledOnce();
    });

    it('first click locks the text field', () => {
      getMicBtn(inputBar).click();
      expect(getTextInput(inputBar).readOnly).toBe(true);
    });

    it('second click stops recording and calls onStopRecording', () => {
      const cb = vi.fn();
      inputBar.onStopRecording = cb;
      getMicBtn(inputBar).click();
      getMicBtn(inputBar).click();
      expect(cb).toHaveBeenCalledOnce();
    });

    it('second click unlocks the text field', () => {
      getMicBtn(inputBar).click();
      getMicBtn(inputBar).click();
      expect(getTextInput(inputBar).readOnly).toBe(false);
    });
  });

  describe('send button', () => {
    beforeEach(() => { inputBar.open('both'); });

    it('calls onQuery with trimmed text field value', () => {
      const cb = vi.fn();
      inputBar.onQuery = cb;
      getTextInput(inputBar).value = '  sum column A  ';
      getSendBtn(inputBar).click();
      expect(cb).toHaveBeenCalledWith('sum column A');
    });

    it('closes the bar after sending', () => {
      inputBar.onQuery = vi.fn();
      getTextInput(inputBar).value = 'hello';
      getSendBtn(inputBar).click();
      expect(getBar(inputBar).style.display).toBe('none');
    });

    it('does not call onQuery when text field is empty', () => {
      const cb = vi.fn();
      inputBar.onQuery = cb;
      getTextInput(inputBar).value = '';
      getSendBtn(inputBar).click();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('Enter key', () => {
    beforeEach(() => { inputBar.open('both'); });

    it('pressing Enter calls onQuery with text field value', () => {
      const cb = vi.fn();
      inputBar.onQuery = cb;
      getTextInput(inputBar).value = 'count rows';
      getTextInput(inputBar).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(cb).toHaveBeenCalledWith('count rows');
    });

    it('pressing Enter closes the bar', () => {
      inputBar.onQuery = vi.fn();
      getTextInput(inputBar).value = 'count rows';
      getTextInput(inputBar).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(getBar(inputBar).style.display).toBe('none');
    });

    it('pressing Enter on empty field does not call onQuery', () => {
      const cb = vi.fn();
      inputBar.onQuery = cb;
      getTextInput(inputBar).value = '';
      getTextInput(inputBar).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('Escape key dismiss', () => {
    it('closes the bar when Escape is pressed while open', () => {
      inputBar.open('both');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(getBar(inputBar).style.display).toBe('none');
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
