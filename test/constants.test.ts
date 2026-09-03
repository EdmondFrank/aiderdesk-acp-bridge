import { afterEach, describe, expect, test } from 'bun:test';

import { getTimeoutFromEnv } from '../src/constants';

const ENV_NAME = 'AIDER_DESK_TEST_TIMEOUT_MS';

const original = process.env[ENV_NAME];

afterEach(() => {
  if (original === undefined) {
    delete process.env[ENV_NAME];
  } else {
    process.env[ENV_NAME] = original;
  }
});

describe('getTimeoutFromEnv', () => {
  test('returns the parsed milliseconds value', () => {
    process.env[ENV_NAME] = '45000';
    expect(getTimeoutFromEnv(ENV_NAME, 10_000)).toBe(45_000);
  });

  test('ignores a trailing unit suffix', () => {
    process.env[ENV_NAME] = '90000ms';
    expect(getTimeoutFromEnv(ENV_NAME, 10_000)).toBe(90_000);
  });

  test('falls back to the default when unset or blank', () => {
    delete process.env[ENV_NAME];
    expect(getTimeoutFromEnv(ENV_NAME, 10_000)).toBe(10_000);
    process.env[ENV_NAME] = '';
    expect(getTimeoutFromEnv(ENV_NAME, 10_000)).toBe(10_000);
  });

  test('falls back to the default on non-numeric or non-positive values', () => {
    for (const value of ['abc', '0', '-5']) {
      process.env[ENV_NAME] = value;
      expect(getTimeoutFromEnv(ENV_NAME, 10_000)).toBe(10_000);
    }
  });
});
