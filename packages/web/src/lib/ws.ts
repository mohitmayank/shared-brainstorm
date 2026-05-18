import { AnyFrame } from '@shared-brainstorm/shared';

export interface WsHandle {
  send: (data: string) => void;
  close: () => void;
}

export interface CloseInfo {
  code: number;
  reason: string;
}

export interface ConnectWsArgs {
  url: string;
  lastSeq: number;
  onEvent: (frame: AnyFrame) => void;
  onClose: (info: CloseInfo) => void;
}

export function connectWs({ url, lastSeq, onEvent, onClose }: ConnectWsArgs): WsHandle {
  const ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    if (lastSeq >= 0) {
      ws.send(JSON.stringify({ type: 'hello', last_seq: lastSeq }));
    } else {
      ws.send(JSON.stringify({ type: 'hello' }));
    }
  });

  ws.addEventListener('message', (evt) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(evt.data));
    } catch {
      return;
    }

    const result = AnyFrame.safeParse(raw);
    if (!result.success) return; // drop invalid frames

    const frame = result.data;

    if (frame.type === 'heartbeat') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    onEvent(frame);
  });

  ws.addEventListener('close', (evt) => {
    onClose({ code: evt.code, reason: evt.reason });
  });

  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}
