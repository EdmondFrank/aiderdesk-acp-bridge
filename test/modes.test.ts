import { describe, expect, test } from 'bun:test';

import { AUTONOMY_MODES, BUILT_IN_MODES, DEFAULT_AUTONOMY_MODE, DEFAULT_MODE } from '../src/constants';
import { buildConfigOptions, buildModeState, getAllModes, isAgentProfileVisible, resolveDefaultProfileId } from '../src/modes';
import { selectById } from './helpers';

const profiles = [
  { id: 'default', name: 'Default' },
  { id: 'senior', name: 'Senior' },
];

describe('isAgentProfileVisible', () => {
  test('hides profiles in Aider modes', () => {
    expect(isAgentProfileVisible('agent')).toBe(true);
    expect(isAgentProfileVisible('code')).toBe(false);
    expect(isAgentProfileVisible('ask')).toBe(false);
  });
});

describe('resolveDefaultProfileId', () => {
  test('prefers project default', () => {
    expect(resolveDefaultProfileId(profiles, 'senior', 'default')).toBe('senior');
  });

  test('falls back to persisted', () => {
    expect(resolveDefaultProfileId(profiles, undefined, 'senior')).toBe('senior');
  });

  test('falls back to "default" profile', () => {
    expect(resolveDefaultProfileId(profiles, undefined, undefined)).toBe('default');
  });

  test('falls back to first profile', () => {
    expect(resolveDefaultProfileId([{ id: 'x', name: 'X' }], undefined, undefined)).toBe('x');
  });

  test('ignores unknown ids', () => {
    expect(resolveDefaultProfileId(profiles, 'ghost', undefined)).toBe('default');
  });
});

describe('getAllModes', () => {
  test('merges built-ins with custom modes', () => {
    const modes = getAllModes([{ id: 'review', name: 'Review' }]);
    expect(modes.map((m) => m.id)).toEqual([...BUILT_IN_MODES.map((m) => m.id), 'review']);
  });
});

describe('buildModeState', () => {
  test('tracks current mode and available modes', () => {
    const state = buildModeState(BUILT_IN_MODES, 'code');
    expect(state.currentModeId).toBe('code');
    expect(state.availableModes).toHaveLength(BUILT_IN_MODES.length);
    expect(state.availableModes[0]).toEqual({ id: 'agent', name: 'Agent', description: 'Agent mode with full tool access' });
  });
});

describe('buildConfigOptions', () => {
  test('always includes mode and autonomy selects', () => {
    const options = buildConfigOptions(BUILT_IN_MODES, profiles, 'agent', 'default', 'guided');
    const ids = options.map((o) => o.id);
    expect(ids).toEqual(['chat_mode', 'agent_profile', 'autonomy_mode']);
    const modeOption = selectById(options, 'chat_mode');
    expect(modeOption.currentValue).toBe('agent');
    expect(modeOption.options).toHaveLength(BUILT_IN_MODES.length);
    const autonomyOption = selectById(options, 'autonomy_mode');
    expect(autonomyOption.currentValue).toBe('guided');
    expect(
      autonomyOption.options.flatMap((o) => ('value' in o ? [o.value] : [])),
    ).toEqual(AUTONOMY_MODES.map((m) => m.id));
  });

  test('hides agent_profile select in Aider modes', () => {
    const options = buildConfigOptions(BUILT_IN_MODES, profiles, 'code', 'default', 'guided');
    expect(options.map((o) => o.id)).toEqual(['chat_mode', 'autonomy_mode']);
  });

  test('adds fallback profile entry when none exist', () => {
    const options = buildConfigOptions(BUILT_IN_MODES, [], 'agent', undefined, DEFAULT_AUTONOMY_MODE);
    const profileOption = selectById(options, 'agent_profile');
    expect(profileOption.currentValue).toBe('default');
    expect(profileOption.options).toEqual([{ value: 'default', name: 'Default' }]);
  });

  test('defaults to first available profile when none current', () => {
    const options = buildConfigOptions(BUILT_IN_MODES, profiles, 'agent', undefined, DEFAULT_AUTONOMY_MODE);
    const profileOption = selectById(options, 'agent_profile');
    expect(profileOption.currentValue).toBe('default');
  });
});