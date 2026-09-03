import { getTimeoutFromEnv } from './constants';

/** Default budget for plain JSON REST calls, which never wait on the model. */
const DEFAULT_JSON_TIMEOUT_MS = 10_000;

/**
 * Default budget for model-waiting calls: opening an SSE turn
 * (`POST /api/run-prompt`) and the compaction/handoff endpoints that block
 * until the model answers. The deadline covers the *whole* request lifetime,
 * so it caps total turn duration, not just connection time; 30 minutes matches
 * the AiderDesk server's own outbound provider timeout.
 */
const DEFAULT_SSE_TIMEOUT_MS = 30 * 60_000;

/** Overridable with `AIDER_DESK_JSON_TIMEOUT_MS` (milliseconds). */
export const JSON_TIMEOUT_MS = getTimeoutFromEnv('AIDER_DESK_JSON_TIMEOUT_MS', DEFAULT_JSON_TIMEOUT_MS);

/** Overridable with `AIDER_DESK_SSE_TIMEOUT_MS` (milliseconds). */
export const SSE_CONNECT_TIMEOUT_MS = getTimeoutFromEnv('AIDER_DESK_SSE_TIMEOUT_MS', DEFAULT_SSE_TIMEOUT_MS);

export type JsonResponse = {
  status: number;
  data: unknown;
};

