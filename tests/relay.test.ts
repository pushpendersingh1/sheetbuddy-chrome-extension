import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { makeRelay } from '../src/background/relay';
import type { Message } from '../src/types/messages';

describe('makeRelay', () => {
  let ensureOffscreen: MockInstance;
  let sendMessage: MockInstance;
  let sendResponse: MockInstance;
  let relayToOffscreen: (message: Message, sendResponse: (r: unknown) => void) => void;

  const speakMessage: Message = { type: 'SPEAK', payload: { text: 'hello' } };

  beforeEach(() => {
    ensureOffscreen = vi.fn().mockResolvedValue(undefined);
    sendMessage = vi.fn().mockResolvedValue({ ok: true });
    sendResponse = vi.fn();
    relayToOffscreen = makeRelay({
      ensureOffscreen: ensureOffscreen as unknown as () => Promise<void>,
      sendMessage: sendMessage as unknown as (message: unknown) => Promise<unknown>,
    });
  });

  it('stamps _relayed: true on the outgoing message without altering other fields', async () => {
    relayToOffscreen(speakMessage, sendResponse as unknown as (r: unknown) => void);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage).toHaveBeenCalledWith({ ...speakMessage, _relayed: true });
  });

  it('calls ensureOffscreen before sending', async () => {
    relayToOffscreen(speakMessage, sendResponse as unknown as (r: unknown) => void);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(ensureOffscreen).toHaveBeenCalled();
  });

  it('forwards the exact response from sendMessage back through sendResponse', async () => {
    sendMessage.mockResolvedValue({ ok: true, extra: 'data' });
    relayToOffscreen(speakMessage, sendResponse as unknown as (r: unknown) => void);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, extra: 'data' });
  });

  it('reports a synthetic failure when offscreen gives no response', async () => {
    sendMessage.mockResolvedValue(undefined);
    relayToOffscreen(speakMessage, sendResponse as unknown as (r: unknown) => void);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'No response from offscreen' });
  });

  it('reports a failure and does not throw when ensureOffscreen rejects', async () => {
    ensureOffscreen.mockRejectedValue(new Error('createDocument failed'));
    expect(() => relayToOffscreen(speakMessage, sendResponse as unknown as (r: unknown) => void)).not.toThrow();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'Error: createDocument failed' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reports a failure and does not throw when sendMessage rejects', async () => {
    sendMessage.mockRejectedValue(new Error('channel closed'));
    expect(() => relayToOffscreen(speakMessage, sendResponse as unknown as (r: unknown) => void)).not.toThrow();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'Error: channel closed' });
  });

  it('only ensures the offscreen document once across multiple relay calls', async () => {
    relayToOffscreen(speakMessage, sendResponse as unknown as (r: unknown) => void);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    relayToOffscreen({ type: 'STOP_RECORDING' }, sendResponse as unknown as (r: unknown) => void);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(2));
    expect(ensureOffscreen).toHaveBeenCalledTimes(1);
  });

  it('separate makeRelay instances have independent offscreen-ready state', async () => {
    const ensureOffscreen2 = vi.fn().mockResolvedValue(undefined);
    const relay2 = makeRelay({
      ensureOffscreen: ensureOffscreen2 as unknown as () => Promise<void>,
      sendMessage: sendMessage as unknown as (message: unknown) => Promise<unknown>,
    });

    relayToOffscreen(speakMessage, sendResponse as unknown as (r: unknown) => void);
    await vi.waitFor(() => expect(ensureOffscreen).toHaveBeenCalledTimes(1));

    relay2(speakMessage, sendResponse as unknown as (r: unknown) => void);
    await vi.waitFor(() => expect(ensureOffscreen2).toHaveBeenCalledTimes(1));
  });
});
