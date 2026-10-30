#!/usr/bin/env bun
/**
 * AiderDesk ACP shim for Raft.
 *
 * Raft has no custom-runtime slot, but its Grok Build driver (runtime id
 * `grok`) speaks plain ACP over stdio: it probes `grok --version` and
 * `grok agent stdio --help`, then spawns `grok agent --no-leader
 * --always-approve stdio` and talks JSON-RPC to it. This shim is what Raft
 * finds on PATH (as `grok`, symlinked from `~/.local/bin/aiderdesk`) and it
 * translates the handful of Grok-specific extensions Raft depends on:
 *
 *   initialize         -> inject `_meta.modelState` from AiderDesk /api/models
 *   session/new|load    -> remember `_meta.systemPromptOverride`
 *   session/set_model   -> session/set_config_option { configId: "model" }
 *   session/prompt      -> prepend the standing prompt, serialise turns
 *   _x.ai/interject     -> queue, replay after the current turn
 *
 * The real ACP implementation stays in ../src (aiderdesk-acp-bridge); this
 * file only proxies stdin/stdout and rewrites a few messages.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHIM_VERSION = readBridgeVersion();
const DEFAULT_PORT = 23456;

/**
 * AiderDesk defaults to `guided`: tools run, but a plan needs approval. Raft
 * has no approval surface (the bridge never answers `ask-question`), so a
 * guided turn would wait forever. Raft's own Grok launch runs with
 * `--always-approve`, so autonomous is the matching behaviour.
 */
const AUTONOMY_MODE = process.env.AIDER_DESK_SHIM_AUTONOMY || 'autonomous';

