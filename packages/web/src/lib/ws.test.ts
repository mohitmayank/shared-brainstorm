/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectWs } from './ws.js';
import type { AnyFrame } from '@shared-brainstorm/shared';

// ---- FakeWebSocket ----
interface FakeWsInstance {
  readyState: number;
  sent: string[];
  listeners: Record<string, Array<(evt: unknown) => void>>;
  addEventListener(type: string, cb: (evt: unknown) => void): void;
  send(data: string): void;
  close(): void;
  _trigger(type: string, evt: unknown): void;
}

let lastWs: FakeWsInstance | null = null;

class FakeWebSocket implements FakeWsInstance {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  listeners: Record<string, Array<(evt: unknown) => void>> = {};

  constructor(public url: string) {
    lastWs = this; // eslint-disable-line @typescript-eslint/no-this-alias
  }

  addEventListener(type: string, cb: (evt: unknown) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type]!.push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }

  _trigger(type: string, evt: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(evt);
  }
}

describe('connectWs', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    lastWs = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('sends hello with last_seq on open when lastSeq >= 0', () => {
    connectWs({ url: 'ws://localhost', lastSeq: 5, onEvent: vi.fn(), onClose: vi.fn() });
    lastWs!._trigger('open', {});
    expect(lastWs!.sent).toHaveLength(1);
    expect(JSON.parse(lastWs!.sent[0]!)).toEqual({ type: 'hello', last_seq: 5 });
  });

  it('sends hello without last_seq when lastSeq is -1', () => {
    connectWs({ url: 'ws://localhost', lastSeq: -1, onEvent: vi.fn(), onClose: vi.fn() });
    lastWs!._trigger('open', {});
    expect(lastWs!.sent).toHaveLength(1);
    expect(JSON.parse(lastWs!.sent[0]!)).toEqual({ type: 'hello' });
    expect(JSON.parse(lastWs!.sent[0]!)).not.toHaveProperty('last_seq');
  });

  it('dispatches parsed ServerEvent to onEvent', () => {
    const onEvent = vi.fn();
    connectWs({ url: 'ws://localhost', lastSeq: -1, onEvent, onClose: vi.fn() });
    lastWs!._trigger('open', {});

    const evt = {
      seq: 1,
      ts: new Date().toISOString(),
      type: 'participant_joined',
      payload: {
        participant: {
          id: 'sb_p_abc',
          display_name: 'Alice',
          joined_at: new Date().toISOString(),
          status: 'pending',
        },
      },
    };
    lastWs!._trigger('message', { data: JSON.stringify(evt) });
    expect(onEvent).toHaveBeenCalledOnce();
    expect((onEvent.mock.calls[0]![0] as AnyFrame).type).toBe('participant_joined');
  });

  it('sends pong on heartbeat and does not call onEvent', () => {
    const onEvent = vi.fn();
    connectWs({ url: 'ws://localhost', lastSeq: -1, onEvent, onClose: vi.fn() });
    lastWs!._trigger('open', {});
    const sentBefore = lastWs!.sent.length;

    lastWs!._trigger('message', { data: JSON.stringify({ type: 'heartbeat' }) });

    expect(onEvent).not.toHaveBeenCalled();
    expect(lastWs!.sent.length).toBe(sentBefore + 1);
    expect(JSON.parse(lastWs!.sent[lastWs!.sent.length - 1]!)).toEqual({ type: 'pong' });
  });

  it('drops invalid frames silently', () => {
    const onEvent = vi.fn();
    connectWs({ url: 'ws://localhost', lastSeq: -1, onEvent, onClose: vi.fn() });
    lastWs!._trigger('open', {});
    lastWs!._trigger('message', { data: JSON.stringify({ type: 'totally_unknown', foo: 'bar' }) });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('calls onClose with code/reason when WebSocket closes', () => {
    const onClose = vi.fn();
    connectWs({ url: 'ws://localhost', lastSeq: -1, onEvent: vi.fn(), onClose });
    lastWs!._trigger('close', { code: 1008, reason: 'not_joined' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith({ code: 1008, reason: 'not_joined' });
  });

  it('passes "removed" reason verbatim on 1008 close (CR-02: kick-evasion regression)', () => {
    // Regression test: the ws layer must forward the close reason unchanged so
    // App.tsx onClose can distinguish 'removed' (kicked) from 'not_joined'.
    // If this test fails, App.tsx will never receive 'removed' and a kicked
    // participant will always be able to re-admit themselves on reload.
    const onClose = vi.fn();
    connectWs({ url: 'ws://localhost', lastSeq: -1, onEvent: vi.fn(), onClose });
    lastWs!._trigger('close', { code: 1008, reason: 'removed' });
    expect(onClose).toHaveBeenCalledWith({ code: 1008, reason: 'removed' });
  });

  it('passes empty reason string through on abnormal close (1006)', () => {
    // 1006 (abnormal close) typically has no reason string — must be forwarded
    // as-is so App.tsx backoff logic handles it (not treated as 1008).
    const onClose = vi.fn();
    connectWs({ url: 'ws://localhost', lastSeq: -1, onEvent: vi.fn(), onClose });
    lastWs!._trigger('close', { code: 1006, reason: '' });
    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: '' });
  });
});
