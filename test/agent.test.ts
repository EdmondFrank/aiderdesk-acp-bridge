import { afterEach, describe, expect, test } from 'bun:test';
import * as acp from '@agentclientprotocol/sdk';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpAgent } from '../src/agent';
import { selectById } from './helpers';

const originalFetch = globalThis.fetch;

// Session→task mappings must never touch the real user state directory.
process.env.AIDER_DESK_ACP_STATE_DIR = mkdtempSync(join(tmpdir(), 'aiderdesk-acp-test-'));

type FetchCall = { url: string; init?: RequestInit };

type Route = {
  method: string;
  match: (url: string) => boolean;
  handler: (call: FetchCall) => Response;
};

function createMockRouter() {
  const routes: Route[] = [];
  const calls: FetchCall[] = [];

  const add = (method: string, pathOrRegex: string | RegExp, handler: (call: FetchCall) => Response) => {
    routes.push({
      method,
      match: (url: string) =>
        typeof pathOrRegex === 'string' ? url.includes(pathOrRegex) : pathOrRegex.test(url),
      handler,
    });
  };

  // Defaults matched only after explicit routes, mirroring the session
  // bootstrap calls every `newSession` makes. Tests override them when the
  // returned task id matters.
  const defaults: Route[] = [
    {
      method: 'POST',
      match: (url: string) => url.includes('/api/project/add-open'),
      handler: () => new Response(JSON.stringify([]), { status: 200 }),
    },
    {
      method: 'POST',
      match: (url: string) => url.includes('/api/project/tasks/new'),
      handler: () => new Response(JSON.stringify({ id: 'task-1' }), { status: 200 }),
    },
    {
      method: 'GET',
      match: (url: string) => url.includes('/api/models'),
      handler: () => new Response('{"models":[]}', { status: 200 }),
    },
    {
      method: 'GET',
      match: (url: string) => url.includes('/api/providers'),
      handler: () => new Response('[]', { status: 200 }),
    },
    {
      method: 'GET',
      match: (url: string) => url.includes('/api/settings'),
      handler: () => new Response('{}', { status: 200 }),
    },
  ];

  const router = async (url: string, init?: RequestInit): Promise<Response> => {
    const call = { url, init };
    calls.push(call);
    const method = init?.method ?? 'GET';
    const route =
      routes.find((r) => r.method === method && r.match(url)) ??
      defaults.find((r) => r.method === method && r.match(url));
    if (!route) {
      throw new Error(`No mock route for ${method} ${url}`);
    }
    return route.handler(call);
  };

  return { add, calls, router, callsMatching: (pattern: RegExp) => calls.filter((c) => pattern.test(c.url)) };
}

type NotifyCall = { method: unknown; params: unknown };

function mockContext(): { cx: acp.AgentContext; notifyCalls: NotifyCall[]; firstNotify: Promise<void> } {
  const notifyCalls: NotifyCall[] = [];
  let resolveFirst!: () => void;
  const firstNotify = new Promise<void>((res) => {
    resolveFirst = res;
  });
  const cx = {
    notify: async (method: unknown, params: unknown) => {
      notifyCalls.push({ method, params });
      resolveFirst();
    },
  } as unknown as acp.AgentContext;
  return { cx, notifyCalls, firstNotify };
}

