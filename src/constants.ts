export const DEFAULT_HOST = 'localhost';
export const DEFAULT_PORT = 24337;

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