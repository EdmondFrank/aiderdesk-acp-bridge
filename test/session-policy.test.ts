import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearStandingPrompt,
  forgetSessionTask,
  rememberSessionTask,
  resolveSessionTask,
  rulesFilePath,
  writeStandingPrompt,
} from '../src/session-policy';

const stateDir = mkdtempSync(join(tmpdir(), 'acp-state-'));
process.env.AIDER_DESK_ACP_STATE_DIR = stateDir;

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'acp-project-'));
});

afterAll(() => {
  delete process.env.AIDER_DESK_ACP_STATE_DIR;
});

describe('standing prompt rules file', () => {
  test('writes the prompt under .aider-desk/rules with a marker', async () => {
    expect(await writeStandingPrompt(projectDir, 'Answer in Czech.')).toBe(true);

    const content = readFileSync(rulesFilePath(projectDir), 'utf8');
    expect(content.startsWith('<!-- managed by aiderdesk-acp-bridge')).toBe(true);
    expect(content).toContain('Answer in Czech.');
  });

  test('replaces the file when the prompt changes and ignores whitespace-only prompts', async () => {
    await writeStandingPrompt(projectDir, 'first');
    await writeStandingPrompt(projectDir, 'second');
    expect(readFileSync(rulesFilePath(projectDir), 'utf8')).toContain('second');

    expect(await writeStandingPrompt(projectDir, '   ')).toBe(false);
    expect(readFileSync(rulesFilePath(projectDir), 'utf8')).toContain('second');
  });

  test('clears only a file it wrote itself', async () => {
    const path = rulesFilePath(projectDir);
    await writeStandingPrompt(projectDir, 'managed');
    await clearStandingPrompt(projectDir);
    expect(() => readFileSync(path, 'utf8')).toThrow();

    writeFileSync(path, 'hand-written rule\n');
    await clearStandingPrompt(projectDir);
    expect(readFileSync(path, 'utf8')).toBe('hand-written rule\n');
  });

  test('records the owning session in the marker', async () => {
    await writeStandingPrompt(projectDir, 'owned', 'session-a');
    const content = readFileSync(rulesFilePath(projectDir), 'utf8');
    expect(content).toContain(`; owner ${process.pid}:session-a -->`);
  });

  test('refuses to delete a prompt another live session still owns', async () => {
    const path = rulesFilePath(projectDir);
    await writeStandingPrompt(projectDir, 'owned by a', 'session-a');

    await clearStandingPrompt(projectDir, 'session-b');
    expect(readFileSync(path, 'utf8')).toContain('owned by a');

    // A dead owner is stale: the next session may replace it.
    writeFileSync(path, `<!-- managed by aiderdesk-acp-bridge: ACP standing prompt; owner 999999:gone -->\nstale\n`);
    await clearStandingPrompt(projectDir, 'session-b');
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  test('clears a legacy marker without an owner', async () => {
    const path = rulesFilePath(projectDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '<!-- managed by aiderdesk-acp-bridge: ACP standing prompt -->\nlegacy\n');
    await clearStandingPrompt(projectDir, 'session-b');
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });
});

describe('session to task mapping', () => {
  test('remembers, resolves and forgets a session', async () => {
    await rememberSessionTask('session-1', 'task-1', '/proj');
    expect(await resolveSessionTask('session-1')).toBe('task-1');

    await rememberSessionTask('session-1', 'task-2', '/proj');
    expect(await resolveSessionTask('session-1')).toBe('task-2');

    await forgetSessionTask('session-1');
    expect(await resolveSessionTask('session-1')).toBeUndefined();
  });

  test('returns undefined for unknown sessions', async () => {
    expect(await resolveSessionTask('nope')).toBeUndefined();
    expect(await resolveSessionTask('')).toBeUndefined();
  });

  test('keeps every record when updates run concurrently', async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `concurrent-${index}`);
    await Promise.all(ids.map((id) => rememberSessionTask(id, `task-${id}`, '/proj')));

    for (const id of ids) {
      expect(await resolveSessionTask(id)).toBe(`task-${id}`);
    }
  });
});
