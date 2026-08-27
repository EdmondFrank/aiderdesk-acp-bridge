import { afterEach, describe, expect, test } from 'bun:test';

import {
  callInterrupt,
  compactConversation,
  createTask,
  fetchJSON,
  handoffConversation,
  requestSSEStream,
  runCustomCommand,
  smartCompactConversation,
} from '../src/http';

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

    const result = await requestSSEStream('localhost', 24337, '/api/run-prompt', '{}');
    expect(result.taskId).toBe('task-1');
    const reader = result.stream.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('data: hi\n\n');
  });

  test('rejects on non-200 with server response text', async () => {
    installFetchMock(async () => new Response('boom', { status: 500 }));
    await expect(requestSSEStream('localhost', 24337, '/api/run-prompt', '{}')).rejects.toThrow('Server returned 500: boom');
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

describe('createTask', () => {
  test('POSTs to tasks/new and returns the task id', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response(JSON.stringify({ id: 'task-42' }), { status: 200 });
    });
    const taskId = await createTask('localhost', 24337, '/proj', 'my-cmd');
    expect(seen?.url).toContain('/api/project/tasks/new');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', name: 'my-cmd' });
    expect(taskId).toBe('task-42');
  });

  test('rejects when the response has no id', async () => {
    installFetchMock(async () => new Response('{}', { status: 200 }));
    await expect(createTask('localhost', 24337, '/proj')).rejects.toThrow('missing id');
  });

  test('rejects on non-200', async () => {
    installFetchMock(async () => new Response('boom', { status: 500 }));
    await expect(createTask('localhost', 24337, '/proj')).rejects.toThrow('server returned 500');
  });
});

describe('runCustomCommand', () => {
  test('POSTs the command payload to custom-commands', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response('{}', { status: 200 });
    });
    await runCustomCommand('localhost', 24337, '/proj', 'task-1', 'summarize', ['a b'], 'agent');
    expect(seen?.url).toContain('/api/project/custom-commands');
    expect(JSON.parse(seen?.body ?? '')).toEqual({
      projectDir: '/proj',
      taskId: 'task-1',
      commandName: 'summarize',
      args: ['a b'],
      mode: 'agent',
    });
  });
});

describe('compactConversation', () => {
  test('POSTs projectDir, taskId, mode and optional custom instructions', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response('{}', { status: 200 });
    });
    await compactConversation('localhost', 24337, '/proj', 'task-1', 'agent', 'focus on API');
    expect(seen?.url).toContain('/api/project/compact-conversation');
    expect(JSON.parse(seen?.body ?? '')).toEqual({
      projectDir: '/proj',
      taskId: 'task-1',
      mode: 'agent',
      customInstructions: 'focus on API',
    });
  });

  test('omits custom instructions when not supplied', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response('{}', { status: 200 });
    });
    await compactConversation('localhost', 24337, '/proj', 'task-1', 'agent');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', taskId: 'task-1', mode: 'agent' });
  });
});

describe('smartCompactConversation', () => {
  test('POSTs projectDir and taskId', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response('{}', { status: 200 });
    });
    await smartCompactConversation('localhost', 24337, '/proj', 'task-1');
    expect(seen?.url).toContain('/api/project/smart-compact-conversation');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', taskId: 'task-1' });
  });
});

describe('handoffConversation', () => {
  test('POSTs projectDir, taskId and optional focus', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response('{}', { status: 200 });
    });
    await handoffConversation('localhost', 24337, '/proj', 'task-1', 'finish the refactor');
    expect(seen?.url).toContain('/api/project/handoff-conversation');
    expect(JSON.parse(seen?.body ?? '')).toEqual({
      projectDir: '/proj',
      taskId: 'task-1',
      focus: 'finish the refactor',
    });
  });

  test('omits focus when not supplied', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response('{}', { status: 200 });
    });
    await handoffConversation('localhost', 24337, '/proj', 'task-1');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', taskId: 'task-1' });
  });
});