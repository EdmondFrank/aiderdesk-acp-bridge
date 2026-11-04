import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Project-relative path of the rules file that carries an ACP client's
 * standing prompt. AiderDesk exposes every `.md` file under
 * `<project>/.aider-desk/rules/` to the system prompt (`<Knowledge><Rules>`,
 * re-read on every turn), so writing this file is how a standing prompt becomes
 * system text instead of a ~30 KB user message in the conversation.
 */
const RULES_RELATIVE_PATH = path.join('.aider-desk', 'rules', 'raft-standing-prompt.md');

/**
 * First line of the generated rules file. It identifies the file as ours and
 * records which session wrote it, so the bridge never deletes a prompt another
 * live session — in this process or in another one — is still using.
 */
const RULES_MARKER = '<!-- managed by aiderdesk-acp-bridge: ACP standing prompt';
const RULES_MARKER_PATTERN = /^<!-- managed by aiderdesk-acp-bridge: ACP standing prompt(?:; owner (\S+))? -->/;

const STATE_VERSION = 1;

/** Bounded so a long-lived machine does not accumulate session records forever. */
const MAX_SESSION_RECORDS = 500;

export type SessionRecord = {
  taskId: string;
  cwd: string;
  updatedAt: string;
};

type SessionMap = {
  version: number;
  sessions: Record<string, SessionRecord>;
};

function log(message: string): void {
  process.stderr.write(`[session-policy] ${message}\n`);
}

/** Absolute path of the rules file for a project directory. */
export function rulesFilePath(projectDir: string): string {
  return path.join(projectDir, RULES_RELATIVE_PATH);
}

/**
 * Owner recorded in the marker. `pid` lets another bridge process tell a live
 * owner from a stale file left behind by a previous run.
 */
function ownerTag(sessionId: string | undefined): string {
  return sessionId ? `${process.pid}:${sessionId}` : String(process.pid);
}

function ownerIsAlive(owner: string): boolean {
  const pid = Number.parseInt(owner.split(':')[0] ?? '', 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "alive, but owned by another user".
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Write a standing prompt as a project rules file so it is rendered into the
 * system prompt instead of the conversation history.
 *
 * The write is idempotent (unchanged content is left untouched, which keeps
 * the model's prompt cache warm) and atomic (temp file + rename), so a
 * concurrent turn never reads a half-written prompt.
 *
 * @returns `true` when the prompt is in place, `false` when the file could not
 * be written and the caller must fall back to prepending it to a prompt.
 */
export async function writeStandingPrompt(
  projectDir: string,
  prompt: string,
  sessionId?: string,
): Promise<boolean> {
  const trimmed = prompt.trim();
  if (!projectDir || !trimmed) {
    return false;
  }

  const filePath = rulesFilePath(projectDir);
  const content = `${RULES_MARKER}; owner ${ownerTag(sessionId)} -->\n${trimmed}\n`;

  try {
    const existing = await readFile(filePath, 'utf8');
    if (existing === content) {
      return true;
    }
  } catch {
    // missing or unreadable: (re)write below
  }

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
    return true;
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // nothing to clean up
    }
    log(`failed to write standing prompt file: ${String(error)}`);
    return false;
  }
}

/**
 * Remove the generated standing prompt file, but only when it still carries
 * our marker and no live session owns it. Used when a session starts without a
 * standing prompt so a stale prompt from another client cannot linger in the
 * system prompt — without deleting a prompt a second client is still using.
 */
export async function clearStandingPrompt(projectDir: string, sessionId?: string): Promise<void> {
  if (!projectDir) {
    return;
  }
  const filePath = rulesFilePath(projectDir);
  try {
    const existing = await readFile(filePath, 'utf8');
    const match = RULES_MARKER_PATTERN.exec(existing);
    if (!match) {
      return;
    }
    const owner = match[1];
    if (owner && owner !== ownerTag(sessionId) && ownerIsAlive(owner)) {
      return;
    }
    await rm(filePath, { force: true });
  } catch {
    // nothing to clear
  }
}

/** Directory holding the bridge's own state (overridable for tests). */
function stateDir(): string {
  return process.env.AIDER_DESK_ACP_STATE_DIR || path.join(homedir(), '.local', 'state', 'aiderdesk-acp');
}

function stateFilePath(): string {
  return path.join(stateDir(), 'sessions.json');
}

async function readSessionMap(): Promise<SessionMap> {
  try {
    const raw = await readFile(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionMap> | null;
    const sessions = parsed?.sessions;
    if (!sessions || typeof sessions !== 'object') {
      return { version: STATE_VERSION, sessions: {} };
    }
    return { version: STATE_VERSION, sessions: sessions as Record<string, SessionRecord> };
  } catch {
    return { version: STATE_VERSION, sessions: {} };
  }
}

async function writeSessionMap(map: SessionMap): Promise<void> {
  const filePath = stateFilePath();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

/**
 * Serialises read-modify-write cycles on the state file. Without it, two
 * sessions updated concurrently (`/new` in one, `/handoff` in another) both read
 * the same map and the last writer drops the other's record.
 */
let stateQueue: Promise<unknown> = Promise.resolve();

function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = stateQueue.then(operation, operation);
  stateQueue = run.catch(() => undefined);
  return run;
}

/**
 * Record which AiderDesk task an ACP session id currently maps to. The task id
 * stops being identical to the session id as soon as `/new` or `/handoff`
 * swaps the conversation, and ACP clients keep resuming by session id — so the
 * mapping has to outlive the bridge process.
 */
export async function rememberSessionTask(sessionId: string, taskId: string, cwd: string): Promise<void> {
  if (!sessionId || !taskId) {
    return;
  }
  try {
    await withStateLock(async () => {
      const map = await readSessionMap();
      map.sessions[sessionId] = { taskId, cwd, updatedAt: new Date().toISOString() };

      const entries = Object.entries(map.sessions);
      if (entries.length > MAX_SESSION_RECORDS) {
        entries
          .sort(([, a], [, b]) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(MAX_SESSION_RECORDS)
          .forEach(([staleId]) => delete map.sessions[staleId]);
      }

      await writeSessionMap(map);
    });
  } catch (error) {
    log(`failed to persist session mapping: ${String(error)}`);
  }
}

/** Current task id for an ACP session id, or `undefined` when unknown. */
export async function resolveSessionTask(sessionId: string): Promise<string | undefined> {
  if (!sessionId) {
    return undefined;
  }
  const map = await readSessionMap();
  return map.sessions[sessionId]?.taskId;
}

/** Drop a session's mapping (used after a task was deleted). */
export async function forgetSessionTask(sessionId: string): Promise<void> {
  try {
    await withStateLock(async () => {
      const map = await readSessionMap();
      if (map.sessions[sessionId]) {
        delete map.sessions[sessionId];
        await writeSessionMap(map);
      }
    });
  } catch (error) {
    log(`failed to drop session mapping: ${String(error)}`);
  }
}