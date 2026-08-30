import { afterEach, describe, expect, test } from 'bun:test';

import {
  callInterrupt,
  compactConversation,
  createTask,
  deleteTask,
  ensureProjectOpen,
  fetchInputHistory,
  fetchJSON,
  fetchTask,
  handoffConversation,
  listTasks,
  loadTask,
  requestSSEStream,
  resumeTask,
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

describe('fetchTask', () => {
  test('GETs the readonly task endpoint with projectDir and returns the messages', async () => {
    let seenUrl = '';
    installFetchMock(async (url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ messages: [{ type: 'response-completed', messageId: 'm2', content: 'summary' }] }),
        { status: 200 },
      );
    });
    const messages = await fetchTask('localhost', 24337, '/proj', 'task-1');
    expect(seenUrl).toContain('/api/readonly/tasks/task-1');
    expect(seenUrl).toContain(`projectDir=${encodeURIComponent('/proj')}`);
    expect(messages).toEqual([{ type: 'response-completed', messageId: 'm2', content: 'summary' }]);
  });

  test('returns undefined on a non-200 response', async () => {
    installFetchMock(async () => new Response('nope', { status: 500 }));
    expect(await fetchTask('localhost', 24337, '/proj', 'task-1')).toBeUndefined();
  });

  test('returns undefined on a fetch failure', async () => {
    installFetchMock(async () => {
      throw new Error('connection refused');
    });
    expect(await fetchTask('localhost', 24337, '/proj', 'task-1')).toBeUndefined();
  });
});

describe('handoffConversation', () => {
  test('POSTs projectDir, taskId and optional focus, returning the new task id', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response(JSON.stringify({ message: 'Conversation handed off', taskId: 'task-2' }), { status: 200 });
    });
    const newTaskId = await handoffConversation('localhost', 24337, '/proj', 'task-1', 'finish the refactor');
    expect(seen?.url).toContain('/api/project/handoff-conversation');
    expect(JSON.parse(seen?.body ?? '')).toEqual({
      projectDir: '/proj',
      taskId: 'task-1',
      focus: 'finish the refactor',
    });
    expect(newTaskId).toBe('task-2');
  });

  test('omits focus when not supplied and resolves undefined without a task id', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response(JSON.stringify({ message: 'Conversation handed off' }), { status: 200 });
    });
    const newTaskId = await handoffConversation('localhost', 24337, '/proj', 'task-1');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', taskId: 'task-1' });
    expect(newTaskId).toBeUndefined();
  });
});

describe('ensureProjectOpen', () => {
  test('POSTs the project dir to add-open', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await ensureProjectOpen('localhost', 24337, '/proj');
    expect(seen?.url).toContain('/api/project/add-open');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj' });
  });

  test('swallows failures', async () => {
    installFetchMock(async () => {
      throw new Error('connection refused');
    });
    await expect(ensureProjectOpen('localhost', 24337, '/proj')).resolves.toBeUndefined();
  });
});

describe('listTasks', () => {
  test('GETs the tasks endpoint with projectDir and maps task summaries', async () => {
    let seenUrl = '';
    installFetchMock(async (url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify([
          { id: 'task-1', baseDir: '/proj', name: 'Fix login', state: 'completed', archived: false, updatedAt: '2026-08-28T10:00:00Z' },
          { id: 'task-2', baseDir: '/proj', name: '', updatedAt: '2026-08-27T09:00:00Z' },
        ]),
        { status: 200 },
      );
    });
    const tasks = await listTasks('localhost', 24337, '/proj');
    expect(seenUrl).toContain('/api/project/tasks');
    expect(seenUrl).toContain(`projectDir=${encodeURIComponent('/proj')}`);
    expect(tasks).toEqual([
      { id: 'task-1', baseDir: '/proj', name: 'Fix login', state: 'completed', archived: false, updatedAt: '2026-08-28T10:00:00Z' },
      { id: 'task-2', baseDir: '/proj', name: '', updatedAt: '2026-08-27T09:00:00Z' },
    ]);
  });

  test('returns an empty list on non-200 responses and failures', async () => {
    installFetchMock(async () => new Response('nope', { status: 500 }));
    expect(await listTasks('localhost', 24337, '/proj')).toEqual([]);

    installFetchMock(async () => {
      throw new Error('connection refused');
    });
    expect(await listTasks('localhost', 24337, '/proj')).toEqual([]);
  });
});

