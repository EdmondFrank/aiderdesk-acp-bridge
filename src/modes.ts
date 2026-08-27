import * as acp from '@agentclientprotocol/sdk';

import { AIDER_MODES, AUTONOMY_MODES, BUILT_IN_MODES, type ModeOption } from './constants';
import { fetchJSON } from './http';

export type AgentProfileInfo = {
  id: string;
  name: string;
};

export function isAgentProfileVisible(mode: string): boolean {
  return !AIDER_MODES.includes(mode);
}

export async function fetchAgentProfiles(host: string, port: number): Promise<AgentProfileInfo[]> {
  try {
    const response = await fetchJSON(host, port, '/api/agent-profiles', 'GET');
    if (response.status !== 200) return [];
    const profiles = response.data as AgentProfileInfo[];
    if (!Array.isArray(profiles)) return [];
    return profiles.map((p) => ({ id: p.id, name: p.name }));
  } catch {
    return [];
  }
}

export async function fetchDefaultAgentProfileId(host: string, port: number, projectDir: string): Promise<string | undefined> {
  try {
    const response = await fetchJSON(host, port, `/api/project/settings?projectDir=${encodeURIComponent(projectDir)}`, 'GET');
    if (response.status !== 200) return undefined;
    const settings = response.data as { agentProfileId?: string };
    return settings?.agentProfileId;
  } catch {
    return undefined;
  }
}

export function resolveDefaultProfileId(
  profiles: AgentProfileInfo[],
  projectDefault: string | undefined,
  persisted: string | undefined,
): string | undefined {
  if (projectDefault && profiles.some((p) => p.id === projectDefault)) {
    return projectDefault;
  }
  if (persisted && profiles.some((p) => p.id === persisted)) {
    return persisted;
  }
  const defaultProfile = profiles.find((p) => p.id === 'default');
  if (defaultProfile) {
    return defaultProfile.id;
  }
  return profiles[0]?.id;
}

type CustomModeDefinition = {
  name: string;
  label: string;
  description?: string;
};

export async function fetchCustomModes(host: string, port: number, projectDir: string): Promise<ModeOption[]> {
  try {
    const response = await fetchJSON(host, port, `/api/project/custom-modes?projectDir=${encodeURIComponent(projectDir)}`, 'GET');
    if (response.status !== 200) return [];
    const modes = response.data as CustomModeDefinition[];
    if (!Array.isArray(modes)) return [];
    return modes.map((m) => ({ id: m.name, name: m.label, description: m.description }));
  } catch {
    return [];
  }
}

export function getAllModes(customModes: ModeOption[]): ModeOption[] {
  return [...BUILT_IN_MODES, ...customModes];
}

export function buildModeState(allModes: ModeOption[], currentMode: string): acp.SessionModeState {
  return {
    currentModeId: currentMode,
    availableModes: allModes.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
    })),
  };
}

export function buildConfigOptions(
  allModes: ModeOption[],
  agentProfiles: AgentProfileInfo[],
  currentMode: string,
  currentProfileId: string | undefined,
  currentAutonomy: string,
): acp.SessionConfigOption[] {
  const options: acp.SessionConfigOption[] = [
    {
      type: 'select',
      id: 'chat_mode',
      name: 'Mode',
      category: 'mode',
      currentValue: currentMode,
      options: allModes.map((m) => ({
        value: m.id,
        name: m.name,
        ...(m.description ? { description: m.description } : {}),
      })),
    },
  ];

  if (isAgentProfileVisible(currentMode)) {
    const profileOptions = agentProfiles.length > 0
      ? agentProfiles
      : [{ id: 'default', name: 'Default' }];
    options.push({
      type: 'select',
      id: 'agent_profile',
      name: 'Agent Profile',
      category: '_agent_profile',
      currentValue: currentProfileId ?? profileOptions[0].id,
      options: profileOptions.map((p) => ({
        value: p.id,
        name: p.name,
      })),
    });
  }

  options.push({
    type: 'select',
    id: 'autonomy_mode',
    name: 'Autonomy',
    category: '_autonomy_mode',
    currentValue: currentAutonomy,
    options: AUTONOMY_MODES.map((m) => ({
      value: m.id,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
    })),
  });

  return options;
}