import { describe, expect, test } from 'bun:test';

import { parseSSEEvents, type SSEEvent } from '../src/sse';

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of parseSSEEvents(stream)) {
    events.push(event);
  }
  return events;
}

describe('parseSSEEvents', () => {
  test('parses a single complete event', async () => {
    const events = await collect(streamFrom([new TextEncoder().encode('event: response-chunk\ndata: {"chunk":"hi"}\n\n')]));
    expect(events).toEqual([{ type: 'response-chunk', data: '{"chunk":"hi"}' }]);
  });

  test('defaults to "message" type when no event field', async () => {
    const events = await collect(streamFrom([new TextEncoder().encode('data: hello\n\n')]));
    expect(events).toEqual([{ type: 'message', data: 'hello' }]);
  });

  test('joins multi-line data blocks', async () => {
    const events = await collect(streamFrom([new TextEncoder().encode('data: line1\ndata: line2\n\n')]));
    expect(events).toEqual([{ type: 'message', data: 'line1\nline2' }]);
  });

  test('ignores comment lines', async () => {
    const events = await collect(streamFrom([new TextEncoder().encode(': keep-alive\ndata: x\n\n')]));
    expect(events).toEqual([{ type: 'message', data: 'x' }]);
  });

  test('parses events split across multiple chunks', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('event: resp'),
      encoder.encode('onse-chunk\nda'),
      encoder.encode('ta: {"chunk":"abc"}\n\n'),
      encoder.encode('event: stream-end\ndata: {}\n\n'),
    ];
    const events = await collect(streamFrom(chunks));
    expect(events).toEqual([
      { type: 'response-chunk', data: '{"chunk":"abc"}' },
      { type: 'stream-end', data: '{}' },
    ]);
  });

  test('flushes a trailing event without a blank line', async () => {
    const events = await collect(streamFrom([new TextEncoder().encode('event: done\ndata: {"ok":true}')]));
    expect(events).toEqual([{ type: 'done', data: '{"ok":true}' }]);
  });

  test('handles CRLF line endings', async () => {
    const events = await collect(streamFrom([new TextEncoder().encode('event: message\ndata: hello\r\n\r\n')]));
    expect(events).toEqual([{ type: 'message', data: 'hello' }]);
  });

  test('yields nothing for empty input', async () => {
    const events = await collect(streamFrom([]));
    expect(events).toEqual([]);
  });
});