import { AIDER_MODES } from './constants';
import type { AgentProfileInfo, ModelInfo } from './modes';

/**
 * Which model a session runs with, as `provider` + `model` (never composed, so
 * model ids containing a slash survive).
 */
export type EffectiveModel = {
  provider: string;
  model: string;
};

/** A turn's stored usage report, as replayed from `POST /api/project/tasks/load`. */
export type StoredUsageReport = {
  sentTokens?: number;
  receivedTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** Split a composed `provider/model` id, keeping slashes in the model id. */
export function parseComposedModelId(composed: string | undefined): EffectiveModel | undefined {
  if (!composed) {
    return undefined;
  }
  const separator = composed.indexOf('/');
  if (separator <= 0 || separator === composed.length - 1) {
    return undefined;
  }
  return { provider: composed.slice(0, separator), model: composed.slice(separator + 1) };
}

function findModel(models: ModelInfo[], effective: EffectiveModel): ModelInfo | undefined {
  return models.find((model) => model.providerId === effective.provider && model.id === effective.model);
}

/**
 * The model the session actually runs with.
 *
 * AiderDesk resolves a model per mode: agent modes run the selected agent
 * profile's model, Aider modes run the project's `mainModel`, and an ACP
 * `model` config selection (or a task loaded from the server) overrides both —
 * that last one is what `session.model` holds. The order below mirrors the
 * server, and only models the server still offers are returned, so a stale
 * profile or `mainModel` degrades to "unknown" instead of a wrong window.
 */
export function resolveContextModel(session: {
  models: ModelInfo[];
  model?: string;
  mode: string;
  agentProfileId?: string;
  agentProfiles: AgentProfileInfo[];
  mainModel?: string;
}): EffectiveModel | undefined {
  const selected = parseComposedModelId(session.model);
  if (selected && findModel(session.models, selected)) {
    return selected;
  }

  if (!AIDER_MODES.includes(session.mode)) {
    const profile =
      session.agentProfiles.find((candidate) => candidate.id === session.agentProfileId) ??
      session.agentProfiles.find((candidate) => candidate.provider && candidate.model);
    if (profile?.provider && profile.model) {
      const effective = { provider: profile.provider, model: profile.model };
      if (findModel(session.models, effective)) {
        return effective;
      }
    }
  }

  const main = parseComposedModelId(session.mainModel);
  if (main && findModel(session.models, main)) {
    return main;
  }

  return undefined;
}

/**
 * Context window of the session's effective model, or `0` when it is unknown
 * (provider without `maxInputTokens`, or a model the server no longer lists).
 */
export function contextWindowFor(session: Parameters<typeof resolveContextModel>[0]): number {
  const effective = resolveContextModel(session);
  if (!effective) {
    return 0;
  }
  const model = findModel(session.models, effective);
  return model?.maxInputTokens && model.maxInputTokens > 0 ? model.maxInputTokens : 0;
}

/**
 * Estimate the prompt tokens a context of `chars` characters costs this model.
 *
 * A compaction replaces the transcript without running a turn, so the figure
 * that follows it cannot be measured. The last turn supplies the
 * tokens-per-character ratio this model actually charged; the compacted
 * transcript supplies the characters. `undefined` when either side of that
 * ratio is unknown, so callers can fall back instead of inventing a number.
 */
export function estimateContextTokens(
  chars: number | undefined,
  promptTokens: number | undefined,
  promptChars: number | undefined,
): number | undefined {
  if (chars === undefined || promptTokens === undefined || promptChars === undefined) {
    return undefined;
  }
  if (promptChars <= 0 || promptTokens <= 0 || chars < 0) {
    return undefined;
  }
  return Math.max(0, Math.round((chars * promptTokens) / promptChars));
}

/**
 * Prompt tokens of the last stored turn, or `undefined` when the conversation
 * holds no usage report yet.
 *
 * The sum is the same one the relay computes per turn and the server uses for
 * its compaction threshold (the whole prompt, cached prefix included), so a
 * session reloaded from storage starts with the context figure it ended on.
 */
export function lastContextTokensFrom(messages: Array<{ usageReport?: StoredUsageReport }>): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const report = messages[index]?.usageReport;
    if (!report) {
      continue;
    }
    const used = (report.sentTokens ?? 0) + (report.receivedTokens ?? 0) + (report.cacheReadTokens ?? 0);
    return used > 0 ? used : undefined;
  }
  return undefined;
}