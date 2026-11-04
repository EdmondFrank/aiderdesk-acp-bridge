import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_ELISION_OPTIONS,
  elideToolResults,
  elisionOptionsFromEnv,
  raftPolicyEnabled,
  type PolicyMessage,
} from '../raft-shim/raft-policy/policy';

type ContentPart = { type: 'text'; text: string } | { type: 'file'; data: string };

/**
 * A tool result shaped the way AiderDesk actually stores one: the AI SDK
 * `content` variant, a list of `text` and `file` parts.
 */
function toolMessage(parts: string | ContentPart[], id = 'call-1'): PolicyMessage {
  const value: ContentPart[] =
    typeof parts === 'string' ? [{ type: 'text', text: parts }] : parts;
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName: 'bash', output: { type: 'content', value } }],
  };
}

function outputOf(message: PolicyMessage): { type: string; value: ContentPart[] } {
  return (message.content as Array<{ output: { type: string; value: ContentPart[] } }>)[0].output;
}

function textOf(message: PolicyMessage): string {
  return outputOf(message)
    .value.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

describe('elideToolResults', () => {
  test('leaves the most recent results untouched', () => {
    const messages = [toolMessage('a'.repeat(2000)), toolMessage('b'.repeat(2000)), toolMessage('c'.repeat(2000))];
    const result = elideToolResults(messages, { keepRecent: 3, maxChars: 100, budgetChars: 0 });

    expect(result.stats.elided).toBe(0);
    expect(result.messages).toBe(messages);
  });

  test('cuts old long content results to a head plus a note', () => {
    const messages = [
      toolMessage('a'.repeat(2000), 'call-1'),
      toolMessage('b'.repeat(2000), 'call-2'),
      toolMessage('c'.repeat(10), 'call-3'),
    ];
    const result = elideToolResults(messages, { keepRecent: 1, maxChars: 100, budgetChars: 1_000_000 });

    expect(result.stats.elided).toBe(2);
    expect(textOf(result.messages[0])).toContain('elided by raft-policy');
    expect(textOf(result.messages[0]).length).toBeLessThan(500);
    // Untouched messages keep their identity so the prompt cache stays warm.
    expect(result.messages[2]).toBe(messages[2]);
    // The output stays in the `content` shape AiderDesk and the provider expect.
    expect(outputOf(result.messages[0]).type).toBe('content');
    // The original message is not mutated.
    expect(textOf(messages[0])).toBe('a'.repeat(2000));
  });

  test('keeps file parts when the text is elided', () => {
    const file: ContentPart = { type: 'file', data: 'base64-image' };
    const messages = [
      toolMessage([{ type: 'text', text: 'x'.repeat(2000) }, file], 'call-1'),
      toolMessage('recent', 'call-2'),
    ];
    const result = elideToolResults(messages, { keepRecent: 1, maxChars: 100, budgetChars: 1_000_000 });

    expect(result.stats.elided).toBe(1);
    const value = outputOf(result.messages[0]).value;
    expect(value).toHaveLength(2);
    expect(value[1]).toEqual(file);
    expect(textOf(result.messages[0]).length).toBeLessThan(500);
  });

  test('elides every text part of a multi-part content output', () => {
    const messages = [
      toolMessage([
        { type: 'text', text: 'first-'.repeat(200) },
        { type: 'text', text: 'second-'.repeat(200) },
      ]),
      toolMessage('recent', 'call-2'),
    ];
    const result = elideToolResults(messages, { keepRecent: 1, maxChars: 100, budgetChars: 1_000_000 });

    expect(result.stats.elided).toBe(1);
    const texts = outputOf(result.messages[0]).value.filter((part) => part.type === 'text');
    expect(texts).toHaveLength(1);
    expect((texts[0] as { text: string }).text.startsWith('first-first-')).toBe(true);
    expect((texts[0] as { text: string }).text).not.toContain('second-second-second');
  });

  test('ignores results too short to be worth cutting', () => {
    const messages = [toolMessage('a'.repeat(300)), toolMessage('b'.repeat(2000))];
    const result = elideToolResults(messages, { keepRecent: 1, maxChars: 100, budgetChars: 1_000_000 });

    expect(result.stats.elided).toBe(0);
  });

  test('cuts harder once the retained-character budget is exceeded', () => {
    const messages = [toolMessage('x'.repeat(2000)), toolMessage('y'.repeat(2000)), toolMessage('z'.repeat(2000))];
    const result = elideToolResults(messages, { keepRecent: 0, maxChars: 10_000, budgetChars: 1000 });

    expect(result.stats.elided).toBe(2);
    expect(textOf(result.messages[0]).length).toBeLessThan(600);
    expect(textOf(result.messages[2])).toBe('z'.repeat(2000));
  });

  test('still handles plain text outputs', () => {
    const messages: PolicyMessage[] = [
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-1', output: { type: 'text', value: 'a'.repeat(2000) } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-2', output: { type: 'text', value: 'recent' } }],
      },
    ];
    const result = elideToolResults(messages, { keepRecent: 1, maxChars: 100, budgetChars: 1_000_000 });

    expect(result.stats.elided).toBe(1);
    const output = (result.messages[0].content as Array<{ output: { type: string; value: string } }>)[0].output;
    expect(output.type).toBe('text');
    expect(output.value).toContain('elided by raft-policy');
  });

  test('leaves json and denied outputs alone', () => {
    const messages: PolicyMessage[] = [
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'x', output: { type: 'json', value: { any: true } } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'y', output: { type: 'execution-denied' } }],
      },
      toolMessage('b'.repeat(2000)),
    ];
    const result = elideToolResults(messages, { keepRecent: 1, maxChars: 100, budgetChars: 1_000_000 });

    expect(result.stats.elided).toBe(0);
    expect(result.messages).toBe(messages);
  });
});

describe('elisionOptionsFromEnv', () => {
  test('reads knobs and clamps them', () => {
    expect(elisionOptionsFromEnv({})).toEqual(DEFAULT_ELISION_OPTIONS);
    expect(
      elisionOptionsFromEnv({
        AIDERDESK_RAFT_KEEP_TOOL_RESULTS: '3',
        AIDERDESK_RAFT_TOOL_RESULT_MAX_CHARS: '900',
        AIDERDESK_RAFT_TOOL_RESULT_BUDGET_CHARS: '50000',
      }),
    ).toEqual({ keepRecent: 3, maxChars: 900, budgetChars: 50_000 });
    expect(elisionOptionsFromEnv({ AIDERDESK_RAFT_KEEP_TOOL_RESULTS: '-4' }).keepRecent).toBe(0);
  });
});

describe('raftPolicyEnabled', () => {
  test('applies to Raft agent workspaces only', () => {
    expect(raftPolicyEnabled('/Users/x/.raft/agents/abc', {})).toBe(true);
    expect(raftPolicyEnabled('/home/x/project', {})).toBe(false);
    expect(raftPolicyEnabled('/home/x/project', { AIDERDESK_RAFT_POLICY: '1' })).toBe(true);
    expect(raftPolicyEnabled('/Users/x/.raft/agents/abc', { AIDERDESK_RAFT_POLICY: '0' })).toBe(false);
  });
});