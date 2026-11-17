import { afterEach, describe, expect, test } from 'bun:test';

import { fetchSkills, parseSkillCommand } from '../src/skills';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubSkills(payload: unknown, status = 200): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { urls };
}

describe('parseSkillCommand', () => {
  test('parses a skill name and its prompt', () => {
    expect(parseSkillCommand('/skill:pdf extract the tables')).toEqual({
      skillName: 'pdf',
      prompt: 'extract the tables',
    });
  });

  test('parses a bare trigger', () => {
    expect(parseSkillCommand('/skill:pdf')).toEqual({ skillName: 'pdf', prompt: '' });
  });

  test('keeps a multi-line prompt intact', () => {
    expect(parseSkillCommand('/skill:pdf\nline one\nline two')).toEqual({
      skillName: 'pdf',
      prompt: 'line one\nline two',
    });
  });

  test('ignores anything that is not at the start of the prompt', () => {
    expect(parseSkillCommand('please run /skill:pdf')).toBeNull();
    expect(parseSkillCommand('/skill:')).toBeNull();
    expect(parseSkillCommand('/skill: ')).toBeNull();
    expect(parseSkillCommand('/skills')).toBeNull();
    expect(parseSkillCommand('/skill')).toBeNull();
  });
});

describe('fetchSkills', () => {
  test('keeps user-invocable skills, sorted by name, with their location', async () => {
    const { urls } = stubSkills([
      { name: 'zeta', description: 'Last skill', location: 'global', activated: false },
      { name: 'alpha', description: 'First skill', location: 'project', activated: true },
      { name: 'agent-only', description: 'Model-only skill', userInvocable: false },
      { name: 'broken' },
      { description: 'no name' },
    ]);

    expect(await fetchSkills('localhost', 24337, '/proj', 'task-1')).toEqual([
      { name: 'alpha', description: 'First skill', location: 'project', activated: true },
      { name: 'broken', description: 'Not specified', activated: false },
      { name: 'zeta', description: 'Last skill', location: 'global', activated: false },
    ]);
    expect(urls[0]).toContain('/api/skills?projectDir=%2Fproj&taskId=task-1');
  });

  test('returns an empty list without a task to ask about', async () => {
    const { urls } = stubSkills([{ name: 'pdf', description: 'Read PDFs' }]);

    expect(await fetchSkills('localhost', 24337, '/proj', undefined)).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  test('returns an empty list on a failed request or an unexpected body', async () => {
    stubSkills({ error: 'boom' }, 500);
    expect(await fetchSkills('localhost', 24337, '/proj', 'task-1')).toEqual([]);

    stubSkills({ skills: [] });
    expect(await fetchSkills('localhost', 24337, '/proj', 'task-1')).toEqual([]);

    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchSkills('localhost', 24337, '/proj', 'task-1')).toEqual([]);
  });
});