/** Comma-separated model allowlist (`provider/model` or a bare model id). */
const MODEL_ALLOWLIST = (process.env.AIDER_DESK_SHIM_MODELS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const QUEUED_MESSAGE_PREFIX =
    '[Sent while you were working — this is a follow-up to the current task, not a new task.]\n\n';

const STANDING_PROMPT_UPDATE_PREFIX =
    'Raft updated your standing instructions since this session started. The instructions below replace the earlier standing instructions (system or developer prompt) for the rest of this session; where they differ, follow these.\n\n';

type JsonRpcId = number | string;

type JsonRpcMessage = {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
};

function readBridgeVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function bridgeEntry(): string {
    return join(import.meta.dir, '..', 'src', 'index.ts');
}

function printUsage(): void {
    process.stdout.write(`aiderdesk ${SHIM_VERSION} — ACP bridge to AiderDesk, presented as a Raft runtime.

Usage:
  aiderdesk agent --no-leader --always-approve stdio   # proxy mode (spawned by Raft)
  aiderdesk agent stdio --help                        # probe, exits 0
  aiderdesk --version

Raft looks this up under the name "grok" because its Grok Build driver is the
only ACP-over-stdio runtime in the client; ~/.local/bin/grok is a symlink here.

Environment:
  AIDER_DESK_PORT            AiderDesk server port (default: ${DEFAULT_PORT})
  AIDER_DESK_HOST            AiderDesk server host (default: localhost)
  AIDER_DESK_SHIM_BRIDGE     Bridge entry to spawn (default: ../src/index.ts)
`);
}

/* ------------------------------------------------------------------ */
/* stdio plumbing                                                      */
/* ------------------------------------------------------------------ */

const DEBUG = process.env.AIDER_DESK_SHIM_DEBUG === '1';

function debug(direction: 'in' | 'out', message: JsonRpcMessage): void {
    if (!DEBUG) {
        return;
    }
    const label = message.method ?? (message.error ? 'error' : 'result');
    process.stderr.write(`[shim ${direction}] id=${String(message.id)} ${label} ${JSON.stringify(message).slice(0, 400)}\n`);
}

function writeClient(message: JsonRpcMessage): void {
    debug('out', message);
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseLine(line: string): JsonRpcMessage | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? (parsed as JsonRpcMessage) : null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* model discovery                                                     */
/* ------------------------------------------------------------------ */

function serverPort(): number {
    const raw = process.env.AIDER_DESK_PORT;
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function serverHost(): string {
    return process.env.AIDER_DESK_HOST || 'localhost';
}

async function fetchModels(): Promise<{ id: string; label: string }[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
        const response = await fetch(`http://${serverHost()}:${serverPort()}/api/models`, {
            signal: controller.signal,
        });
        if (!response.ok) {
            return [];
        }
        const data = (await response.json()) as { models?: unknown };
        if (!Array.isArray(data.models)) {
            return [];
        }
        const models: { id: string; label: string }[] = [];
        for (const candidate of data.models) {
            const entry = candidate as { id?: unknown; providerId?: unknown; name?: unknown };
            if (typeof entry?.id !== 'string' || typeof entry?.providerId !== 'string') {
                continue;
            }
            const composed = `${entry.providerId}/${entry.id}`;
            models.push({
                id: composed,
                label: typeof entry.name === 'string' && entry.name ? entry.name : composed,
            });
        }
        return filterModels(models);
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
}

function filterModels(models: { id: string; label: string }[]): { id: string; label: string }[] {
    if (MODEL_ALLOWLIST.length === 0) {
        return models;
    }
    return models.filter((model) =>
        MODEL_ALLOWLIST.some(
            (allowed) => model.id === allowed || model.id.endsWith(`/${allowed}`) || model.id.includes(allowed),
        ),
    );
}

/** Raft reads `_meta.modelState.{currentModelId,availableModels[].{modelId,name}}`. */
function buildModelState(models: { id: string; label: string }[]): Record<string, unknown> {
    // `default` keeps whatever model the AiderDesk task/profile already uses:
    // Raft then sends session/set_model with "default", which the bridge treats
    // as "no explicit model" and never persists. Picking a real entry persists
    // provider/model onto the task, exactly like the AiderDesk model picker.
    const available = [{ id: 'default', label: 'AiderDesk default' }, ...models];
    return {
        currentModelId: 'default',
        availableModels: available.map((model) => ({ modelId: model.id, name: model.label })),
    };
}

/* ------------------------------------------------------------------ */
/* proxy                                                               */
/* ------------------------------------------------------------------ */

type SessionState = {
    /** Latest standing prompt Raft announced for this session. */
    standingPrompt?: string;
    standingHash?: string;
    /** `initial` for a first delivery, `refresh` when a resume replaced it. */
    standingPending?: 'initial' | 'refresh';
    busy: boolean;
    queue: QueuedDelivery[];
};

type QueuedDelivery = {
    /** Set when an actual client `session/prompt` request is waiting. */
    request?: JsonRpcMessage;
    /** Set when queued `_x.ai/interject` / `session/steer` text is waiting. */
    text?: string;
};

type PendingPrompt = {
    sessionId: string;
    /** `true` when the client holds the matching request id. */
    forward: boolean;
};

async function runProxy(): Promise<void> {
    const bridge = process.env.AIDER_DESK_SHIM_BRIDGE || bridgeEntry();
    const child = Bun.spawn([process.execPath, bridge], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
        env: process.env,
        cwd: process.cwd(),
    });

    const sessions = new Map<string, SessionState>();
    const pendingInit = new Set<JsonRpcId>();
    const pendingSession = new Map<JsonRpcId, { standing?: string; requestedSessionId?: string }>();
    const pendingPrompts = new Map<JsonRpcId, PendingPrompt>();
    const pendingConfig = new Map<JsonRpcId, JsonRpcId>();
    /** Internal requests whose responses are ours to swallow (not the client's). */
    const pendingSilent = new Set<JsonRpcId>();
    let internalCounter = 0;

    const modelStatePromise = fetchModels().then(buildModelState);

    function nextInternalId(): string {
        internalCounter += 1;
        return `shim-${internalCounter}`;
    }

    function writeChild(message: JsonRpcMessage): void {
        debug('in', message);
        child.stdin.write(`${JSON.stringify(message)}\n`);
        void child.stdin.flush();
    }

    function ensureSession(sessionId: string): SessionState {
        let session = sessions.get(sessionId);
        if (!session) {
            session = { busy: false, queue: [] };
            sessions.set(sessionId, session);
        }
        return session;
    }

    /**
     * Raft re-sends the standing prompt on every session/new and session/load.
     * Only a changed prompt is queued for delivery, so a resume on the same
     * prompt does not duplicate ~30 KB into the conversation.
     */
    function noteStandingPrompt(session: SessionState, prompt?: string): void {
        if (!prompt) {
            return;
        }
        const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 16);
        if (hash === session.standingHash) {
            return;
        }
        session.standingPending = session.standingHash ? 'refresh' : 'initial';
        session.standingPrompt = prompt;
        session.standingHash = hash;
    }

    function applyStandingPrompt(session: SessionState, message: JsonRpcMessage): JsonRpcMessage {
        if (!session.standingPrompt || !session.standingPending) {
            return message;
        }
        const kind = session.standingPending;
        session.standingPending = undefined;
        const text = kind === 'refresh' ? `${STANDING_PROMPT_UPDATE_PREFIX}${session.standingPrompt}` : session.standingPrompt;
        const params = message.params ?? {};
        const prompt = Array.isArray(params.prompt) ? params.prompt : [];
        return {
            ...message,
            params: {
                ...params,
                prompt: [{ type: 'text', text }, ...prompt],
            },
        };
    }

    function sendPromptToChild(sessionId: string, text: string): void {
        const session = ensureSession(sessionId);
        const id = nextInternalId();
        pendingPrompts.set(id, { sessionId, forward: false });
        session.busy = true;
        writeChild({
            jsonrpc: '2.0',
            id,
            method: 'session/prompt',
            params: { sessionId, prompt: [{ type: 'text', text: `${QUEUED_MESSAGE_PREFIX}${text}` }] },
        });
    }

    /** Deliver the next queued message once the session is idle again. */
    function pump(sessionId: string): void {
        const session = sessions.get(sessionId);
        if (!session || session.busy) {
            return;
        }
        const next = session.queue.shift();
        if (!next) {
            return;
        }
        if (next.request) {
            session.busy = true;
            pendingPrompts.set(next.request.id!, { sessionId, forward: true });
            writeChild(applyStandingPrompt(session, next.request));
            return;
        }
        if (next.text !== undefined) {
            sendPromptToChild(sessionId, next.text);
            pump(sessionId);
        }
    }

    function handleClientMessage(message: JsonRpcMessage): void {
        const { id, method } = message;

        if (method === undefined) {
            // Response to a request the child made (e.g. session/request_permission).
            writeChild(message);
            return;
        }

        switch (method) {
            case 'initialize': {
                pendingInit.add(id!);
                writeChild(message);
                return;
            }
            case 'session/new':
            case 'session/load': {
                const meta = (message.params?._meta ?? {}) as Record<string, unknown>;
                pendingSession.set(id!, {
                    standing:
                        typeof meta.systemPromptOverride === 'string' && meta.systemPromptOverride
                            ? meta.systemPromptOverride
                            : undefined,
                    requestedSessionId:
                        method === 'session/load' && typeof message.params?.sessionId === 'string'
                            ? message.params.sessionId
                            : undefined,
                });
                writeChild(message);
                return;
            }
            case 'session/set_model': {
                const sessionId = message.params?.sessionId;
                const modelId = message.params?.modelId;
                const internal = nextInternalId();
                pendingConfig.set(internal, id!);
                writeChild({
                    jsonrpc: '2.0',
                    id: internal,
                    method: 'session/set_config_option',
                    params: { sessionId, configId: 'model', value: modelId },
                });
                return;
            }
            case '_x.ai/interject':
            case 'session/steer': {
                const sessionId = String(message.params?.sessionId ?? '');
                const text = String(message.params?.text ?? message.params?.content ?? '');
                const session = ensureSession(sessionId);
                if (session.busy) {
                    session.queue.push({ text });
                    if (id !== undefined) {
                        writeClient({ jsonrpc: '2.0', id, result: {} });
                    }
                    return;
                }
                if (id !== undefined) {
                    writeClient({ jsonrpc: '2.0', id, result: {} });
                }
                if (text) {
                    sendPromptToChild(sessionId, text);
                }
                return;
            }
            case 'session/prompt': {
                const sessionId = String(message.params?.sessionId ?? '');
                const session = ensureSession(sessionId);
                if (session.busy) {
                    session.queue.push({ request: message });
                    return;
                }
                session.busy = true;
                pendingPrompts.set(id!, { sessionId, forward: true });
                writeChild(applyStandingPrompt(session, message));
                return;
            }
            case 'session/cancel': {
                const session = sessions.get(String(message.params?.sessionId ?? ''));
                if (session) {
                    session.queue = [];
                }
                writeChild(message);
                return;
            }
            default:
                writeChild(message);
        }
    }

    async function injectModelState(result: Record<string, unknown>): Promise<void> {
        const meta = (result._meta ?? {}) as Record<string, unknown>;
        if (meta.modelState) {
            return;
        }
        result._meta = { ...meta, modelState: await modelStatePromise };
    }

    async function handleChildMessage(message: JsonRpcMessage): Promise<void> {
        const { id, method } = message;

        if (method !== undefined) {
            // Child-initiated request or notification: pass straight through.
            writeClient(message);
            return;
        }

        if (id !== undefined && pendingSilent.has(id)) {
            pendingSilent.delete(id);
            return;
        }

        if (id !== undefined && pendingConfig.has(id)) {
            const clientId = pendingConfig.get(id)!;
            pendingConfig.delete(id);
            writeClient(
                message.error
                    ? { jsonrpc: '2.0', id: clientId, error: message.error }
                    : { jsonrpc: '2.0', id: clientId, result: {} },
            );
            return;
        }

        if (id !== undefined && pendingInit.has(id)) {
            pendingInit.delete(id);
            if (message.result) {
                await injectModelState(message.result);
            }
            writeClient(message);
            return;
        }

        if (id !== undefined && pendingSession.has(id)) {
            const pending = pendingSession.get(id)!;
            pendingSession.delete(id);
            const result = message.result ?? {};
            const meta = (result._meta ?? {}) as Record<string, unknown>;
            const sessionId =
                (typeof result.sessionId === 'string' ? result.sessionId : undefined) ??
                (typeof meta.sessionId === 'string' ? meta.sessionId : undefined) ??
                pending.requestedSessionId;
            const options = Array.isArray(result.configOptions) ? result.configOptions : [];
            if (sessionId) {
                const session = ensureSession(sessionId);
                noteStandingPrompt(session, pending.standing);
            }
            writeClient(message);

            // AiderDesk starts every session in `guided`; Raft has no approval
            // surface, so align the session with the Grok driver's
            // `--always-approve` launch instead of waiting on a plan prompt.
            if (sessionId && AUTONOMY_MODE && options.some((option: any) => option?.id === 'autonomy_mode')) {
                const internal = nextInternalId();
                pendingSilent.add(internal);
                writeChild({
                    jsonrpc: '2.0',
                    id: internal,
                    method: 'session/set_config_option',
                    params: { sessionId, configId: 'autonomy_mode', value: AUTONOMY_MODE },
                });
            }
            return;
        }

        if (id !== undefined && pendingPrompts.has(id)) {
            const pending = pendingPrompts.get(id)!;
            pendingPrompts.delete(id);
            const session = sessions.get(pending.sessionId);
            if (session) {
                session.busy = false;
            }
            if (pending.forward) {
                writeClient(message);
            }
            pump(pending.sessionId);
            return;
        }

        writeClient(message);
    }

    async function readChildStdout(): Promise<void> {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
                const newline = buffer.indexOf('\n');
                if (newline === -1) {
                    break;
                }
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                const parsed = parseLine(line);
                if (parsed) {
                    await handleChildMessage(parsed);
                }
            }
        }
        const tail = parseLine(buffer);
        if (tail) {
            await handleChildMessage(tail);
        }
    }

    async function readClientStdin(): Promise<void> {
        const reader = Bun.stdin.stream().getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
                const newline = buffer.indexOf('\n');
                if (newline === -1) {
                    break;
                }
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                const parsed = parseLine(line);
                if (parsed) {
                    handleClientMessage(parsed);
                }
            }
        }
        const tail = parseLine(buffer);
        if (tail) {
            handleClientMessage(tail);
        }
    }

    void readClientStdin()
        .catch(() => undefined)
        .finally(() => {
            try {
                child.stdin.end();
            } catch {
                // child already gone
            }
        });

    await readChildStdout();
    await child.exited;
    process.exit(child.exitCode ?? 0);
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
    const argv = Bun.argv.slice(2);

    if (argv.includes('--version') || argv.includes('-v')) {
        process.stdout.write(`aiderdesk ${SHIM_VERSION}\n`);
        return;
    }

    const isAgentCommand = argv[0] === 'agent';
    if (!isAgentCommand || argv.includes('--help') || argv.includes('-h')) {
        printUsage();
        return;
    }

    if (!argv.includes('stdio')) {
        process.stderr.write(`aiderdesk: unsupported arguments: ${argv.join(' ')}\n`);
        process.exit(1);
    }

    await runProxy();
}

await main();