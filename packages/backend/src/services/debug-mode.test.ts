import { describe, expect, test } from 'vitest';

import { debugModeService } from './debug-mode.js';

function createStreamClient() {
  const frames: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const raw: any = {
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    on: (event: string, cb: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    },
    emit: (event: string) => {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
  return { reply: { raw } as any, raw, frames };
}

function parseDataFrames(frames: string[]): any[] {
  return frames
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)));
}

describe('debugModeService header redaction', () => {
  test('redacts every header the gateway accepts as a credential', () => {
    debugModeService.setState(true, Date.now() + 60_000);
    try {
      const client = createStreamClient();
      debugModeService.addStreamClient(client.reply);

      debugModeService.broadcast({
        type: 'api_request',
        id: 'redaction-test-1',
        timestamp: Date.now(),
        protocol: 'openai',
        method: 'POST',
        path: '/v1/chat/completions',
        stream: false,
        success: true,
        statusCode: 200,
        durationMs: 5,
        requestBody: {},
        requestHeaders: {
          authorization: 'Bearer vk-secret',
          'x-api-key': 'vk-secret',
          'x-goog-api-key': 'vk-secret',
          'x-google-api-key': 'vk-secret',
          'x-agent-loopback': 'loopback-secret',
          'content-type': 'application/json',
        },
      });

      const apiEvent = parseDataFrames(client.frames).find(
        (event) => event.type === 'api_request',
      );
      expect(apiEvent).toBeTruthy();
      expect(apiEvent.requestHeaders).toEqual({
        authorization: '[redacted]',
        'x-api-key': '[redacted]',
        'x-goog-api-key': '[redacted]',
        'x-google-api-key': '[redacted]',
        'x-agent-loopback': '[redacted]',
        'content-type': 'application/json',
      });

      client.raw.emit('close');
    } finally {
      debugModeService.setState(false, 0);
    }
  });
});