describe('fetchInputHistory', () => {
  test('GETs the input-history endpoint with projectDir and returns entries', async () => {
    let seenUrl = '';
    installFetchMock(async (url) => {
      seenUrl = url;
      return new Response(JSON.stringify(['fix the failing test', 'review git staged diff']), { status: 200 });
    });
    const history = await fetchInputHistory('localhost', 24337, '/proj');
    expect(seenUrl).toContain('/api/project/input-history');
    expect(seenUrl).toContain(`projectDir=${encodeURIComponent('/proj')}`);
    expect(history).toEqual(['fix the failing test', 'review git staged diff']);
  });

  test('drops non-string entries and returns [] on non-200 responses and failures', async () => {
    installFetchMock(async () => new Response(JSON.stringify(['ok', 42, null]), { status: 200 }));
    expect(await fetchInputHistory('localhost', 24337, '/proj')).toEqual(['ok']);

    installFetchMock(async () => new Response('nope', { status: 500 }));
    expect(await fetchInputHistory('localhost', 24337, '/proj')).toEqual([]);

    installFetchMock(async () => {
      throw new Error('connection refused');
    });
    expect(await fetchInputHistory('localhost', 24337, '/proj')).toEqual([]);
  });
});

describe('loadTask', () => {
  test('POSTs to tasks/load and returns the conversation messages', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response(
        JSON.stringify({
          messages: [
            { type: 'user', id: 'u1', content: 'hello' },
            { type: 'response-completed', messageId: 'r1', content: 'hi there' },
          ],
        }),
        { status: 200 },
      );
    });
    const state = await loadTask('localhost', 24337, '/proj', 'task-1');
    expect(seen?.url).toContain('/api/project/tasks/load');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', id: 'task-1' });
    expect(state?.messages).toHaveLength(2);
  });

  test('returns undefined on non-200 responses and failures', async () => {
    installFetchMock(async () => new Response('nope', { status: 500 }));
    expect(await loadTask('localhost', 24337, '/proj', 'task-1')).toBeUndefined();

    installFetchMock(async () => {
      throw new Error('connection refused');
    });
    expect(await loadTask('localhost', 24337, '/proj', 'task-1')).toBeUndefined();

    installFetchMock(async () => new Response(JSON.stringify({}), { status: 200 }));
    expect(await loadTask('localhost', 24337, '/proj', 'task-1')).toBeUndefined();
  });
});

describe('resumeTask', () => {
  test('POSTs projectDir and taskId to resume-task', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response(JSON.stringify({ message: 'Task resumed' }), { status: 200 });
    });
    await resumeTask('localhost', 24337, '/proj', 'task-1');
    expect(seen?.url).toContain('/api/project/resume-task');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', taskId: 'task-1' });
  });

  test('swallows failures', async () => {
    installFetchMock(async () => {
      throw new Error('connection refused');
    });
    await expect(resumeTask('localhost', 24337, '/proj', 'task-1')).resolves.toBeUndefined();
  });
});

describe('deleteTask', () => {
  test('POSTs projectDir and id to tasks/delete', async () => {
    let seen: { url: string; body: string } | undefined;
    installFetchMock(async (url, init) => {
      seen = { url, body: String(init?.body) };
      return new Response(JSON.stringify({ message: 'Task deleted' }), { status: 200 });
    });
    await deleteTask('localhost', 24337, '/proj', 'task-1');
    expect(seen?.url).toContain('/api/project/tasks/delete');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ projectDir: '/proj', id: 'task-1' });
  });

  test('swallows failures', async () => {
    installFetchMock(async () => {
      throw new Error('connection refused');
    });
    await expect(deleteTask('localhost', 24337, '/proj', 'task-1')).resolves.toBeUndefined();
  });
});