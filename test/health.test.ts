import { describe, expect, test } from 'bun:test';

import { waitForHealth, type HealthProbe } from '../src/health';

const probeSequence = (results: Array<{ ok: boolean; reason?: string }>): HealthProbe => {
  let index = 0;
  return async () => results[Math.min(index++, results.length - 1)];
};

describe('waitForHealth', () => {
  test('returns immediately when the first probe succeeds', async () => {
    const result = await waitForHealth(probeSequence([{ ok: true }]), { budgetMs: 5000 });
    expect(result).toEqual({ ok: true, attempts: 1 });
  });

  test('keeps probing until the server answers', async () => {
    let clock = 0;
    const retries: number[] = [];
    const result = await waitForHealth(
      probeSequence([
        { ok: false, reason: 'connect ECONNREFUSED' },
        { ok: false, reason: 'connect ECONNREFUSED' },
        { ok: true },
      ]),
      {
        budgetMs: 10_000,
        intervalMs: 1000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        onRetry: (attempt) => retries.push(attempt),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  test('gives up once the budget is spent and reports the last reason', async () => {
    let clock = 0;
    const result = await waitForHealth(probeSequence([{ ok: false, reason: 'status 503' }]), {
      budgetMs: 2500,
      intervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('status 503');
    expect(result.attempts).toBe(3);
  });

  test('a zero budget probes exactly once', async () => {
    let calls = 0;
    const result = await waitForHealth(
      async () => {
        calls += 1;
        return { ok: false, reason: 'refused' };
      },
      { budgetMs: 0 },
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: false, attempts: 1, reason: 'refused' });
  });
});