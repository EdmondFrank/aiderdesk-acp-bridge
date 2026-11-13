import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';

import type { ExtensionContext, OptimizeMessagesEvent } from '@aiderdesk/extensions';

import RaftPolicyExtension from '../raft-shim/raft-policy/index';
import type { PolicyMessage } from '../raft-shim/raft-policy/policy';

const projectDir = `${homedir()}/.raft/agents/extension-test`;

const context = {
  getProjectDir: () => projectDir,
  log: () => undefined,
} as unknown as ExtensionContext;

const toolResult = (id: string, chars: number): PolicyMessage =>
  ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'lua---code_mode',
        output: { type: 'content', value: [{ type: 'text', text: 'x'.repeat(chars) }] },
      },
    ],
  }) as unknown as PolicyMessage;

const textSizes = (messages: PolicyMessage[]): number[] =>
  messages.map((message) => JSON.stringify((message as { content: unknown }).content).length);

const withEnv = async (vars: Record<string, string>, run: () => Promise<void>): Promise<void> => {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

describe('RaftPolicyExtension write-back', () => {
  test('cuts the message objects the host handed in, not only the return value', async () => {
    await withEnv(
      {
        AIDERDESK_RAFT_KEEP_TOOL_RESULTS: '1',
        AIDERDESK_RAFT_TOOL_RESULT_MAX_CHARS: '400',
        AIDERDESK_RAFT_TOOL_RESULT_BUDGET_CHARS: '400',
      },
      async () => {
        const messages = [toolResult('a', 4000), toolResult('b', 4000), toolResult('c', 4000)];
        const before = textSizes(messages);
        const event = {
          originalMessages: messages,
          optimizedMessages: messages,
        } as unknown as OptimizeMessagesEvent;

        const result = await new RaftPolicyExtension().onOptimizeMessages(event, context);

        // The host drops the returned array on some builds, so the event's own
        // array must carry the cut as well.
        expect(JSON.stringify(messages)).toContain('elided by raft-policy');
        const after = textSizes(messages);
        expect(after[0]).toBeLessThan(before[0]);
        expect(after[1]).toBeLessThan(before[1]);
        expect(after[2]).toBe(before[2]);

        const returned = (result as Partial<OptimizeMessagesEvent>).optimizedMessages;
        expect(returned).toBe(messages as unknown as OptimizeMessagesEvent['optimizedMessages']);
      },
    );
  });

  test('leaves an ordinary project untouched', async () => {
    await withEnv({ AIDERDESK_RAFT_TOOL_RESULT_MAX_CHARS: '400' }, async () => {
      const messages = [toolResult('a', 4000), toolResult('b', 4000), toolResult('c', 4000)];
      const before = JSON.stringify(messages);
      const ordinary = {
        getProjectDir: () => '/tmp/not-a-raft-agent',
        log: () => undefined,
      } as unknown as ExtensionContext;
      const event = {
        originalMessages: messages,
        optimizedMessages: messages,
      } as unknown as OptimizeMessagesEvent;

      const result = await new RaftPolicyExtension().onOptimizeMessages(event, ordinary);

      expect(result).toBeUndefined();
      expect(JSON.stringify(messages)).toBe(before);
    });
  });
});