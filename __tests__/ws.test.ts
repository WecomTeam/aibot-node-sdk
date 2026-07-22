import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { WsConnectionManager } from '../src/ws';
import type { Logger } from '../src/types';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('WsConnectionManager', () => {
  it('waits 15 seconds for reply acknowledgements by default', async () => {
    vi.useFakeTimers();
    const manager = new WsConnectionManager(logger);
    (manager as any).ws = { readyState: WebSocket.OPEN, send: vi.fn() };

    const result = manager.sendReply('req-1', {}).then(
      () => 'resolved',
      (error: Error) => error.message,
    );

    await vi.advanceTimersByTimeAsync(14999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toContain('15000ms');
    vi.useRealTimers();
  });
});
