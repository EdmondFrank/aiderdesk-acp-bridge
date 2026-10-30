#!/usr/bin/env bun
/** Debug helper: talk to aiderdesk-acp-bridge directly (no shim), print every line. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CWD = mkdtempSync(join(tmpdir(), 'aiderdesk-raw-test-'));
const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'index.ts')], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: process.env,
    cwd: CWD,
});

const t0 = Date.now();
const send = (m: unknown) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(m as object) }) + '\n');
    void proc.stdin.flush();
};

let buf = '';
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();
let sessionId = '';
let done = false;

setTimeout(() => {
    if (!done) {
        console.log('TIMEOUT');
        proc.kill();
        process.exit(2);
    }
}, 180_000);

(async () => {
    for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
            const nl = buf.indexOf('\n');
            if (nl === -1) break;
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            const kind = msg.method ?? (msg.error ? 'ERROR' : 'result');
            console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, kind, JSON.stringify(msg).slice(0, 300));

            if (msg.id === 1) {
                send({ id: 2, method: 'session/new', params: { cwd: CWD, mcpServers: [] } });
            }
            if (msg.id === 2) {
                sessionId = msg.result?.sessionId ?? '';
                send({ id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Say pong.' }] } });
            }
            if (msg.id === 3) {
                done = true;
                proc.kill();
                process.exit(0);
            }
        }
    }
})();

send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