function sseBody(events: Array<{ type: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
      }
      controller.close();
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AcpAgent', () => {
  test('initialize reports protocol version and capabilities', async () => {
    const agent = new AcpAgent('localhost', 24337);
    const response = await agent.initialize({} as acp.InitializeRequest);
    expect(response.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(response.agentInfo!.name).toBe('aiderdesk');
    expect(response.agentInfo!.version).toBeTruthy();
    expect(response.agentCapabilities!.loadSession).toBe(true);
    expect(response.agentCapabilities!.promptCapabilities).toEqual({ image: true, embeddedContext: true });
    expect(response.agentCapabilities!.sessionCapabilities).toEqual({
      list: {},
      delete: {},
      resume: {},
    });
    expect(response.authMethods!).toEqual([]);
  });

  test('authenticate is a no-op', async () => {
    const agent = new AcpAgent('localhost', 24337);
    await expect(agent.authenticate({} as acp.AuthenticateRequest)).resolves.toEqual({});
  });

  test('newSession fetches profiles, modes and project defaults', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () =>
      new Response(JSON.stringify([{ id: 'default', name: 'Default' }, { id: 'senior', name: 'Senior' }]), { status: 200 }),
    );
    router.add('GET', '/api/project/settings', () =>
      new Response(JSON.stringify({ agentProfileId: 'senior' }), { status: 200 }),
    );
    router.add('GET', '/api/project/custom-modes', () =>
      new Response(JSON.stringify([{ name: 'review', label: 'Review', description: 'Review changes' }]), { status: 200 }),
    );
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const response = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    expect(response.sessionId).toBe('task-1'); // session id is the eagerly created server task id
    const optionIds = response.configOptions!.map((o) => o.id);
    expect(optionIds).toEqual(['chat_mode', 'agent_profile', 'autonomy_mode']);
    const modeOption = selectById(response.configOptions, 'chat_mode');
    expect(modeOption.currentValue).toBe('agent');
    expect(modeOption.options).toHaveLength(6); // 5 built-in + 1 custom
    const profileOption = selectById(response.configOptions, 'agent_profile');
    expect(profileOption.currentValue).toBe('senior'); // project default wins
    expect(response.modes!.currentModeId).toBe('agent');
  });

  test('newSession advertises available commands and built-ins', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(
        JSON.stringify({
          customCommands: [{ name: 'test', description: 'Run tests', arguments: [{ description: 'suite' }] }],
          extensionCommands: [{ name: 'summarize', description: 'Summarize the conversation', arguments: [] }],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls, firstNotify } = mockContext();
    await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
    await firstNotify;

    const update = notifyCalls.find((c) => c.method === acp.methods.client.session.update);
    const updateParams = update?.params as { update: { sessionUpdate: string; availableCommands: Array<{ name: string; description: string; input?: { hint: string } }> } };
    expect(updateParams.update.sessionUpdate).toBe('available_commands_update');
    expect(updateParams.update.availableCommands).toEqual([
      { name: 'compact', description: 'Compact the conversation', input: { hint: '1: custom compact instructions (optional)' } },
      { name: 'handoff', description: 'Hand off the conversation with a focus note', input: { hint: '1: focus note (optional)' } },
      { name: 'load', description: 'Load a task (by id or the #number shown in /tasks)', input: { hint: '1: task id or task number' } },
      { name: 'new', description: 'Start a new task', input: { hint: '1: task name (optional)' } },
      { name: 'smart-compact', description: 'Compact the conversation with an AI-generated summary' },
      { name: 'summarize', description: 'Summarize the conversation' },
      { name: 'tasks', description: 'List the tasks for the current project' },
      { name: 'test', description: 'Run tests', input: { hint: '1: suite' } },
    ]);
  });

  test('session/load advertises available commands after the replayed history', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(
        JSON.stringify({
          customCommands: [{ name: 'release', description: 'Cut a release', arguments: [] }],
          extensionCommands: [],
        }),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(JSON.stringify([{ id: 'task-9', baseDir: '/proj', name: 'Restored' }]), { status: 200 }),
    );
    router.add('POST', '/api/project/tasks/load', () =>
      new Response(JSON.stringify({ messages: [{ type: 'user', id: 'u1', content: 'hello' }] }), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    await agent.loadSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);
    // Deferred on purpose: the response must be on the wire before the advert.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updates = notifyCalls
      .filter((c) => c.method === acp.methods.client.session.update)
      .map(
        (c) =>
          c.params as {
            update: { sessionUpdate: string; availableCommands?: Array<{ name: string }> };
          },
      );
    const kinds = updates.map((p) => p.update.sessionUpdate);

    expect(kinds.indexOf('user_message_chunk')).toBeLessThan(kinds.indexOf('available_commands_update'));
    expect(updates.at(-1)!.update.sessionUpdate).toBe('available_commands_update');
    expect(updates.at(-1)!.update.availableCommands!.map((c) => c.name)).toEqual([
      'compact',
      'handoff',
      'load',
      'new',
      'release',
      'smart-compact',
      'tasks',
    ]);
  });

  test('session/resume advertises available commands', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(
        JSON.stringify({
          customCommands: [{ name: 'release', description: 'Cut a release', arguments: [] }],
          extensionCommands: [],
        }),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(JSON.stringify([{ id: 'task-9', baseDir: '/proj', name: 'Resumed' }]), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    await agent.resumeSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const advert = notifyCalls
      .filter((c) => c.method === acp.methods.client.session.update)
      .map(
        (c) =>
          c.params as {
            update: { sessionUpdate: string; availableCommands?: Array<{ name: string }> };
          },
      )
      .find((p) => p.update.sessionUpdate === 'available_commands_update');

    expect(advert?.update.availableCommands?.map((c) => c.name)).toEqual([
      'compact',
      'handoff',
      'load',
      'new',
      'release',
      'smart-compact',
      'tasks',
    ]);
  });

  test('prompt translates SSE events into ACP session updates', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          { type: 'response-chunk', data: { messageId: 'm1', reasoning: 'Let me think', chunk: 'Hello' } },
          { type: 'tool', data: { id: 't1', toolName: 'file_read', args: { filePath: '/a.ts' }, finished: false } },
          { type: 'tool', data: { id: 't1', toolName: 'file_read', args: { filePath: '/a.ts' }, response: 'file body', finished: true } },
          { type: 'response-completed', data: { messageId: 'm1', reasoning: 'Let me think', usageReport: { sentTokens: 10, receivedTokens: 20, agentTotalCost: 0.5 } } },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200, headers: { 'x-task-id': 'task-123' } },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx);

    expect(result).toEqual({
      stopReason: 'end_turn',
      usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 },
    });

    const updates = notifyCalls
      .filter((c) => c.method === acp.methods.client.session.update)
      .map((c) => (c.params as { update: { sessionUpdate: string } }).update.sessionUpdate);

    expect(updates).toContain('agent_thought_chunk');
    expect(updates).toContain('agent_message_chunk');
    expect(updates).toContain('tool_call');
    expect(updates).toContain('tool_call_update');
    expect(updates).toContain('usage_update');

    const messageChunk = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_message_chunk';
    })!;
    expect(((messageChunk.params as { update: { content: { text: string } } }).update.content.text)).toBe('Hello');

    const toolCall = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; title?: string; kind?: string } };
      return p.update.sessionUpdate === 'tool_call';
    })!;
    const toolParams = toolCall.params as { update: { title: string; kind: string; status: string; locations: Array<{ path: string }> } };
    expect(toolParams.update.title).toBe('Read: /a.ts');
    expect(toolParams.update.kind).toBe('read');
    expect(toolParams.update.status).toBe('in_progress');
    expect(toolParams.update.locations).toEqual([{ path: '/a.ts' }]);

    const usageUpdate = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; used?: number } };
      return p.update.sessionUpdate === 'usage_update';
    })!;
    const usageParams = usageUpdate.params as { update: { used: number; cost?: { amount: number; currency: string } } };
    expect(usageParams.update.used).toBe(30); // sent + received + cacheRead
    expect(usageParams.update.cost).toEqual({ amount: 0.5, currency: 'USD' });
  });

  test('prompt accumulates session usage across turns', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'response-completed',
            data: {
              messageId: 'm1',
              usageReport: { sentTokens: 10, receivedTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
            },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200, headers: { 'x-task-id': 'task-123' } },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const first = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'first' }] }, cx);
    const second = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'second' }] }, cx);

    expect(first.usage).toEqual({
      totalTokens: 20,
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 3,
      cachedWriteTokens: 2,
    });
    expect(second.usage).toEqual({
      totalTokens: 40,
      inputTokens: 20,
      outputTokens: 10,
      cachedReadTokens: 6,
      cachedWriteTokens: 4,
    });
  });

  test('prompt returns end_turn immediately for empty content', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt({ sessionId: session.sessionId, prompt: [] }, cx);
    expect(result).toEqual({ stopReason: 'end_turn' });
    const runPromptCalls = router.callsMatching(/\/api\/run-prompt/);
    expect(runPromptCalls).toHaveLength(0);
  });

  test('cancel aborts the stream and interrupts the server task', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('POST', '/api/run-prompt', (call) => {
      const signal = call.init?.signal;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`event: response-chunk\ndata: ${JSON.stringify({ messageId: 'm1', chunk: 'first' })}\n\n`),
          );
          // Mirror real fetch behavior: aborting the request signal errors
          // the response body stream, unblocking the pending reader.
          signal?.addEventListener(
            'abort',
            () => {
              controller.error(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'x-task-id': 'task-123' },
      });
    });
    router.add('POST', '/api/project/interrupt', () => new Response('{}', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, firstNotify } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const promptPromise = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx);

    await firstNotify; // first chunk processed, stream is now held open
    await agent.cancel({ sessionId: session.sessionId });

    const result = await promptPromise;
    expect(result).toEqual({ stopReason: 'cancelled' });

    const interruptCalls = router.callsMatching(/\/api\/project\/interrupt/);
    expect(interruptCalls).toHaveLength(1);
    expect(JSON.parse(String(interruptCalls[0].init?.body))).toEqual({ projectDir: '/proj', taskId: 'task-1' });
  });

  test('setConfigOption updates session state and returns fresh options', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const config = await agent.setConfigOption({
      sessionId: session.sessionId,
      configId: 'autonomy_mode',
      value: 'autonomous',
    });
    expect(config.configOptions.find((o) => o.id === 'autonomy_mode')!.currentValue).toBe('autonomous');

    await expect(
      agent.setConfigOption({ sessionId: 'missing', configId: 'autonomy_mode', value: 'manual' }),
    ).rejects.toThrow('Session not found');
  });

  test('setConfigOption with model updates the selection and persists it to the task', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/models', () =>
      new Response(
        JSON.stringify({
          models: [
            { id: 'gpt-5', providerId: 'openai-compatible' },
            { id: 'claude-sonnet-4', providerId: 'anthropic', name: 'Claude Sonnet 4' },
          ],
        }),
        { status: 200 },
      ),
    );
    router.add('POST', /\/api\/project\/tasks$/, () => new Response('{}', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const config = await agent.setConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'openai-compatible/gpt-5',
    });
    expect(selectById(config.configOptions, 'model').currentValue).toBe('openai-compatible/gpt-5');

    const taskUpdates = router.callsMatching(/\/api\/project\/tasks$/);
    expect(taskUpdates).toHaveLength(1);
    expect(JSON.parse(String(taskUpdates[0].init?.body))).toEqual({
      projectDir: '/proj',
      id: 'task-1',
      updates: { provider: 'openai-compatible', model: 'gpt-5' },
    });
  });

  test('newSession advertises the model the agent profile runs, not the first offered', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () =>
      new Response(
        JSON.stringify([{ id: 'default', name: 'Default', provider: 'openai-compatible', model: 'deepseek' }]),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/models', () =>
      new Response(
        JSON.stringify({
          models: [
            { id: 'Idol', providerId: 'openai-compatible' },
            { id: 'deepseek', providerId: 'openai-compatible' },
            { id: 'hidden-model', providerId: 'openai-compatible', isHidden: true },
          ],
        }),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/providers', () =>
      new Response(JSON.stringify([{ id: 'openai-compatible', name: 'Local' }]), { status: 200 }),
    );
    router.add('GET', '/api/settings', () =>
      new Response(JSON.stringify({ preferredModels: ['openai-compatible/deepseek'] }), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const response = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const modelOption = selectById(response.configOptions, 'model');
    expect(modelOption.currentValue).toBe('openai-compatible/deepseek');
    expect(modelOption.options).toEqual([
      {
        group: 'preferred',
        name: 'Preferred',
        options: [{ value: 'openai-compatible/deepseek', name: 'deepseek' }],
      },
      {
        group: 'openai-compatible',
        name: 'Local',
        options: [{ value: 'openai-compatible/Idol', name: 'Idol' }],
      },
    ]);
  });

  test('prompt expands a custom command and streams it through run-prompt', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(
        JSON.stringify({
          customCommands: [
            {
              name: 'test',
              description: 'Run tests',
              arguments: [{ description: 'suite' }],
              template: 'Run the {{1}} suite',
            },
          ],
          extensionCommands: [],
        }),
        { status: 200 },
      ),
    );
    let seenBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/run-prompt', (call) => {
      seenBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(
        sseBody([
          { type: 'response-chunk', data: { messageId: 'm1', chunk: 'Running tests now...' } },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200, headers: { 'x-task-id': 'task-1' } },
      );
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/test unit' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(seenBody).toEqual(
      expect.objectContaining({ prompt: 'Run the unit suite', projectDir: '/proj', mode: 'agent', autonomyMode: 'guided' }),
    );

    const chunk = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_message_chunk';
    })!;
    expect(((chunk.params as { update: { content: { text: string } } }).update.content.text)).toBe('Running tests now...');
  });

  test('session task is created eagerly and reused across prompts', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(
        JSON.stringify({
          customCommands: [
            { name: 'plan', description: 'Plan', arguments: [], template: 'Create a plan for {{1}}' },
          ],
          extensionCommands: [],
        }),
        { status: 200 },
      ),
    );
    const bodies: Array<{ taskId?: string }> = [];
    let promptCount = 0;
    router.add('POST', '/api/run-prompt', (call) => {
      const body = JSON.parse(String(call.init?.body)) as { taskId?: string };
      bodies.push(body);
      const chunk = promptCount === 0 ? 'first' : 'second';
      promptCount++;
      return new Response(
        sseBody([
          { type: 'response-chunk', data: { messageId: 'm1', chunk } },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200, headers: { 'x-task-id': 'task-1' } },
      );
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/plan alpha' }] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/plan beta' }] }, cx);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].taskId).toBe('task-1'); // task created eagerly at newSession
    expect(bodies[1].taskId).toBe('task-1'); // reused for subsequent commands
    const chunks = notifyCalls
      .filter((c) => {
        const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
        return p.update.sessionUpdate === 'agent_message_chunk';
      })
      .map((c) => ((c.params as { update: { content: { text: string } } }).update.content.text));
    expect(chunks).toContain('first');
    expect(chunks).toContain('second');
  });

  test('extension command falls back to the server with a created task', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(
        JSON.stringify({
          customCommands: [],
          extensionCommands: [{ name: 'summarize', description: 'Summarize the conversation', arguments: [] }],
        }),
        { status: 200 },
      ),
    );
    router.add('POST', '/api/project/tasks/new', () =>
      new Response(JSON.stringify({ id: 'task-1' }), { status: 200 }),
    );
    let customCommandBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/custom-commands', (call) => {
      customCommandBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response('{}', { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/summarize' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(customCommandBody).toEqual({
      projectDir: '/proj',
      taskId: 'task-1',
      commandName: 'summarize',
      args: [],
      mode: 'agent',
    });
    expect(router.callsMatching(/\/api\/project\/tasks\/new/)).toHaveLength(1);
    expect(router.callsMatching(/\/api\/run-prompt/)).toHaveLength(0);
  });

  test('unknown slash text passes through as a regular prompt', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    let seenPrompt = '';
    router.add('POST', '/api/run-prompt', (call) => {
      seenPrompt = (JSON.parse(String(call.init?.body)) as { prompt: string }).prompt;
      return new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/not-a-command hi' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(seenPrompt).toBe('/not-a-command hi');
  });

  test('custom command with missing required arguments reports an error without calling the server', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(
        JSON.stringify({
          customCommands: [
            {
              name: 'review',
              description: 'Request a review',
              arguments: [{ description: 'what to review' }],
              template: 'Review {{1}} please',
            },
          ],
          extensionCommands: [],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/review' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(router.callsMatching(/\/api\/run-prompt/)).toHaveLength(0);
    const thought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    expect(((thought.params as { update: { content: { text: string } } }).update.content.text)).toContain(
      "Not enough arguments for command 'review'",
    );
  });

  test('/new creates a task and makes it the session task', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    const newTaskBodies: Array<Record<string, unknown>> = [];
    router.add('POST', '/api/project/tasks/new', (call) => {
      newTaskBodies.push(JSON.parse(String(call.init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'task-new' }), { status: 200 });
    });
    let seenRunPrompt: Record<string, unknown> | undefined;
    router.add('POST', '/api/run-prompt', (call) => {
      seenRunPrompt = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/new Fix login flow' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(newTaskBodies).toEqual([
      { projectDir: '/proj' }, // eager task created at session start
      { projectDir: '/proj', name: 'Fix login flow' },
    ]);
    expect(router.callsMatching(/\/api\/run-prompt/)).toHaveLength(0);

    // The new task is reused by the next regular prompt.
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'go' }] }, cx);
    expect(seenRunPrompt?.taskId).toBe('task-new');
  });

  test('/new without a name still creates a task', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    const newTaskBodies: Array<Record<string, unknown>> = [];
    router.add('POST', '/api/project/tasks/new', (call) => {
      newTaskBodies.push(JSON.parse(String(call.init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'task-new' }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/new' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(newTaskBodies).toEqual([
      { projectDir: '/proj' }, // eager task created at session start
      { projectDir: '/proj' },
    ]);
  });

  test('/compact posts to compact-conversation with mode and custom instructions', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    let seenBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/compact-conversation', (call) => {
      seenBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: 'Conversation compacted' }), { status: 200 });
    });
    let contextReads = 0;
    router.add('GET', '/api/readonly/tasks/task-1', () => {
      contextReads += 1;
      // The compaction replaces a long conversation with one summary message,
      // so the context read before it is much larger than the one after.
      const messages =
        contextReads === 1
          ? [
              { type: 'user', messageId: 'm0', content: 'hello' },
              { type: 'response-completed', messageId: 'm1', content: 'x'.repeat(40_000) },
            ]
          : [
              { type: 'user', messageId: 'm0', content: 'hello' },
              { type: 'response-completed', messageId: 'm2', content: 'The condensed summary.' },
            ];
      return new Response(JSON.stringify({ messages }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    // Establish a task id like a first prompt would.
    router.add('POST', '/api/run-prompt', () =>
      new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200, headers: { 'x-task-id': 'task-1' } }),
    );
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/compact focus on APIs' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(seenBody).toEqual({
      projectDir: '/proj',
      taskId: 'task-1',
      mode: 'agent',
      customInstructions: 'focus on APIs',
    });
    expect(router.callsMatching(/\/api\/run-prompt/)).toHaveLength(1); // only the "hello" prompt
    const summaryThought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    expect(((summaryThought.params as { update: { content: { text: string } } }).update.content.text)).toContain(
      'The condensed summary.',
    );
  });

  test('/compact without a task reports it without calling the server', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    // Eager task creation at session start fails, so the session has no task.
    router.add('POST', '/api/project/tasks/new', () => new Response('boom', { status: 500 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/compact' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(router.callsMatching(/\/api\/project\/compact-conversation/)).toHaveLength(0);
    expect(router.callsMatching(/\/api\/run-prompt/)).toHaveLength(0);
    const thought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    expect(((thought.params as { update: { content: { text: string } } }).update.content.text)).toContain(
      'No conversation to compact yet',
    );
  });

  test('/smart-compact posts to smart-compact-conversation', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    let seenBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/smart-compact-conversation', (call) => {
      seenBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: 'Conversation smart-compacted' }), { status: 200 });
    });
    let contextReads = 0;
    router.add('GET', '/api/readonly/tasks/task-1', () => {
      contextReads += 1;
      const messages =
        contextReads === 1
          ? [{ type: 'response-completed', messageId: 'm1', content: 'x'.repeat(20_000) }]
          : [{ type: 'response-completed', messageId: 'm2', content: 'Smart summary.' }];
      return new Response(JSON.stringify({ messages }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
    router.add('POST', '/api/run-prompt', () =>
      new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200, headers: { 'x-task-id': 'task-1' } }),
    );
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/smart-compact' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(seenBody).toEqual({ projectDir: '/proj', taskId: 'task-1' });
    const summaryThought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    expect(((summaryThought.params as { update: { content: { text: string } } }).update.content.text)).toContain(
      'Smart summary.',
    );
  });

  test('/smart-compact reports a no-op instead of relaying a fake summary', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/project/smart-compact-conversation', () =>
      new Response(JSON.stringify({ message: 'Conversation smart-compacted' }), { status: 200 }),
    );
    // The context is identical before and after: smart compaction rewrote nothing.
    router.add('GET', '/api/readonly/tasks/task-1', () =>
      new Response(
        JSON.stringify({
          messages: [{ type: 'response-completed', messageId: 'm2', content: 'Replied in the DM.' }],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
    router.add('POST', '/api/run-prompt', () =>
      new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200, headers: { 'x-task-id': 'task-1' } }),
    );
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/smart-compact' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    const thoughts = notifyCalls
      .filter((c) => (c.params as { update: { sessionUpdate: string } }).update.sessionUpdate === 'agent_thought_chunk')
      .map((c) => (c.params as { update: { content: { text: string } } }).update.content.text);
    const last = thoughts[thoughts.length - 1];
    expect(last).toContain('Nothing to compact');
    expect(last).not.toContain('Replied in the DM.');
  });

  test('/compact falls back to the plain note when the summary cannot be fetched', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/project/compact-conversation', () =>
      new Response(JSON.stringify({ message: 'Conversation compacted' }), { status: 200 }),
    );
    // No /api/readonly/tasks/task-1 route: the fetch fails and must be tolerated.
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
    router.add('POST', '/api/run-prompt', () =>
      new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200, headers: { 'x-task-id': 'task-1' } }),
    );
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/compact' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    const thought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    expect(((thought.params as { update: { content: { text: string } } }).update.content.text)).toContain(
      'Conversation compacted.',
    );
  });

  test('/handoff and /hand-off post to handoff-conversation and rebind the session task', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    const bodies: Array<Record<string, unknown>> = [];
    router.add('POST', '/api/project/handoff-conversation', (call) => {
      bodies.push(JSON.parse(String(call.init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ message: 'Conversation handed off', taskId: `task-${bodies.length + 1}` }),
        { status: 200 },
      );
    });
    const runPromptBodies: Array<Record<string, unknown>> = [];
    router.add('POST', '/api/run-prompt', (call) => {
      runPromptBodies.push(JSON.parse(String(call.init?.body)) as Record<string, unknown>);
      return new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200, headers: { 'x-task-id': 'task-1' } });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, cx);

    await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/hand-off continue the refactor' }] },
      cx,
    );
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/handoff' }] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'continue the work' }] }, cx);

    expect(bodies).toEqual([
      { projectDir: '/proj', taskId: 'task-1', focus: 'continue the refactor' },
      { projectDir: '/proj', taskId: 'task-2' },
    ]);
    // The session follows each handoff: the second handoff targets the first's new task,
    // and the prompt after handoff targets the second handoff's new task.
    expect(runPromptBodies.at(-1)).toMatchObject({ taskId: 'task-3' });
    expect(router.callsMatching(/\/api\/run-prompt/)).toHaveLength(2);
  });

  test('/handoff without a task reports it without calling the server', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    // Eager task creation at session start fails, so the session has no task.
    router.add('POST', '/api/project/tasks/new', () => new Response('boom', { status: 500 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/handoff' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(router.callsMatching(/\/api\/project\/handoff-conversation/)).toHaveLength(0);
  });

  test('built-in command failure reports the error without crashing the session', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/project/tasks/new', () => new Response('boom', { status: 500 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/new' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    const thought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    expect(((thought.params as { update: { content: { text: string } } }).update.content.text)).toContain(
      "Failed to run command '/new'",
    );
  });

  test('newSession falls back to a local session id when eager task creation fails', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/project/tasks/new', () => new Response('boom', { status: 500 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    expect(session.sessionId.startsWith('acp-')).toBe(true);
    // The task is created lazily by the first prompt instead.
    let seenBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/run-prompt', (call) => {
      seenBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200, headers: { 'x-task-id': 'task-lazy' } });
    });
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx);
    expect(seenBody?.taskId).toBeUndefined();
  });

  test('session/list_input_history returns the project input history', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/project/input-history', () =>
      new Response(JSON.stringify(['fix the failing test', 'review git staged diff']), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const response = await agent.listInputHistory({ cwd: '/proj' });

    expect(response).toEqual({ inputs: ['fix the failing test', 'review git staged diff'] });
    expect(router.callsMatching(/\/api\/project\/input-history/)).toHaveLength(1);
  });

  test('session/list_input_history degrades to an empty list when the server is unavailable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    expect(await agent.listInputHistory({ cwd: '/proj' })).toEqual({ inputs: [] });
  });

  test('session/list maps server tasks to session infos, hiding archived ones', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([
          { id: 'task-1', baseDir: '/proj', name: 'Fix login', archived: false, updatedAt: '2026-08-28T10:00:00Z' },
          { id: 'task-2', baseDir: '/proj', name: 'Refactor', updatedAt: '2026-08-27T09:00:00Z' },
          { id: 'task-3', baseDir: '/proj', name: 'Old', archived: true },
        ]),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const response = await agent.listSessions({ cwd: '/proj' });

    expect(response.sessions).toEqual([
      { sessionId: 'task-1', cwd: '/proj', title: 'Fix login', updatedAt: '2026-08-28T10:00:00Z' },
      { sessionId: 'task-2', cwd: '/proj', title: 'Refactor', updatedAt: '2026-08-27T09:00:00Z' },
    ]);
    // The project is opened before listing so existing tasks are visible.
    expect(router.callsMatching(/\/api\/project\/add-open/)).toHaveLength(1);
  });

  test('session/list degrades to an empty list when the server is unavailable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    expect(await agent.listSessions({ cwd: '/proj' })).toEqual({ sessions: [] });
  });

  test('session/list orders sessions newest-created first, undated last', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([
          { id: 'task-old', baseDir: '/proj', name: 'Oldest', createdAt: '2026-01-01T00:00:00Z' },
          { id: 'task-new', baseDir: '/proj', name: 'Newest', createdAt: '2026-03-01T00:00:00Z' },
          { id: 'task-undated', baseDir: '/proj', name: 'Undated' },
          { id: 'task-mid', baseDir: '/proj', name: 'Middle', createdAt: '2026-02-01T00:00:00Z' },
        ]),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const response = await agent.listSessions({ cwd: '/proj' });

    expect(response.sessions.map((session) => session.sessionId)).toEqual([
      'task-new',
      'task-mid',
      'task-old',
      'task-undated',
    ]);
  });

  test('session/load binds the session to the task and replays the conversation', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(JSON.stringify([{ id: 'task-9', baseDir: '/proj', name: 'Loaded' }]), { status: 200 }),
    );
    router.add('POST', '/api/project/tasks/load', () =>
      new Response(
        JSON.stringify({
          messages: [
            { type: 'user', id: 'u1', content: 'hello' },
            { type: 'response-completed', messageId: 'r1', content: 'world', reasoning: 'think' },
            { type: 'tool', id: 't1', toolName: 'bash', args: { command: 'ls' }, response: 'files', finished: true },
          ],
        }),
        { status: 200 },
      ),
    );
    let seenRunPrompt: Record<string, unknown> | undefined;
    router.add('POST', '/api/run-prompt', (call) => {
      seenRunPrompt = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const response = await agent.loadSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);

    expect(response.modes?.currentModeId).toBe('agent');
    expect(response.configOptions?.map((o) => o.id)).toEqual(['chat_mode', 'agent_profile', 'autonomy_mode']);

    const updates = notifyCalls
      .filter((c) => c.method === acp.methods.client.session.update)
      .map((c) => (c.params as { update: { sessionUpdate: string } }).update.sessionUpdate);
    // The task's title is announced first, then the conversation; a replayed
    // tool call sends the `tool_call` that carries its name before the result.
    expect(updates).toEqual([
      'session_info_update',
      'user_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
    ]);

    // The loaded session is bound to the task: the next prompt targets it.
    await agent.prompt({ sessionId: 'task-9', prompt: [{ type: 'text', text: 'continue' }] }, cx);
    expect(seenRunPrompt?.taskId).toBe('task-9');
  });

  test('session/resume binds the session and asks the server to resume the task', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([{ id: 'task-9', baseDir: '/proj', name: 'Resumed', state: 'IN_PROGRESS' }]),
        { status: 200 },
      ),
    );
    let seenBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/resume-task', (call) => {
      seenBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: 'Task resumed' }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    await agent.resumeSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);

    expect(seenBody).toEqual({ projectDir: '/proj', taskId: 'task-9' });
  });

  test('session/load adopts the task settings and title, not the project defaults', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () =>
      new Response(
        JSON.stringify([
          { id: 'default', name: 'Power Tools' },
          { id: 'writer', name: 'Test Writer' },
        ]),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/settings', () => new Response('{"agentProfileId":"default"}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/models', () =>
      new Response(
        JSON.stringify({
          models: [
            { id: 'default-model', providerId: 'openai-compatible', name: 'Default' },
            { id: 'task-model', providerId: 'openai-compatible', name: 'Task' },
          ],
        }),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([
          {
            id: 'task-9',
            baseDir: '/proj',
            name: 'Restored task',
            agentProfileId: 'writer',
            autonomyMode: 'autonomous',
            provider: 'openai-compatible',
            model: 'task-model',
            currentMode: 'agent',
          },
        ]),
        { status: 200 },
      ),
    );
    router.add('POST', '/api/project/tasks/load', () => new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const response = await agent.loadSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);

    const configOptions = response.configOptions ?? [];
    expect(selectById(configOptions, 'agent_profile').currentValue).toBe('writer');
    expect(selectById(configOptions, 'autonomy_mode').currentValue).toBe('autonomous');
    expect(selectById(configOptions, 'model').currentValue).toBe('openai-compatible/task-model');

    const titleUpdate = notifyCalls
      .map((c) => c.params as { update?: { sessionUpdate?: string; title?: string } })
      .find((p) => p.update?.sessionUpdate === 'session_info_update');
    expect(titleUpdate?.update?.title).toBe('Restored task');
  });

  test('session/resume does not re-run a task that is idle', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([{ id: 'task-9', baseDir: '/proj', name: 'Idle', state: 'READY_FOR_REVIEW' }]),
        { status: 200 },
      ),
    );
    router.add('POST', '/api/project/resume-task', () => new Response('{}', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const response = await agent.resumeSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);

    expect(response.modes?.currentModeId).toBe('agent');
    expect(router.callsMatching(/resume-task/)).toHaveLength(0);
  });

  test('session/resume re-runs an idle task when AIDER_DESK_ACP_RESUME_TASK forces it', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([{ id: 'task-9', baseDir: '/proj', name: 'Idle', state: 'READY_FOR_REVIEW' }]),
        { status: 200 },
      ),
    );
    router.add('POST', '/api/project/resume-task', () => new Response('{}', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    process.env.AIDER_DESK_ACP_RESUME_TASK = '1';
    try {
      const agent = new AcpAgent('localhost', 24337);
      const { cx } = mockContext();
      await agent.resumeSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);

      expect(router.callsMatching(/resume-task/)).toHaveLength(1);
    } finally {
      delete process.env.AIDER_DESK_ACP_RESUME_TASK;
    }
  });

  test('session/delete removes the session and deletes its task', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    let seenBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/tasks/delete', (call) => {
      seenBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: 'Task deleted' }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    await agent.deleteSession({ sessionId: session.sessionId });

    expect(seenBody).toEqual({ projectDir: '/proj', id: session.sessionId });
  });

  test('/tasks lists the project tasks in a thought chunk', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([
          { id: 'task-1', baseDir: '/proj', name: 'Fix login', state: 'completed' },
          { id: 'task-2', baseDir: '/proj', name: 'Refactor' },
        ]),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/tasks' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(router.callsMatching(/\/api\/run-prompt/)).toHaveLength(0);
    const thought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    const text = ((thought.params as { update: { content: { text: string } } }).update.content.text);
    expect(text).toContain('Tasks (2)');
    expect(text).toContain('1. Fix login [task-1] (completed)');
    expect(text).toContain('2. Refactor [task-2]');
  });

  test('/tasks numbers the newest task first, so /load #1 targets it', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([
          { id: 'task-old', baseDir: '/proj', name: 'Oldest', createdAt: '2026-01-01T00:00:00Z' },
          { id: 'task-new', baseDir: '/proj', name: 'Newest', createdAt: '2026-03-01T00:00:00Z' },
        ]),
        { status: 200 },
      ),
    );
    let seenRunPrompt: Record<string, unknown> | undefined;
    router.add('POST', '/api/run-prompt', (call) => {
      seenRunPrompt = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/tasks' }] }, cx);

    const thought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    const text = (thought.params as { update: { content: { text: string } } }).update.content.text;
    expect(text).toContain('1. Newest [task-new]');
    expect(text).toContain('2. Oldest [task-old]');

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/load #1' }] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'continue' }] }, cx);
    expect(seenRunPrompt?.taskId).toBe('task-new');
  });

  test('/load switches the session task by id and by listing number', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([
          { id: 'task-9', baseDir: '/proj', name: 'First' },
          { id: 'task-10', baseDir: '/proj', name: 'Second' },
        ]),
        { status: 200 },
      ),
    );
    const runPromptBodies: Array<Record<string, unknown>> = [];
    router.add('POST', '/api/run-prompt', (call) => {
      runPromptBodies.push(JSON.parse(String(call.init?.body)) as Record<string, unknown>);
      return new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/load task-9' }] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/load #2' }] }, cx);

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'continue' }] }, cx);
    expect(runPromptBodies.at(-1)?.taskId).toBe('task-10');
  });

  test('/load with an unknown target reports an error', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(JSON.stringify([{ id: 'task-9', baseDir: '/proj', name: 'First' }]), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    const result = await agent.prompt(
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/load nope' }] },
      cx,
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(router.callsMatching(/\/api\/run-prompt/)).toHaveLength(0);
    const thought = notifyCalls.find((c) => {
      const p = c.params as { update: { sessionUpdate: string; content?: { text: string } } };
      return p.update.sessionUpdate === 'agent_thought_chunk';
    })!;
    expect(((thought.params as { update: { content: { text: string } } }).update.content.text)).toContain(
      "No task matching 'nope'",
    );
  });
  test('session/new writes the standing prompt as a project rules file', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    let seenRunPrompt: Record<string, unknown> | undefined;
    router.add('POST', '/api/run-prompt', (call) => {
      seenRunPrompt = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(sseBody([{ type: 'stream-end', data: {} }]), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    const projectDir = mkdtempSync(join(tmpdir(), 'acp-standing-prompt-'));
    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession(
      {
        cwd: projectDir,
        mcpServers: [],
        _meta: { systemPromptOverride: 'Always answer in Czech.' },
      } as unknown as acp.NewSessionRequest,
      cx,
    );

    const rulesPath = join(projectDir, '.aider-desk', 'rules', 'raft-standing-prompt.md');
    const content = readFileSync(rulesPath, 'utf8');
    expect(content.startsWith('<!-- managed by aiderdesk-acp-bridge')).toBe(true);
    expect(content).toContain('Always answer in Czech.');

    // The prompt lives in the system prompt now, so the turn carries only the
    // user's own text.
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, cx);
    expect(seenRunPrompt?.prompt).toBe('hello');
  });

  test('session/load fails when the task no longer exists', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () => new Response('[]', { status: 200 }));
    router.add('POST', '/api/project/tasks/load', () => new Response('{}', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();

    await expect(agent.loadSession({ sessionId: 'gone', cwd: '/proj', mcpServers: [] }, cx)).rejects.toThrow(
      /Session not found: gone/,
    );
  });

  test('session/load replays only the tail when AIDER_DESK_ACP_REPLAY=tail', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    const messages = Array.from({ length: 30 }, (_, index) => ({
      type: 'user',
      id: `u${index}`,
      content: `message ${index}`,
    }));
    router.add('GET', '/api/project/tasks', () =>
      new Response(JSON.stringify([{ id: 'task-9', baseDir: '/proj', name: 'Loaded' }]), { status: 200 }),
    );
    router.add('POST', '/api/project/tasks/load', () => new Response(JSON.stringify({ messages }), { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    process.env.AIDER_DESK_ACP_REPLAY = 'tail';
    try {
      const agent = new AcpAgent('localhost', 24337);
      const { cx, notifyCalls } = mockContext();
      await agent.loadSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);

      const replayed = notifyCalls
        .filter((c) => c.method === acp.methods.client.session.update)
        .filter((c) => (c.params as { update: { sessionUpdate: string } }).update.sessionUpdate !== 'session_info_update');
      expect(replayed).toHaveLength(20);
    } finally {
      delete process.env.AIDER_DESK_ACP_REPLAY;
    }
  });

  test('prompt auto-answers a blocking question when enabled', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'ask-question',
            data: {
              baseDir: '/proj',
              taskId: 'task-1',
              text: 'Run the tests?',
              answers: [
                { text: '(Y)es', shortkey: 'y' },
                { text: '(N)o', shortkey: 'n' },
              ],
            },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      ),
    );
    let answerBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/answer-question', (call) => {
      answerBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: 'Answer submitted' }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    process.env.AIDER_DESK_ACP_AUTO_ANSWER = '1';
    try {
      const agent = new AcpAgent('localhost', 24337);
      const { cx } = mockContext();
      const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

      await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'go' }] }, cx);

      expect(answerBody).toEqual({ projectDir: '/proj', taskId: 'task-1', answer: 'y' });
    } finally {
      delete process.env.AIDER_DESK_ACP_AUTO_ANSWER;
    }
  });

  test('prompt leaves questions unanswered unless auto-answer is enabled', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'ask-question',
            data: { baseDir: '/proj', taskId: 'task-1', text: 'Run the tests?', answers: [] },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'go' }] }, cx);

    expect(router.callsMatching(/\/api\/project\/answer-question/)).toHaveLength(0);
  });

  test('a session without a standing prompt keeps another session rules file', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    let created = 0;
    router.add('POST', '/api/project/tasks/new', () =>
      new Response(JSON.stringify({ id: `task-${++created}` }), { status: 200 }),
    );
    globalThis.fetch = router.router as typeof fetch;

    const projectDir = mkdtempSync(join(tmpdir(), 'acp-shared-rules-'));
    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();
    await agent.newSession(
      {
        cwd: projectDir,
        mcpServers: [],
        _meta: { systemPromptOverride: 'Rule from client A' },
      } as unknown as acp.NewSessionRequest,
      cx,
    );
    const rulesPath = join(projectDir, '.aider-desk', 'rules', 'raft-standing-prompt.md');
    expect(readFileSync(rulesPath, 'utf8')).toContain('Rule from client A');

    await agent.newSession({ cwd: projectDir, mcpServers: [] }, cx);

    expect(readFileSync(rulesPath, 'utf8')).toContain('Rule from client A');
  });

  test('session/load reports a failed task list as an error, not a missing session', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () => new Response('boom', { status: 500 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();

    const error = (await agent
      .loadSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx)
      .catch((caught: unknown) => caught)) as Error;
    expect(error.message).toMatch(/task list request failed/);
    // A server hiccup must not read as "start a fresh session".
    expect(error.message).not.toMatch(/Session not found/);
  });

  test('session/resume fails when the task no longer exists', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/project/tasks', () => new Response('[]', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx } = mockContext();

    await expect(agent.resumeSession({ sessionId: 'gone', cwd: '/proj', mcpServers: [] }, cx)).rejects.toThrow(
      /Session not found: gone/,
    );
  });

  test('the standing-prompt fallback echoes only the user text', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    let seenRunPrompt: Record<string, unknown> | undefined;
    router.add('POST', '/api/run-prompt', (call) => {
      seenRunPrompt = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(
        sseBody([
          { type: 'user-message', data: { messageId: 'm-1' } },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      );
    });
    globalThis.fetch = router.router as typeof fetch;

    // A regular file where the project directory should be makes the rules file
    // impossible to create, forcing the documented fallback.
    const root = mkdtempSync(join(tmpdir(), 'acp-no-rules-'));
    const projectDir = join(root, 'not-a-directory');
    writeFileSync(projectDir, 'x');

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession(
      {
        cwd: projectDir,
        mcpServers: [],
        _meta: { systemPromptOverride: 'SECRET STANDING PROMPT' },
      } as unknown as acp.NewSessionRequest,
      cx,
    );

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, cx);

    // The prompt still reaches the model ...
    expect(String(seenRunPrompt?.prompt)).toContain('SECRET STANDING PROMPT');
    // ... but the client is not told the user said it.
    const echoes = notifyCalls.filter(
      (call) => (call.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate === 'user_message_chunk',
    );
    expect(echoes).toHaveLength(1);
    expect((echoes[0].params as { update: { content: { text: string } } }).update.content.text).toBe('hello');
  });

  test('auto-answer submits one answer and never "a" by default', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'ask-question',
            data: {
              baseDir: '/proj',
              taskId: 'task-1',
              text: 'Add file from prompt to context?',
              defaultAnswer: 'y',
              answers: [
                { text: '(Y)es', shortkey: 'y' },
                { text: '(N)o', shortkey: 'n' },
                { text: '(A)ll', shortkey: 'a' },
              ],
            },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      ),
    );
    let answerBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/answer-question', (call) => {
      answerBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: 'Answer submitted' }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    process.env.AIDER_DESK_ACP_AUTO_ANSWER = '1';
    try {
      const agent = new AcpAgent('localhost', 24337);
      const { cx } = mockContext();
      const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
      await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'go' }] }, cx);

      // `a` would be remembered for the rest of the task; a single `y` is not.
      expect(answerBody).toEqual({ projectDir: '/proj', taskId: 'task-1', answer: 'y' });
    } finally {
      delete process.env.AIDER_DESK_ACP_AUTO_ANSWER;
    }
  });

  test('auto-answer picks "a" only in always mode', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'ask-question',
            data: {
              baseDir: '/proj',
              taskId: 'task-1',
              text: 'Add every detected file?',
              defaultAnswer: 'y',
              answers: [
                { text: '(Y)es', shortkey: 'y' },
                { text: '(A)ll', shortkey: 'a' },
              ],
            },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      ),
    );
    let answerBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/answer-question', (call) => {
      answerBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: 'Answer submitted' }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    process.env.AIDER_DESK_ACP_AUTO_ANSWER = '1';
    process.env.AIDER_DESK_ACP_AUTO_ANSWER_MODE = 'always';
    try {
      const agent = new AcpAgent('localhost', 24337);
      const { cx } = mockContext();
      const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
      await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'go' }] }, cx);

      expect(answerBody).toEqual({ projectDir: '/proj', taskId: 'task-1', answer: 'a' });
    } finally {
      delete process.env.AIDER_DESK_ACP_AUTO_ANSWER;
      delete process.env.AIDER_DESK_ACP_AUTO_ANSWER_MODE;
    }
  });

  test('auto-answer declines a free-text question instead of saying "y"', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'ask-question',
            data: { baseDir: '/proj', taskId: 'task-1', text: 'Which environment?', answers: [] },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      ),
    );
    let answerBody: Record<string, unknown> | undefined;
    router.add('POST', '/api/project/answer-question', (call) => {
      answerBody = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: 'Answer submitted' }), { status: 200 });
    });
    globalThis.fetch = router.router as typeof fetch;

    process.env.AIDER_DESK_ACP_AUTO_ANSWER = '1';
    try {
      const agent = new AcpAgent('localhost', 24337);
      const { cx, notifyCalls } = mockContext();
      const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
      await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'go' }] }, cx);

      expect(answerBody).toEqual({ projectDir: '/proj', taskId: 'task-1', answer: 'n' });
      const thoughts = notifyCalls
        .map((call) => (call.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })?.update)
        .filter((update) => update?.sessionUpdate === 'agent_thought_chunk')
        .map((update) => update?.content?.text ?? '');
      expect(thoughts.some((text) => text.includes('declined'))).toBe(true);
    } finally {
      delete process.env.AIDER_DESK_ACP_AUTO_ANSWER;
    }
  });

  test('usage_update carries the context window of the model the turn ran on', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () =>
      new Response(
        JSON.stringify([{ id: 'default', name: 'Default', provider: 'openai-compatible', model: 'ctx-model' }]),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/settings', () =>
      new Response(JSON.stringify({ agentProfileId: 'default' }), { status: 200 }),
    );
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/models', () =>
      new Response(
        JSON.stringify({
          // The agent profile's model runs with a known window; the other one
          // reports none, so a session switched to it has no window to show.
          models: [
            { id: 'ctx-model', providerId: 'openai-compatible', maxInputTokens: 262144 },
            { id: 'unknown-model', providerId: 'openai-compatible' },
          ],
        }),
        { status: 200 },
      ),
    );
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'response-completed',
            data: { messageId: 'm1', usageReport: { sentTokens: 100, receivedTokens: 20, cacheReadTokens: 900 } },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx);

    const usageUpdates = notifyCalls
      .filter((call) => call.method === acp.methods.client.session.update)
      .map((call) => (call.params as { update: { sessionUpdate: string; used?: number; size?: number } }).update)
      .filter((update) => update.sessionUpdate === 'usage_update');

    // `used` is the turn's whole prompt (sent + received + cache read) and
    // `size` the model's window, which is what a client header renders.
    expect(usageUpdates.at(-1)).toEqual({ sessionUpdate: 'usage_update', used: 1020, size: 262144 });
  });

  test('switching model republishes the context window', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () =>
      new Response(
        JSON.stringify([{ id: 'default', name: 'Default', provider: 'openai-compatible', model: 'ctx-model' }]),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/models', () =>
      new Response(
        JSON.stringify({
          models: [
            { id: 'ctx-model', providerId: 'openai-compatible', maxInputTokens: 262144 },
            { id: 'big-model', providerId: 'openai-compatible', maxInputTokens: 1000000 },
          ],
        }),
        { status: 200 },
      ),
    );
    router.add('POST', /\/api\/project\/tasks$/, () => new Response('{}', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);

    await agent.setConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'openai-compatible/big-model',
    });

    const sizes = notifyCalls
      .filter((call) => call.method === acp.methods.client.session.update)
      .map((call) => (call.params as { update: { sessionUpdate: string; size?: number } }).update)
      .filter((update) => update.sessionUpdate === 'usage_update')
      .map((update) => update.size);

    expect(sizes.at(-1)).toBe(1000000);
  });

  test('session/load seeds context usage from the stored conversation', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/models', () =>
      new Response(
        JSON.stringify({ models: [{ id: 'ctx-model', providerId: 'openai-compatible', maxInputTokens: 200000 }] }),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/tasks', () =>
      new Response(
        JSON.stringify([
          { id: 'task-9', baseDir: '/proj', name: 'Loaded', provider: 'openai-compatible', model: 'ctx-model' },
        ]),
        { status: 200 },
      ),
    );
    router.add('POST', '/api/project/tasks/load', () =>
      new Response(
        JSON.stringify({
          messages: [
            { type: 'user', id: 'u1', content: 'hello' },
            {
              type: 'response-completed',
              messageId: 'r1',
              content: 'world',
              usageReport: { sentTokens: 1000, receivedTokens: 50, cacheReadTokens: 2000 },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    await agent.loadSession({ sessionId: 'task-9', cwd: '/proj', mcpServers: [] }, cx);

    const usageUpdate = notifyCalls
      .map((call) => (call.params as { update?: { sessionUpdate?: string; used?: number; size?: number } })?.update)
      .find((update) => update?.sessionUpdate === 'usage_update');

    expect(usageUpdate).toEqual({ sessionUpdate: 'usage_update', used: 3050, size: 200000 });
  });

  test('/compact republishes a lowered context figure', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () =>
      new Response(
        JSON.stringify([{ id: 'default', name: 'Default', provider: 'openai-compatible', model: 'ctx-model' }]),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/settings', () => new Response(JSON.stringify({ agentProfileId: 'default' }), { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/models', () =>
      new Response(
        JSON.stringify({ models: [{ id: 'ctx-model', providerId: 'openai-compatible', maxInputTokens: 200000 }] }),
        { status: 200 },
      ),
    );
    router.add('POST', '/api/project/compact-conversation', () =>
      new Response(JSON.stringify({ message: 'Conversation compacted' }), { status: 200 }),
    );
    // 20,000 characters before the compaction become 2,000 after it.
    let contextReads = 0;
    router.add('GET', '/api/readonly/tasks/task-1', () => {
      contextReads += 1;
      return new Response(
        JSON.stringify({
          messages: [{ type: 'response-completed', messageId: 'm1', content: 'x'.repeat(contextReads === 1 ? 20_000 : 2_000) }],
        }),
        { status: 200 },
      );
    });
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'response-completed',
            data: { messageId: 'm1', usageReport: { sentTokens: 1000, receivedTokens: 100, cacheReadTokens: 9000 } },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/compact' }] }, cx);

    const useds = notifyCalls
      .map((call) => (call.params as { update?: { sessionUpdate?: string; used?: number } })?.update)
      .filter((update) => update?.sessionUpdate === 'usage_update')
      .map((update) => update?.used);

    // The turn cost 10,100 tokens over 20,000 characters; the compacted
    // transcript is 2,000 characters, so the header drops to ~1,010 instead of
    // keeping the pre-compaction figure until the next prompt.
    expect(useds.slice(-2)).toEqual([10_100, 1_010]);
  });

  test('/new resets the published context figure', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () =>
      new Response(
        JSON.stringify([{ id: 'default', name: 'Default', provider: 'openai-compatible', model: 'ctx-model' }]),
        { status: 200 },
      ),
    );
    router.add('GET', '/api/project/settings', () => new Response(JSON.stringify({ agentProfileId: 'default' }), { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/commands', () =>
      new Response(JSON.stringify({ customCommands: [], extensionCommands: [] }), { status: 200 }),
    );
    router.add('GET', '/api/models', () =>
      new Response(
        JSON.stringify({ models: [{ id: 'ctx-model', providerId: 'openai-compatible', maxInputTokens: 200000 }] }),
        { status: 200 },
      ),
    );
    router.add('POST', '/api/run-prompt', () =>
      new Response(
        sseBody([
          {
            type: 'response-completed',
            data: { messageId: 'm1', usageReport: { sentTokens: 1000, receivedTokens: 100, cacheReadTokens: 9000 } },
          },
          { type: 'stream-end', data: {} },
        ]),
        { status: 200 },
      ),
    );
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const { cx, notifyCalls } = mockContext();
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx);
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: '/new' }] }, cx);

    const useds = notifyCalls
      .map((call) => (call.params as { update?: { sessionUpdate?: string; used?: number } })?.update)
      .filter((update) => update?.sessionUpdate === 'usage_update')
      .map((update) => update?.used);

    // A task with no turn yet occupies nothing, so the header clears instead of
    // keeping the previous task's figure.
    expect(useds.slice(-2)).toEqual([10_100, 0]);
  });
});
