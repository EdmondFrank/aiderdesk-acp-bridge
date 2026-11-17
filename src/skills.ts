import { fetchJSON } from './http';

/**
 * Skill support for the ACP bridge.
 *
 * AiderDesk keeps a skill as `<skills dir>/<name>/SKILL.md` — in the project
 * (`.aider-desk/skills`), the AiderDesk home (`~/.aider-desk/skills`), the
 * built-in set, or supplied by an extension — and triggers one from a prompt
 * with `/skill:<name> [prompt]`. That line is the same for a human typing it in
 * the AiderDesk UI and for an ACP client sending it, so the bridge advertises
 * the skills it may trigger as commands in that spelling and leaves the
 * server's own parsing as the fallback.
 */

/** Prefix AiderDesk requires on the command line that triggers a skill. */
export const SKILL_COMMAND_PREFIX = 'skill:';

/** Where a skill's `SKILL.md` was found. */
export type SkillLocation = 'global' | 'project' | 'builtin' | 'extension';

const SKILL_LOCATIONS: SkillLocation[] = ['global', 'project', 'builtin', 'extension'];

export type SkillInfo = {
  name: string;
  description: string;
  location?: SkillLocation;
  /** True once the task carries the skill in its context. */
  activated: boolean;
};

type RawSkill = {
  name?: unknown;
  description?: unknown;
  location?: unknown;
  activated?: unknown;
  userInvocable?: unknown;
};

function normalizeSkill(raw: unknown): SkillInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const skill = raw as RawSkill;
  if (typeof skill.name !== 'string' || skill.name === '') {
    return null;
  }
  // `user-invocable: false` marks a skill the model may pick but a prompt may
  // not — the server rejects `/skill:<name>` for it, so it is not advertised.
  if (skill.userInvocable === false) {
    return null;
  }

  const location = SKILL_LOCATIONS.includes(skill.location as SkillLocation)
    ? (skill.location as SkillLocation)
    : undefined;

  return {
    name: skill.name,
    description: typeof skill.description === 'string' ? skill.description : 'Not specified',
    ...(location ? { location } : {}),
    activated: skill.activated === true,
  };
}

/**
 * Fetch the skills available to a task (`GET /api/skills`), sorted by name.
 *
 * Returns an empty list on any failure — including a session that has no task
 * yet — so callers degrade to the server's own `/skill:<name>` parsing. The
 * list still contains the project's disabled skills (the endpoint ignores
 * `disabledSkills`), so callers must filter them out.
 */
export async function fetchSkills(
  host: string,
  port: number,
  projectDir: string,
  taskId: string | undefined,
): Promise<SkillInfo[]> {
  if (!taskId) {
    return [];
  }
  try {
    const response = await fetchJSON(
      host,
      port,
      `/api/skills?projectDir=${encodeURIComponent(projectDir)}&taskId=${encodeURIComponent(taskId)}`,
      'GET',
    );
    if (response.status !== 200 || !Array.isArray(response.data)) {
      return [];
    }
    return (response.data as unknown[])
      .map(normalizeSkill)
      .filter((skill): skill is SkillInfo => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export type ParsedSkillCommand = {
  skillName: string;
  /** What is left of the line once the `/skill:<name>` trigger is stripped. */
  prompt: string;
};

/**
 * Parse AiderDesk's `/skill:<name> [prompt]` trigger.
 *
 * Mirrors the server's `parseSkillCommand` exactly (the pattern only matches at
 * the very start of the prompt, and the remainder may span lines), so the
 * bridge and the server agree on what a skill invocation is.
 */
export function parseSkillCommand(text: string): ParsedSkillCommand | null {
  const match = /^\/skill:(\S+)(?:\s+([\s\S]+))?$/.exec(text);
  if (!match) {
    return null;
  }
  return { skillName: match[1]!, prompt: (match[2] ?? '').trim() };
}