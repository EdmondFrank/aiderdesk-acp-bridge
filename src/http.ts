const JSON_TIMEOUT_MS = 10_000;
const SSE_CONNECT_TIMEOUT_MS = 600_000;

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

/** Ask the AiderDesk server to interrupt a running task (best-effort). */
export async function callInterrupt(host: string, port: number, projectDir: string, taskId: string): Promise<void> {
  await fetchJSON(host, port, '/api/project/interrupt', 'POST', JSON.stringify({ projectDir, taskId }));
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