import { describe, expect, test } from 'bun:test';

import {
  contextWindowFor,
  estimateContextTokens,
  lastContextTokensFrom,
  parseComposedModelId,
  resolveContextModel,
} from '../src/context-usage';

const models = [
  { id: 'gpt-5', providerId: 'openai-compatible', maxInputTokens: 400000 },
  { id: 'vendor/model-a', providerId: 'openrouter', maxInputTokens: 200000 },
  { id: 'no-window', providerId: 'openai-compatible' },
];

const profiles = [
  { id: 'default', name: 'Default', provider: 'openai-compatible', model: 'gpt-5' },
  { id: 'bare', name: 'Bare' },
];

function session(overrides: Partial<Parameters<typeof resolveContextModel>[0]> = {}) {
  return {
    models,
    mode: 'agent',
    agentProfileId: 'default',
    agentProfiles: profiles,
    ...overrides,
  };
}

describe('parseComposedModelId', () => {
  test('splits at the first slash, keeping slashes in the model id', () => {
    expect(parseComposedModelId('openrouter/vendor/model-a')).toEqual({
      provider: 'openrouter',
      model: 'vendor/model-a',
    });
  });

  test('rejects ids without both halves', () => {
    expect(parseComposedModelId(undefined)).toBeUndefined();
    expect(parseComposedModelId('gpt-5')).toBeUndefined();
    expect(parseComposedModelId('/gpt-5')).toBeUndefined();
    expect(parseComposedModelId('openrouter/')).toBeUndefined();
  });
});

describe('resolveContextModel', () => {
  test('prefers the session selection', () => {
    expect(resolveContextModel(session({ model: 'openrouter/vendor/model-a' }))).toEqual({
      provider: 'openrouter',
      model: 'vendor/model-a',
    });
  });

  test("uses the agent profile's model in agent modes", () => {
    expect(resolveContextModel(session())).toEqual({ provider: 'openai-compatible', model: 'gpt-5' });
  });

  test("uses the project's main model in Aider modes", () => {
    expect(
      resolveContextModel(session({ mode: 'code', agentProfileId: undefined, mainModel: 'openrouter/vendor/model-a' })),
    ).toEqual({ provider: 'openrouter', model: 'vendor/model-a' });
  });

  test('falls back to mainModel when the profile carries no model', () => {
    expect(
      resolveContextModel(
        session({ agentProfileId: 'bare', mainModel: 'openrouter/vendor/model-a' }),
      ),
    ).toEqual({ provider: 'openrouter', model: 'vendor/model-a' });
  });

  test('ignores models the server no longer lists', () => {
    expect(
      resolveContextModel(
        session({ model: 'openai-compatible/gone', agentProfileId: 'bare', mainModel: 'openai/gone' }),
      ),
    ).toBeUndefined();
  });
});

describe('contextWindowFor', () => {
  test("returns the model's max input tokens", () => {
    expect(contextWindowFor(session())).toBe(400000);
  });

  test('returns zero when the model reports no window', () => {
    expect(contextWindowFor(session({ model: 'openai-compatible/no-window' }))).toBe(0);
  });

  test('returns zero when no model can be resolved', () => {
    expect(contextWindowFor(session({ agentProfileId: 'bare' }))).toBe(0);
  });
});

describe('estimateContextTokens', () => {
  test('scales the characters at the ratio the last turn was billed at', () => {
    // 10,100 tokens for 20,000 characters is ~0.505 tokens per character.
    expect(estimateContextTokens(2_000, 10_100, 20_000)).toBe(1_010);
  });

  test('returns undefined when either side of the ratio is unknown', () => {
    expect(estimateContextTokens(2_000, undefined, 20_000)).toBeUndefined();
    expect(estimateContextTokens(2_000, 10_100, undefined)).toBeUndefined();
    expect(estimateContextTokens(undefined, 10_100, 20_000)).toBeUndefined();
  });

  test('rejects a ratio it cannot divide by', () => {
    expect(estimateContextTokens(2_000, 10_100, 0)).toBeUndefined();
    expect(estimateContextTokens(2_000, 0, 20_000)).toBeUndefined();
  });

  test('reports an empty context as zero', () => {
    expect(estimateContextTokens(0, 10_100, 20_000)).toBe(0);
  });
});

describe('lastContextTokensFrom', () => {
  test('sums the newest report (sent + received + cache read)', () => {
    expect(
      lastContextTokensFrom([
        { usageReport: { sentTokens: 1, receivedTokens: 1, cacheReadTokens: 1 } },
        { type: 'user' } as never,
        { usageReport: { sentTokens: 1000, receivedTokens: 50, cacheReadTokens: 2000, cacheWriteTokens: 7 } },
      ]),
    ).toBe(3050);
  });

  test('returns undefined when no report carries tokens', () => {
    expect(lastContextTokensFrom([{ type: 'user' } as never])).toBeUndefined();
    expect(lastContextTokensFrom([{ usageReport: { sentTokens: 0, receivedTokens: 0 } }])).toBeUndefined();
  });
});