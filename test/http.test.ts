import { afterEach, describe, expect, test } from 'bun:test';

import { callInterrupt, fetchJSON, requestSSEStream } from '../src/http';

const originalFetch = globalThis.fetch;

function installFetchMock(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchJSON', () => {
  test('parses JSON responses', async () => {
    installFetchMock(async () => new Response('{"status":"ok"}', { status: 200 }));
    const result = await fetchJSON('localhost', 24337, '/api/health', 'GET');
    expect(result).toEqual({ status: 200, data: { status: 'ok' } });
  });

  test('returns raw text for non-JSON bodies', async () => {
    installFetchMock(async () => new Response('not json', { status: 500 }));
    const result = await fetchJSON('localhost', 24337, '/api/x', 'GET');
    expect(result).toEqual({ status: 500, data: 'not json' });
  });

  test('sends JSON body and content-type for POST', async () => {
    let seenBody = '';
    installFetchMock(async (_url, init) => {
      seenBody = String(init?.body);
      return new Response('{}', { status: 200 });
    });
    await fetchJSON('localhost', 24337, '/api/project/interrupt', 'POST', JSON.stringify({ a: 1 }));
    expect(JSON.parse(seenBody)).toEqual({ a: 1 });
  });
});

describe('requestSSEStream', () => {
  test('returns the response body and task id', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: hi\n\n'));
        controller.close();
      },
    });
    installFetchMock(async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-task-id': 'task-1' } }),
    );

    const result = await requestSSEStream('localhost', 24337, '{}');
    expect(result.taskId).toBe('task-1');
    const reader = result.stream.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('data: hi\n\n');
  });

  test('rejects on non-200 with server response text', async () => {
    installFetchMock(async () => new Response('boom', { status: 500 }));
    await expect(requestSSEStream('localhost', 24337, '{}')).rejects.toThrow('Server returned 500: boom');
  });
});

describe('callInterrupt', () => {
  test('POSTs projectDir and taskId', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response('{}', { status: 200 });
    });
    await callInterrupt('localhost', 24337, '/proj', 'task-9');
    expect(seen?.url).toContain('/api/project/interrupt');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', taskId: 'task-9' });
  });
});