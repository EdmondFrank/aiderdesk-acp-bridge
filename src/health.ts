export type HealthProbe = () => Promise<{ ok: boolean; reason?: string }>;

export type WaitForHealthOptions = {
    /** Total time to keep probing. `0` probes exactly once. */
    budgetMs: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, reason: string) => void;
};

export type WaitForHealthResult = {
    ok: boolean;
    attempts: number;
    reason?: string;
};

/**
 * Poll a health probe until it succeeds or the budget runs out.
 *
 * The bridge starts as a child process of the agent runtime, so when AiderDesk
 * is restarted at the same time the first probe lands while its REST server is
 * still binding. Exiting on that probe makes Raft mark the agent `Crashed (exit
 * code 1)` and wait for a manual start, so the wait is part of the contract.
 */
export async function waitForHealth(
    probe: HealthProbe,
    options: WaitForHealthOptions,
): Promise<WaitForHealthResult> {
    const intervalMs = options.intervalMs ?? 1000;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + options.budgetMs;

    let attempts = 0;
    let reason: string | undefined;

    for (;;) {
        attempts += 1;
        const result = await probe();
        if (result.ok) {
            return { ok: true, attempts };
        }
        reason = result.reason;

        if (now() + intervalMs > deadline) {
            return { ok: false, attempts, reason };
        }
        options.onRetry?.(attempts, reason ?? 'unhealthy');
        await sleep(intervalMs);
    }
}