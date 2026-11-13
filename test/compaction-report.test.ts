import { describe, expect, test } from 'bun:test';

import { COMPACTION_SHRINK_RATIO, contextCharsOf, evaluateCompaction, formatChars } from '../src/compaction-report';

describe('contextCharsOf', () => {
  test('sums the content of every message', () => {
    expect(contextCharsOf([{ content: 'abc' }, { content: 'de' }, {}])).toBe(5);
  });

  test('returns zero for an empty context', () => {
    expect(contextCharsOf([])).toBe(0);
  });

  test('returns undefined when the context could not be read', () => {
    expect(contextCharsOf(undefined)).toBeUndefined();
  });
});

describe('evaluateCompaction', () => {
  test('reports a shrink when the context got smaller', () => {
    const outcome = evaluateCompaction(800_000, 400_000);
    expect(outcome.shrank).toBe(true);
    expect(outcome.detail).toBe('781 KB -> 391 KB');
  });

  test('reports a no-op when the context is unchanged', () => {
    expect(evaluateCompaction(826_567, 826_567).shrank).toBe(false);
  });

  test('ignores a rounding-sized difference', () => {
    const justUnderThreshold = Math.floor(800_000 * COMPACTION_SHRINK_RATIO) + 1;
    expect(evaluateCompaction(800_000, justUnderThreshold).shrank).toBe(false);
  });

  test('accepts a shrink right at the threshold', () => {
    const justOverThreshold = Math.ceil(800_000 * COMPACTION_SHRINK_RATIO) - 1;
    expect(evaluateCompaction(800_000, justOverThreshold).shrank).toBe(true);
  });

  test('keeps the best-effort behaviour when either size is unknown', () => {
    expect(evaluateCompaction(undefined, 1000).shrank).toBe(true);
    expect(evaluateCompaction(1000, undefined).shrank).toBe(true);
    expect(evaluateCompaction(undefined, undefined).detail).toBe('context size unavailable');
  });

  test('treats a grown context as a no-op', () => {
    expect(evaluateCompaction(1000, 2000).shrank).toBe(false);
  });
});

describe('formatChars', () => {
  test('prints kilobytes', () => {
    expect(formatChars(2048)).toBe('2 KB');
  });

  test('describes an unknown size in words', () => {
    expect(formatChars(undefined)).toBe('an unknown size');
  });
});