export const DEFAULT_HOST = 'localhost';
export const DEFAULT_PORT = 23456;

export function getPortFromEnv(): number | null {
  const envPort = process.env.AIDER_DESK_PORT;
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (port >= 1 && port <= 65535) return port;
  }
  return null;
}

export function getDefaultPort(): number {
  return getPortFromEnv() ?? DEFAULT_PORT;
}

export function resolvePort(port: number | undefined): number {
  return port ?? getDefaultPort();
}

/**
 * Read a duration in milliseconds from the environment, falling back to
 * `fallbackMs` when the variable is unset, blank, not a number, or not
 * positive. A bad value degrades to the default rather than disabling a
 * timeout altogether.
 */
export function getTimeoutFromEnv(envName: string, fallbackMs: number): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallbackMs;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

/**
 * Read a non-negative integer from the environment, where `0` is meaningful
 * (it disables the feature) — unlike `getTimeoutFromEnv`, which rejects it.
 */
function getCountFromEnv(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Context size above which a quiet session is compacted. Raft wakes an agent
 * sporadically, and every wake after the provider's prompt cache expired pays
 * for the whole context at input price, so shrinking it while the agent is
 * idle is what makes the next wake cheap. `0` disables the behaviour.
 */
export const IDLE_COMPACT_TOKENS = getCountFromEnv('AIDER_DESK_ACP_IDLE_COMPACT_TOKENS', 120_000);

/** How long a session must stay quiet before that compaction runs. */
export const IDLE_COMPACT_DELAY_MS = getTimeoutFromEnv('AIDER_DESK_ACP_IDLE_COMPACT_DELAY_MS', 180_000);

/**
 * Raft repeats its standing prompt as the first message; the bridge drops that
 * duplicate because the rules file already delivers it. Set to `0` to keep the
 * verbatim prompt.
 */
export const DEDUPE_STANDING_PROMPT = !/^(0|false|off|no)$/i.test(
  (process.env.AIDER_DESK_ACP_DEDUPE_STANDING_PROMPT ?? '').trim(),
);

/**
 * How long the bridge waits for AiderDesk's REST server at startup. Raft starts
 * the bridge as a child process, so restarting both at once means the first
 * probe can land before the server is listening; giving up immediately shows up
 * as `Crashed (exit code 1)` and needs a manual start. `0` probes once.
 */
export const START_HEALTH_WAIT_MS = getCountFromEnv('AIDER_DESK_ACP_START_WAIT_MS', 90_000);

export type ModeOption = {
  id: string;
  name: string;
  description?: string;
};

export const BUILT_IN_MODES: ModeOption[] = [
  { id: 'agent', name: 'Agent', description: 'Agent mode with full tool access' },
  { id: 'code', name: 'Code', description: 'Code mode using Aider for edits' },
  { id: 'ask', name: 'Ask', description: 'Ask questions without making changes' },
  { id: 'architect', name: 'Architect', description: 'Design and plan without implementation' },
  { id: 'context', name: 'Context', description: 'Add context files to the conversation' },
];

export const AIDER_MODES = ['code', 'ask', 'architect', 'context'];

export const AUTONOMY_MODES: ModeOption[] = [
  { id: 'manual', name: 'Manual', description: 'Requires approval for every tool and plan' },
  { id: 'guided', name: 'Guided', description: 'Auto-approves tools, waits for plan approval' },
  { id: 'autonomous', name: 'Autonomous', description: 'Runs without interruption' },
];

export const DEFAULT_MODE = 'agent';
export const DEFAULT_AUTONOMY_MODE = 'guided';