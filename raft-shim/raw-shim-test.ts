#!/usr/bin/env bun
/** Debug helper: talk to the shim, print every line with timestamps. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CWD = mkdtempSync(join(tmpdir(), 'aiderdesk-shim-raw-'));
const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'aiderdesk.ts'), 'agent', '--no-leader', '--always-approve', 'stdio'], {
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

setTimeout(() => { console.log('TIMEOUT'); proc.kill(); process.exit(2); }, 180_000);

let buf = '';
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();

(async () => {
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
            const nl = buf.indexOf('\n');
            if (nl === -1) break;
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, msg.method ?? (msg.error ? 'ERROR' : 'result'), JSON.stringify(msg).slice(0, 220));
            if (msg.id === 1) send({ id: 2, method: 'session/new', params: { cwd: CWD, mcpServers: [], _meta: { systemPromptOverride: 'Be terse.' } } });
            if (msg.id === 2) send({ id: 3, method: 'session/prompt', params: { sessionId: msg.result?.sessionId, prompt: [{ type: 'text', text: 'Say pong.' }] } });
            if (msg.id === 3) { proc.kill(); process.exit(0); }
        }
    }
})();

send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