function baseUrl(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Perform a JSON request against the AiderDesk REST API.
 * Returns the HTTP status and the parsed body (raw text when not JSON).
 * `timeoutMs` defaults to the standard JSON timeout; pass a larger value for
 * endpoints that may wait on the model (e.g. compact conversation).
 */
export async function fetchJSON(
  host: string,
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
  timeoutMs: number = JSON_TIMEOUT_MS,
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${baseUrl(host, port)}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  return { status: response.status, data: parseBody(raw) };
}

/** Minimal shape of a task context message returned by the readonly API. */
export type TaskReadMessage = {
  type?: string;
  messageId?: string;
  content?: string;
};

/**
 * Fetch a task's current context messages via `GET /api/readonly/tasks/:taskId`.
 * Returns `undefined` on any failure so callers degrade gracefully (used to
 * surface the compacted summary after `/compact`).
 */
export async function fetchTask(
  host: string,
  port: number,
  projectDir: string,
  taskId: string,
): Promise<TaskReadMessage[] | undefined> {
  try {
    const response = await fetchJSON(
      host,
      port,
      `/api/readonly/tasks/${encodeURIComponent(taskId)}?projectDir=${encodeURIComponent(projectDir)}`,
      'GET',
    );
    if (response.status !== 200) {
      return undefined;
    }
    const messages = (response.data as { messages?: unknown } | undefined)?.messages;
    return Array.isArray(messages) ? (messages as TaskReadMessage[]) : undefined;
  } catch {
    return undefined;
  }
}

export type SSEStreamResult = {
  stream: ReadableStream<Uint8Array>;
  taskId: string;
};

/**
 * Open a streaming POST against an SSE endpoint on the AiderDesk server.
 * Resolves once response headers arrive and the task id is known.
 * Supported endpoints: `/api/run-prompt` and (for extension commands)
 * `/api/project/custom-commands` when the server streams events back.
 * `SSE_CONNECT_TIMEOUT_MS` bounds the entire request, including body
 * consumption, so a turn still streaming when the deadline fires is aborted.
 */
export async function requestSSEStream(
  host: string,
  port: number,
  path: string,
  body: string,
  signal?: AbortSignal,
): Promise<SSEStreamResult> {
  const response = await fetch(`${baseUrl(host, port)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
    body,
    signal: AbortSignal.any([AbortSignal.timeout(SSE_CONNECT_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });

  if (!response.ok || response.body === null) {
    const raw = await response.text();
    throw new Error(`Server returned ${response.status}: ${raw}`);
  }

  return {
    stream: response.body,
    taskId: response.headers.get('x-task-id') ?? '',
  };
}

/**
 * List a project's input history via `GET /api/project/input-history`.
 * Entries are the prompts the user has submitted in the project
 * (parsed by the server from `.aider.input.history`), newest first.
 * Returns an empty list on any failure so callers degrade gracefully.
 */
export async function fetchInputHistory(
  host: string,
  port: number,
  projectDir: string,
): Promise<string[]> {
  try {
    const response = await fetchJSON(
      host,
      port,
      `/api/project/input-history?projectDir=${encodeURIComponent(projectDir)}`,
      'GET',
    );
    if (response.status !== 200) {
      return [];
    }
    const history = response.data as string[];
    return Array.isArray(history) ? history.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** Ask the AiderDesk server to interrupt a running task (best-effort). */
export async function callInterrupt(host: string, port: number, projectDir: string, taskId: string): Promise<void> {
  await fetchJSON(host, port, '/api/project/interrupt', 'POST', JSON.stringify({ projectDir, taskId }));
}

/**
 * Ensure a project is open on the AiderDesk server (`POST /api/project/add-open`).
 * Task listing and creation require the project to be open. Best-effort: failures
 * are swallowed so callers degrade gracefully.
 */
export async function ensureProjectOpen(host: string, port: number, projectDir: string): Promise<void> {
  try {
    await fetchJSON(host, port, '/api/project/add-open', 'POST', JSON.stringify({ projectDir }));
  } catch {
    // best-effort
  }
}

/** Summary of a task as exposed by `GET /api/project/tasks`, used for listings. */
export type TaskSummary = {
  id: string;
  baseDir: string;
  name: string;
  state?: string;
  archived?: boolean;
  updatedAt?: string;
};

/**
 * List the tasks for a project via `GET /api/project/tasks`.
 * Returns an empty list on any failure so callers degrade gracefully.
 */
export async function listTasks(
  host: string,
  port: number,
  projectDir: string,
): Promise<TaskSummary[]> {
  try {
    const response = await fetchJSON(
      host,
      port,
      `/api/project/tasks?projectDir=${encodeURIComponent(projectDir)}`,
      'GET',
    );
    if (response.status !== 200) {
      return [];
    }
    const tasks = response.data as TaskSummary[];
    return Array.isArray(tasks)
      ? tasks.map((t) => ({
          id: t.id,
          baseDir: t.baseDir,
          name: t.name,
          ...(t.state ? { state: t.state } : {}),
          ...(typeof t.archived === 'boolean' ? { archived: t.archived } : {}),
          ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
        }))
      : [];
  } catch {
    return [];
  }
}

/** A stored conversation message, as returned by `POST /api/project/tasks/load`. */
export type TaskStateMessage = {
  type: string;
  messageId?: string;
  id?: string;
  content?: string;
  reasoning?: string;
  toolName?: string;
  serverName?: string;
  args?: unknown;
  response?: string;
  finished?: boolean;
};

/** Full state of a task (conversation messages) via `POST /api/project/tasks/load`. */
export type TaskStateData = {
  messages: TaskStateMessage[];
};

/**
 * Load a task's full conversation state via `POST /api/project/tasks/load`.
 * Returns `undefined` on any failure so callers degrade gracefully.
 */
export async function loadTask(
  host: string,
  port: number,
  projectDir: string,
  taskId: string,
): Promise<TaskStateData | undefined> {
  try {
    const response = await fetchJSON(
      host,
      port,
      '/api/project/tasks/load',
      'POST',
      JSON.stringify({ projectDir, id: taskId }),
    );
    if (response.status !== 200) {
      return undefined;
    }
    const data = response.data as { messages?: unknown } | undefined;
    if (!data || !Array.isArray(data.messages)) {
      return undefined;
    }
    return { messages: data.messages as TaskStateMessage[] };
  } catch {
    return undefined;
  }
}

/** Ask the AiderDesk server to resume a task (`POST /api/project/resume-task`, best-effort). */
export async function resumeTask(host: string, port: number, projectDir: string, taskId: string): Promise<void> {
  try {
    await fetchJSON(host, port, '/api/project/resume-task', 'POST', JSON.stringify({ projectDir, taskId }));
  } catch {
    // best-effort
  }
}

/** Delete a task (`POST /api/project/tasks/delete`, best-effort). */
export async function deleteTask(host: string, port: number, projectDir: string, taskId: string): Promise<void> {
  try {
    await fetchJSON(host, port, '/api/project/tasks/delete', 'POST', JSON.stringify({ projectDir, id: taskId }));
  } catch {
    // best-effort
  }
}

/**
 * Create a task for a project via `POST /api/project/tasks/new` and return
 * its id. Used to give extension commands (which have no expandable template)
 * a task to run against.
 */
export async function createTask(
  host: string,
  port: number,
  projectDir: string,
  name?: string,
): Promise<string> {
  const response = await fetchJSON(
    host,
    port,
    '/api/project/tasks/new',
    'POST',
    JSON.stringify({ projectDir, ...(name ? { name } : {}) }),
  );
  if (response.status !== 200) {
    throw new Error(`Failed to create task: server returned ${response.status}`);
  }
  const data = response.data as { id?: string };
  if (!data?.id) {
    throw new Error(`Failed to create task: response missing id (${response.status})`);
  }
  return data.id;
}

/**
 * Update a task's model selection via `POST /api/project/tasks`. Best-effort:
 * failures are swallowed so the in-memory session selection still applies.
 */
export async function updateTaskModel(
  host: string,
  port: number,
  projectDir: string,
  taskId: string,
  provider: string,
  model: string,
): Promise<void> {
  try {
    await fetchJSON(
      host,
      port,
      '/api/project/tasks',
      'POST',
      JSON.stringify({ projectDir, id: taskId, updates: { provider, model } }),
    );
  } catch {
    // best-effort
  }
}

/** Ask the AiderDesk server to run an extension command (best-effort). */
export async function runCustomCommand(
  host: string,
  port: number,
  projectDir: string,
  taskId: string,
  commandName: string,
  args: string[],
  mode: string,
): Promise<void> {
  await fetchJSON(
    host,
    port,
    '/api/project/custom-commands',
    'POST',
    JSON.stringify({ projectDir, taskId, commandName, args, mode }),
  );
}

/**
 * Compact the conversation (`/compact`). The server waits for the model to
 * produce the compacted summary, so a long timeout is used.
 */
export async function compactConversation(
  host: string,
  port: number,
  projectDir: string,
  taskId: string,
  mode: string,
  customInstructions?: string,
): Promise<void> {
  await fetchJSON(
    host,
    port,
    '/api/project/compact-conversation',
    'POST',
    JSON.stringify({ projectDir, taskId, mode, ...(customInstructions ? { customInstructions } : {}) }),
    SSE_CONNECT_TIMEOUT_MS,
  );
}

/** Compact the conversation with an AI-generated summary (`/smart-compact`). */
export async function smartCompactConversation(
  host: string,
  port: number,
  projectDir: string,
  taskId: string,
): Promise<void> {
  await fetchJSON(
    host,
    port,
    '/api/project/smart-compact-conversation',
    'POST',
    JSON.stringify({ projectDir, taskId }),
    SSE_CONNECT_TIMEOUT_MS,
  );
}

/** Hand off the conversation to another agent (`/handoff`, `/hand-off`). Returns the new task id. */
export async function handoffConversation(
  host: string,
  port: number,
  projectDir: string,
  taskId: string,
  focus?: string,
): Promise<string | undefined> {
  const response = await fetchJSON(
    host,
    port,
    '/api/project/handoff-conversation',
    'POST',
    JSON.stringify({ projectDir, taskId, ...(focus ? { focus } : {}) }),
    SSE_CONNECT_TIMEOUT_MS,
  );
  const data = response.data as { taskId?: unknown } | undefined;
  return typeof data?.taskId === 'string' ? data.taskId : undefined;
}