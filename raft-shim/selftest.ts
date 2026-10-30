#!/usr/bin/env bun
/**
 * End-to-end check for the AiderDesk ACP shim, without Raft in the loop.
 *
 *   bun raft-shim/selftest.ts                 # initialize + session/new + set_model + prompt
 *   bun raft-shim/selftest.ts --interject     # also queue an _x.ai/interject mid-turn
 *
 * Requires a running AiderDesk server (AIDER_DESK_PORT, default 23456).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHIM = join(import.meta.dir, 'aiderdesk.ts');
const CWD = mkdtempSync(join(tmpdir(), 'aiderdesk-raft-selftest-'));
const INTERJECT = process.argv.includes('--interject');
const TIMEOUT_MS = 240_000;

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

const proc = Bun.spawn([process.execPath, SHIM, 'agent', '--no-leader', '--always-approve', 'stdio'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: process.env,
    cwd: CWD,
});

const start = Date.now();
const seen: Message[] = [];
const textChunks: string[] = [];
const thoughtChunks: string[] = [];
const updateKinds: Record<string, number> = {};
let promptDone = false;
let sessionId = '';

function send(message: Message): void {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    void proc.stdin.flush();
}

function log(step: string, extra: unknown = ''): void {
    const suffix = extra === '' ? '' : ` ${JSON.stringify(extra)}`;
    process.stdout.write(`[${((Date.now() - start) / 1000).toFixed(1)}s] ${step}${suffix}\n`);
}

let resolveDone: () => void = () => undefined;
const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
});

function handle(message: Message): void {
    seen.push(message);

    if (message.method === 'session/update') {
        const update = message.params?.update ?? {};
        const kind = String(update.sessionUpdate ?? 'unknown');
        updateKinds[kind] = (updateKinds[kind] ?? 0) + 1;
        const text = update.content?.text;
        if (typeof text === 'string' && text) {
            if (kind === 'agent_message_chunk') textChunks.push(text);
            if (kind === 'agent_thought_chunk') thoughtChunks.push(text);
        }
        return;
    }

    if (message.method !== undefined) {
        log('child request', message.method);
        return;
    }

    switch (message.id) {
        case 1: {
            if (message.error) {
                log('initialize ERROR', message.error);
                resolveDone();
                return;
            }
            const state = message.result?._meta?.modelState;
            log('initialize', {
                protocolVersion: message.result?.protocolVersion,
                loadSession: message.result?.agentCapabilities?.loadSession,
                models: state?.availableModels?.length ?? 0,
                currentModelId: state?.currentModelId,
                sample: state?.availableModels?.slice(0, 3).map((m: any) => m.modelId),
            });
            send({
                id: 2,
                method: 'session/new',
                params: {
                    cwd: CWD,
                    mcpServers: [],
                    _meta: {
                        systemPromptOverride: 'You are taking part in a Raft smoke test. Answer with the single word: pong',
                        yoloMode: true,
                    },
                },
            });
            return;
        }
        case 2: {
            if (message.error) {
                log('session/new ERROR', message.error);
                resolveDone();
                return;
            }
            sessionId = message.result?.sessionId ?? '';
            log('session/new', { sessionId, configOptions: message.result?.configOptions?.length });
            // Mirrors Raft's sequence (set_model before the first prompt). `default`
            // leaves the task's own model alone; the real model list holds hundreds
            // of entries, some with stale provider credentials, so a live turn should
            // not switch to models[0] here.
            send({ id: 3, method: 'session/set_model', params: { sessionId, modelId: 'default' } });
            return;
        }
        case 3: {
            log('session/set_model', message.error ? { error: message.error } : { ok: true });
            send({ id: 4, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Say pong.' }] } });
            if (INTERJECT) {
                setTimeout(() => {
                    log('send _x.ai/interject');
                    send({
                        id: 5,
                        method: '_x.ai/interject',
                        params: { sessionId, text: 'Now say pong twice.', interjectionId: 'raft-selftest-1' },
                    });
                }, 800);
            }
            return;
        }
        case 5: {
            log('interject ack', message.error ?? message.result);
            return;
        }
        case 4: {
            promptDone = true;
            log('prompt response', { stopReason: message.result?.stopReason, error: message.error });
            log('updates', updateKinds);
            log('thought', thoughtChunks.join(' | ').trim().slice(0, 400));
            log('agent text', textChunks.join('').trim().slice(0, 400));
            resolveDone();
            return;
        }
        default:
            return;
    }
}

async function pump(): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) {
            return;
        }
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline === -1) {
                break;
            }
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) {
                continue;
            }
            try {
                handle(JSON.parse(line));
            } catch (error) {
                log('bad line', String(error));
            }
        }
    }
}

void pump();

send({
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
});

const timer = setTimeout(() => {
    log('TIMEOUT', { promptDone, messages: seen.length });
    resolveDone();
}, TIMEOUT_MS);

await done;
clearTimeout(timer);
try {
    proc.kill();
} catch {
    // already gone
}
await proc.exited.catch(() => undefined);
await new Promise((resolve) => setTimeout(resolve, 50));
process.exit(promptDone ? 0 : 1);