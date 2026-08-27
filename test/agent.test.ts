import { afterEach, describe, expect, test } from 'bun:test';
import * as acp from '@agentclientprotocol/sdk';

import { AcpAgent } from '../src/agent';
import { selectById } from './helpers';

const originalFetch = globalThis.fetch;

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

  const router = async (url: string, init?: RequestInit): Promise<Response> => {
    const call = { url, init };
    calls.push(call);
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => r.method === method && r.match(url));
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
    expect(response.agentCapabilities!.loadSession).toBe(false);
    expect(response.agentCapabilities!.promptCapabilities).toEqual({ image: true, embeddedContext: true });
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
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const response = await agent.newSession({ cwd: '/proj', mcpServers: [] });

    expect(response.sessionId.startsWith('acp-')).toBe(true);
    const optionIds = response.configOptions!.map((o) => o.id);
    expect(optionIds).toEqual(['chat_mode', 'agent_profile', 'autonomy_mode']);
    const modeOption = selectById(response.configOptions, 'chat_mode');
    expect(modeOption.currentValue).toBe('agent');
    expect(modeOption.options).toHaveLength(6); // 5 built-in + 1 custom
    const profileOption = selectById(response.configOptions, 'agent_profile');
    expect(profileOption.currentValue).toBe('senior'); // project default wins
    expect(response.modes!.currentModeId).toBe('agent');
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
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] });
    const { cx, notifyCalls } = mockContext();

    const result = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx);

    expect(result).toEqual({ stopReason: 'end_turn' });

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

  test('prompt returns end_turn immediately for empty content', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] });
    const { cx } = mockContext();

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
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] });
    const { cx, firstNotify } = mockContext();

    const promptPromise = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] }, cx);

    await firstNotify; // first chunk processed, stream is now held open
    await agent.cancel({ sessionId: session.sessionId });

    const result = await promptPromise;
    expect(result).toEqual({ stopReason: 'cancelled' });

    const interruptCalls = router.callsMatching(/\/api\/project\/interrupt/);
    expect(interruptCalls).toHaveLength(1);
    expect(JSON.parse(String(interruptCalls[0].init?.body))).toEqual({ projectDir: '/proj', taskId: 'task-123' });
  });

  test('setConfigOption updates session state and returns fresh options', async () => {
    const router = createMockRouter();
    router.add('GET', '/api/agent-profiles', () => new Response('[]', { status: 200 }));
    router.add('GET', '/api/project/settings', () => new Response('{}', { status: 200 }));
    router.add('GET', '/api/project/custom-modes', () => new Response('[]', { status: 200 }));
    globalThis.fetch = router.router as typeof fetch;

    const agent = new AcpAgent('localhost', 24337);
    const session = await agent.newSession({ cwd: '/proj', mcpServers: [] });

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
});