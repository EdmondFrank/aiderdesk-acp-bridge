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
 */
export async function fetchJSON(
  host: string,
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${baseUrl(host, port)}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  });

  const raw = await response.text();
  return { status: response.status, data: parseBody(raw) };
}

export type SSEStreamResult = {
  stream: ReadableStream<Uint8Array>;
  taskId: string;
};

/**
 * Open a streaming POST to /api/run-prompt (Server-Sent Events).
 * Resolves once response headers arrive and the task id is known.
 */
export async function requestSSEStream(
  host: string,
  port: number,
  body: string,
  signal?: AbortSignal,
): Promise<SSEStreamResult> {
  const response = await fetch(`${baseUrl(host, port)}/api/run-prompt`, {
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