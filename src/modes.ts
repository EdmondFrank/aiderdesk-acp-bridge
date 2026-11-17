import * as acp from '@agentclientprotocol/sdk';

import { AIDER_MODES, AUTONOMY_MODES, BUILT_IN_MODES, type ModeOption } from './constants';
import { fetchJSON } from './http';

export type AgentProfileInfo = {
  id: string;
  name: string;
  /** Provider of the profile's model, so the context window can be resolved. */
  provider?: string;
  /** The profile's model id, next to `provider`. */
  model?: string;
};

export function isAgentProfileVisible(mode: string): boolean {
  return !AIDER_MODES.includes(mode);
}

export async function fetchAgentProfiles(host: string, port: number): Promise<AgentProfileInfo[]> {
  try {
    const response = await fetchJSON(host, port, '/api/agent-profiles', 'GET');
    if (response.status !== 200) return [];
    const profiles = response.data as Array<{
      id?: unknown;
      name?: unknown;
      provider?: unknown;
      model?: unknown;
    }>;
    if (!Array.isArray(profiles)) return [];
    return profiles
      .filter(
        (p): p is { id: string; name: string; provider?: string; model?: string } =>
          typeof p?.id === 'string' && p.id.length > 0,
      )
      .map((p) => ({
        id: p.id,
        name: typeof p.name === 'string' ? p.name : p.id,
        ...(typeof p.provider === 'string' && p.provider ? { provider: p.provider } : {}),
        ...(typeof p.model === 'string' && p.model ? { model: p.model } : {}),
      }));
  } catch {
    return [];
  }
}

export type ModelInfo = {
  id: string;
  providerId: string;
  name?: string;
  /** Context window in tokens; absent when the provider does not report one. */
  maxInputTokens?: number;
};

/**
 * Fetch the provider models available on the AiderDesk server
 * (`GET /api/models`). Returns an empty list on any failure so callers
 * degrade gracefully.
 */
export async function fetchProviderModels(host: string, port: number): Promise<ModelInfo[]> {
  try {
    const response = await fetchJSON(host, port, '/api/models', 'GET');
    if (response.status !== 200) return [];
    const data = response.data as { models?: unknown } | undefined;
    if (!data || !Array.isArray(data.models)) return [];
    return (data.models as ModelInfo[])
      .filter((m) => m && typeof m.id === 'string' && typeof m.providerId === 'string')
      .map((m) => ({
        id: m.id,
        providerId: m.providerId,
        ...(m.name ? { name: m.name } : {}),
        ...(typeof m.maxInputTokens === 'number' && Number.isFinite(m.maxInputTokens) && m.maxInputTokens > 0
          ? { maxInputTokens: m.maxInputTokens }
          : {}),
      }));
  } catch {
    return [];
  }
}

export type ProjectSettings = {
  agentProfileId?: string;
  /** Aider modes' main model as a composed `provider/model` id. */
  mainModel?: string;
};

/**
 * Fetch the project's settings (`GET /api/project/settings`).
 *
 * Only the two fields the bridge needs are kept: the default agent profile
 * (which one a new session starts on) and `mainModel` (the model Aider modes
 * run with, used to size the context window). Returns `{}` on any failure so
 * callers degrade to the previous behaviour.
 */
export async function fetchProjectSettings(
  host: string,
  port: number,
  projectDir: string,
): Promise<ProjectSettings> {
  try {
    const response = await fetchJSON(
      host,
      port,
      `/api/project/settings?projectDir=${encodeURIComponent(projectDir)}`,
      'GET',
    );
    if (response.status !== 200) return {};
    const settings = response.data as { agentProfileId?: unknown; mainModel?: unknown } | undefined;
    return {
      ...(typeof settings?.agentProfileId === 'string' && settings.agentProfileId
        ? { agentProfileId: settings.agentProfileId }
        : {}),
      ...(typeof settings?.mainModel === 'string' && settings.mainModel
        ? { mainModel: settings.mainModel }
        : {}),
    };
  } catch {
    return {};
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
  models: ModelInfo[] = [],
  currentModelId?: string,
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

  if (models.length > 0) {
    const composed = (m: ModelInfo) => `${m.providerId}/${m.id}`;
    options.push({
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: currentModelId ?? composed(models[0]!),
      options: models.map((m) => ({
        value: composed(m),
        name: m.name ?? composed(m),
      })),
    });
  }

  return options;
}