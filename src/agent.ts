import * as acp from '@agentclientprotocol/sdk';

import pkg from '../package.json';
import {
  type BridgeCommand,
  type CommandsData,
  ShellCommandError,
  expandCommandTemplate,
  fetchCommands,
  findBuiltInCommand,
  findCommand,
  parseCommandText,
  toAvailableCommands,
  validateRequiredArguments,
} from './commands';
import { contextCharsOf, evaluateCompaction } from './compaction-report';
import {
  AUTONOMY_MODES,
  DEDUPE_STANDING_PROMPT,
  DEFAULT_AUTONOMY_MODE,
  DEFAULT_MODE,
  IDLE_COMPACT_DELAY_MS,
  IDLE_COMPACT_TOKENS,
  type ModeOption,
} from './constants';
import {
  answerQuestion,
  callInterrupt,
  compactConversation,
  createTask,
  deleteTask,
  ensureProjectOpen,
  fetchInputHistory,
  fetchTask,
  handoffConversation,
  listTasks,
  listTasksStrict,
  loadTaskStrict,
  requestSSEStream,
  resumeTask,
  runCustomCommand,
  smartCompactConversation,
  updateTaskFields,
  updateTaskModel,
  type TaskStateMessage,
  type TaskSummary,
} from './http';
import type { TaskReadMessage } from './http';
import {
  buildConfigOptions,
  buildModeState,
  fetchAgentProfiles,
  fetchCustomModes,
  fetchPreferredModels,
  fetchProjectSettings,
  fetchProviderModels,
  fetchProviders,
  getAllModes,
  isAgentProfileVisible,
  resolveDefaultProfileId,
  type AgentProfileInfo,
  type ModelInfo,
  type ProviderInfo,
} from './modes';
import {
  contextWindowFor,
  effectiveModelId,
  estimateContextTokens,
  lastContextTokensFrom,
} from './context-usage';
import {
  buildStandingPromptStub,
  clearStandingPrompt,
  forgetSessionTask,
  isStandingPromptRepeat,
  rememberSessionTask,
  resolveSessionTask,
  writeStandingPrompt,
} from './session-policy';
import { parseSSEEvents } from './sse';
import {
  buildToolCallContentArray,
  contentBlocksToPrompt,
  extractFilePath,
  formatToolTitle,
  generateSessionId,
  inferToolKind,
  isToolFailed,
  parseToolArgs,
  parseToolResponse,
} from './tools';

type EventData = {
  baseDir?: string;
  taskId?: string;
  id?: string;
  chunk?: string;
  messageId?: string;
  reasoning?: string;
  content?: string;
  finished?: boolean;
  toolName?: string;
  toolCallId?: string;
  response?: string;
  error?: string;
  args?: unknown;
  level?: string;
  message?: string;
  question?: string;
  text?: string;
  answers?: Array<{ text?: string; shortkey?: string }>;
  defaultAnswer?: string;
  name?: string;
  state?: string;
  provider?: string;
  model?: string;
  usageReport?: {
    model?: string;
    sentTokens?: number;
    receivedTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    agentTotalCost?: number;
  };
};

function parseEventData(raw: string): EventData | undefined {
  try {
    return JSON.parse(raw) as EventData;
  } catch {
    return undefined;
  }
}

function getVersion(): string {
  return pkg.version ?? '0.0.0';
}

/** Session-cumulative token usage, accumulated from per-turn `usageReport` events. */
export type AcpSessionUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};

export type AcpSession = {
  cwd: string;
  taskId?: string;
  /** Standing prompt currently in force for this session, if any. */
  standingPrompt?: string;
  /**
   * Standing prompt that could not be written as a project rules file (see
   * `session-policy.ts`). Prepended to the next prompt once, then cleared.
   */
  pendingStandingPrompt?: string;
  abortController?: AbortController;
  sseStream?: ReadableStream<Uint8Array>;
  mode: string;
  agentProfileId?: string;
  autonomyMode: string;
  allModes: ModeOption[];
  agentProfiles: AgentProfileInfo[];
  models: ModelInfo[];
  /** Configured providers, for readable model groups and disabled filtering. */
  providers: ProviderInfo[];
  /** Starred model ids, advertised first like AiderDesk's own picker. */
  preferredModelIds: string[];
  model?: string;
  /** Project's Aider `mainModel`, so a fresh session can size its context window. */
  mainModel?: string;
  commands: CommandsData;
  usage: AcpSessionUsage;
  /** Set once the first user prompt went through; only that one is deduped. */
  firstPromptSent?: boolean;
  /** Input tokens of the last turn: `sent + received + cache read`. */
  lastContextTokens?: number;
  /** Pending idle compaction, cancelled as soon as another prompt arrives. */
  idleCompactTimer?: ReturnType<typeof setTimeout>;
  /** The in-flight idle compaction, so an arriving prompt can wait for it. */
  idleCompaction?: Promise<void>;
  /** Set when idle compaction measured as a no-op, so it stops retrying. */
  idleCompactUseless?: boolean;
};

/**
 * Raft delivers its standing prompt in `_meta.systemPromptOverride`, which is
 * not part of ACP v1. The bridge turns it into project rules text so AiderDesk
 * renders it into the system prompt instead of the conversation history.
 */
function extractStandingPrompt(params: unknown): string | undefined {
  const meta = (params as { _meta?: Record<string, unknown> } | null | undefined)?._meta;
  const value = meta?.systemPromptOverride;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Whether the bridge answers AiderDesk questions on the client's behalf.
 * Opt-in: a client with a real approval UI answers them itself. The Raft shim
 * enables it when it spawns the bridge, because Raft has no approval surface
 * and an unanswered question blocks the turn until the stream times out.
 */
function autoAnswersQuestions(): boolean {
  const raw = (process.env.AIDER_DESK_ACP_AUTO_ANSWER ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/**
 * How eagerly the bridge answers: `once` submits a single answer per question,
 * `always` may pick the question's `a` (all / always) option, which the server
 * then remembers for the rest of the task (`AIDER_DESK_ACP_AUTO_ANSWER_MODE`).
 */
function answerMode(): 'once' | 'always' {
  const raw = (process.env.AIDER_DESK_ACP_AUTO_ANSWER_MODE ?? '').trim().toLowerCase();
  return raw === 'always' ? 'always' : 'once';
}

/**
 * Pick the answer the bridge submits for a question, or `undefined` when the
 * question has no options and therefore needs a human (free text).
 *
 * `a` (all / always) is only chosen in `always` mode: the server stores it for
 * the whole task, so a one-shot answer must not silently become a permanent yes.
 */
function chooseQuestionAnswer(data: EventData, mode: 'once' | 'always'): string | undefined {
  const options = (data.answers ?? []).filter(
    (option): option is { shortkey: string } =>
      typeof option?.shortkey === 'string' && option.shortkey.length > 0,
  );
  if (options.length === 0) {
    return undefined;
  }

  const candidates = [mode === 'always' ? 'a' : undefined, data.defaultAnswer, 'y'].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const candidate of candidates) {
    if (mode !== 'always' && candidate.toLowerCase() === 'a') {
      continue;
    }
    const match = options.find((option) => option.shortkey.toLowerCase() === candidate.toLowerCase());
    if (match) {
      return match.shortkey;
    }
  }

  const fallback =
    mode === 'always'
      ? options[0]
      : (options.find((option) => option.shortkey.toLowerCase() !== 'a') ?? options[0]);
  return fallback.shortkey;
}

/** How much stored conversation `session/load` replays (`AIDER_DESK_ACP_REPLAY`). */
function replayMode(): 'full' | 'tail' | 'off' {
  const raw = (process.env.AIDER_DESK_ACP_REPLAY ?? 'full').trim().toLowerCase();
  return raw === 'tail' || raw === 'off' ? raw : 'full';
}

/** Number of trailing messages replayed in `tail` mode. */
const REPLAY_TAIL_MESSAGES = 20;

export class AcpAgent {
  private readonly sessions = new Map<string, AcpSession>();
  private lastAgentProfileId?: string;
  /**
   * Most recent request context, kept so `setConfigOption` (which ACP calls
   * without one) can publish usage through the same connection.
   */
  private clientContext?: acp.AgentContext;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: {
          list: {},
          delete: {},
          resume: {},
        },
      },
      agentInfo: {
        name: 'aiderdesk',
        title: 'AiderDesk',
        version: await getVersion(),
      },
      authMethods: [],
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async newSession(params: acp.NewSessionRequest, cx: acp.AgentContext): Promise<acp.NewSessionResponse> {
    const cwd = params.cwd ?? '';
    const standingPrompt = extractStandingPrompt(params);
    this.clientContext = cx;

    // Create the backing AiderDesk task eagerly so the ACP session id can be
    // the server's persistent task id. That makes sessions show up in
    // `session/list` and resumes across bridge restarts. Falls back to a local
    // id (task created lazily on the first prompt) when the server is not
    // available yet.
    let taskId: string | undefined;
    try {
      await ensureProjectOpen(this.host, this.port, cwd);
      taskId = await createTask(this.host, this.port, cwd);
    } catch {
      taskId = undefined;
    }
    const sessionId = taskId ?? generateSessionId();
    const session = await this.createSession(cwd, taskId);
    this.sessions.set(sessionId, session);
    await this.applyStandingPrompt(session, sessionId, standingPrompt);
    if (taskId) {
      await rememberSessionTask(sessionId, taskId, cwd);
    }

    const configOptions = sessionConfigOptions(session);

    this.advertiseCommands(session, sessionId, cx);

    // Publish the context window once the client knows the session, so its
    // header can show `used/size` before the first turn. Deferred for the same
    // reason as the command advert above.
    setTimeout(() => {
      void this.publishContextUsage(session, sessionId, cx).catch(() => {
        // best-effort: the client may not render usage updates
      });
    }, 0);

    return {
      sessionId,
      configOptions,
      modes: buildModeState(session.allModes, session.mode),
    };
  }

  /**
   * Publish the session's context-window occupancy as an ACP `usage_update`.
   *
   * `used` is the whole prompt of the last turn (`sent + received + cache
   * read`, the total the server itself uses for its compaction threshold) and
   * `size` is the effective model's context window, resolved the way the server
   * picks the model. Clients render this as `used/size (%)` in their header,
   * exactly as they do for Pi, whose adapter publishes the same message.
   *
   * Nothing is published when the window is unknown (a provider that reports
   * no `maxInputTokens`, or a model the server no longer lists): `size: 0`
   * would only hide the indicator a client could otherwise show. With
   * `requireKnownUsed`, a session whose context size was never observed (a
   * reconnect to an old task) is skipped rather than reported as empty.
   *
   * `used` overrides the session's last measured turn, for the figures that do
   * not come from one: a compaction estimates the text it left behind, and a
   * new task resets to zero.
   */
  private async publishContextUsage(
    session: AcpSession,
    sessionId: string,
    cx: acp.AgentContext,
    options?: { requireKnownUsed?: boolean; used?: number },
  ): Promise<void> {
    const size = contextWindowFor(session);
    if (size <= 0) {
      return;
    }
    const used = options?.used ?? session.lastContextTokens;
    if (options?.requireKnownUsed && used === undefined) {
      return;
    }
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: used ?? 0,
        size,
      },
    });
  }

  /**
   * Deliver a standing prompt for a session. Preferred: write it as a project
   * rules file, so it becomes system-prompt text and survives compaction.
   * Fallback: keep it on the session and prepend it to the next prompt.
   *
   * A call without a prompt is not "clear it": clients resume without
   * re-sending their standing prompt, and the session keeps the one it already
   * has. A rules file is only removed when this session never had a prompt, no
   * other session in the same directory has one, and the file is not owned by
   * another live bridge process (the owner is recorded in the marker).
   */
  private async applyStandingPrompt(session: AcpSession, sessionId: string, prompt?: string): Promise<void> {
    const trimmed = prompt?.trim();

    if (trimmed) {
      session.standingPrompt = trimmed;
      const written = await writeStandingPrompt(session.cwd, trimmed, sessionId);
      session.pendingStandingPrompt = written ? undefined : trimmed;
      return;
    }

    if (session.standingPrompt) {
      return;
    }

    session.pendingStandingPrompt = undefined;
    for (const other of this.sessions.values()) {
      if (other !== session && other.cwd === session.cwd && other.standingPrompt) {
        return;
      }
    }
    await clearStandingPrompt(session.cwd, sessionId);
  }

  /**
   * Build a fresh AcpSession for the given working directory, fetching agent
   * profiles, custom modes, the project default profile, provider models,
   * providers, preferred models and slash commands. `taskId` is the server task
   * the session is bound to (its ACP session id).
   */
  private async createSession(cwd: string, taskId: string | undefined): Promise<AcpSession> {
    const [agentProfiles, customModes, projectSettings, commands, models, providers, preferredModelIds] =
      await Promise.all([
        fetchAgentProfiles(this.host, this.port),
        fetchCustomModes(this.host, this.port, cwd),
        fetchProjectSettings(this.host, this.port, cwd),
        fetchCommands(this.host, this.port, cwd),
        fetchProviderModels(this.host, this.port),
        fetchProviders(this.host, this.port),
        fetchPreferredModels(this.host, this.port),
      ]);
    const allModes = getAllModes(customModes);
    const defaultProfileId = resolveDefaultProfileId(
      agentProfiles,
      projectSettings.agentProfileId,
      this.lastAgentProfileId,
    );

    return {
      cwd,
      taskId,
      mode: DEFAULT_MODE,
      agentProfileId: defaultProfileId,
      autonomyMode: DEFAULT_AUTONOMY_MODE,
      allModes,
      agentProfiles,
      models,
      providers,
      preferredModelIds,
      ...(projectSettings.mainModel ? { mainModel: projectSettings.mainModel } : {}),
      commands,
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    };
  }

  /**
   * Advertise the session's slash commands to the client.
   *
   * Every path that can introduce a session calls this — `session/new`,
   * `session/load` and `session/resume` — because clients restore persisted
   * sessions without ever re-issuing `session/new`, and would otherwise hold
   * no commands to complete `/` from.
   *
   * The notification is deferred so the response is written to the client
   * first: a notification referencing a session id the client has not seen yet
   * would be dropped.
   */
  private advertiseCommands(session: AcpSession, sessionId: string, cx: acp.AgentContext): void {
    const availableCommands = toAvailableCommands(session.commands);
    if (availableCommands.length === 0) {
      return;
    }
    setTimeout(() => {
      void cx
        .notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands },
        })
        .catch(() => {
          // best-effort: the client may not support commands
        });
    }, 0);
  }

  async setConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    const value = String(params.value);

    switch (params.configId) {
      case 'chat_mode':
        session.mode = value;
        break;
      case 'agent_profile':
        session.agentProfileId = value;
        this.lastAgentProfileId = value;
        // `run-prompt` ignores these options once a task exists, so they only
        // take effect when they are persisted on the task itself.
        if (session.taskId) {
          await updateTaskFields(this.host, this.port, session.cwd, session.taskId, { agentProfileId: value });
        }
        break;
      case 'autonomy_mode':
        session.autonomyMode = value;
        if (session.taskId) {
          await updateTaskFields(this.host, this.port, session.cwd, session.taskId, { autonomyMode: value });
        }
        break;
      case 'model': {
        session.model = value;
        // Value is the composed "provider/model" advertised by the config
        // option; persist it to the task when we have one. Best-effort: the
        // in-memory selection still applies if persistence fails.
        const separatorIndex = value.indexOf('/');
        if (session.taskId && separatorIndex > 0 && separatorIndex < value.length - 1) {
          try {
            await updateTaskModel(
              this.host,
              this.port,
              session.cwd,
              session.taskId,
              value.slice(0, separatorIndex),
              value.slice(separatorIndex + 1),
            );
          } catch {
            // best-effort
          }
        }
        break;
      }
    }

    const configOptions = sessionConfigOptions(session);

    // A different model, profile or mode can mean a different context window,
    // so republish it as soon as the client switches (pi-acp does the same).
    if (this.clientContext && ['model', 'agent_profile', 'chat_mode'].includes(String(params.configId))) {
      try {
        await this.publishContextUsage(session, params.sessionId, this.clientContext);
      } catch {
        // best-effort: a failed usage update must not fail the config change
      }
    }

    return { configOptions };
  }

  /**
   * List the AiderDesk input history entries for a working directory
   * (`session/list_input_history`). Entries are the prompts the user has
   * submitted in the project, newest first, fetched from the server's
   * `GET /api/project/input-history`. Failures degrade to an empty list.
   */
  async listInputHistory(params: { cwd?: string }): Promise<{ inputs: string[] }> {
    const cwd = params.cwd ?? '';
    return { inputs: await fetchInputHistory(this.host, this.port, cwd) };
  }

  /**
   * List the AiderDesk tasks for a working directory as ACP sessions
   * (`session/list`). Task ids are stable across bridge restarts, so any task
   * can later be loaded with `session/load` from a fresh client session.
   * Sessions are listed newest-created first (the server answers in insertion
   * order); archived tasks are hidden and failures degrade to an empty list.
   */
  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const cwd = params.cwd ?? '';
    await ensureProjectOpen(this.host, this.port, cwd);
    const tasks = await listTasks(this.host, this.port, cwd);
    const visible = sortTasksNewestFirst(tasks.filter((task) => task.archived !== true));
    return {
      sessions: visible.map((task) => ({
        sessionId: task.id,
        cwd: task.baseDir || cwd,
        ...(task.name ? { title: task.name } : {}),
        ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
      })),
    };
  }

  /**
   * Load an existing task into this process as an ACP session (`session/load`).
   * The session id is the server task id, so loading from a fresh process just
   * creates a session bound to that task. The session adopts the task's own
   * profile/model/mode and title, then the stored conversation is replayed to
   * the client as session updates so it can render the restored history.
   */
  async loadSession(params: acp.LoadSessionRequest, cx: acp.AgentContext): Promise<acp.LoadSessionResponse> {
    const sessionId = params.sessionId;
    const cwd = params.cwd ?? '';
    const standingPrompt = extractStandingPrompt(params);
    this.clientContext = cx;

    let session = this.sessions.get(sessionId);
    if (!session) {
      const mappedTaskId = (await resolveSessionTask(sessionId)) ?? sessionId;
      session = await this.createSession(cwd, mappedTaskId);
      this.sessions.set(sessionId, session);
    }
    await this.applyStandingPrompt(session, sessionId, standingPrompt);

    const projectDir = session.cwd || cwd;
    const taskId = session.taskId ?? sessionId;

    // A task that no longer exists must fail loudly. Raft's Grok driver turns a
    // `session ... not found` error into a fresh session (`resume_or_fresh`);
    // reporting success would leave every later turn talking to a ghost task.
    // `tasks/load` answers with an empty task for an unknown id, so existence
    // has to come from the task list — and only a *successful* answer may be
    // read as "missing", or a server hiccup would abandon a live conversation.
    await ensureProjectOpen(this.host, this.port, projectDir);
    const tasks = await listTasksStrict(this.host, this.port, projectDir);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Session not found: ${sessionId} (no AiderDesk task "${taskId}" in ${projectDir})`);
    }

    applyTaskSettings(session, task);
    await notifySessionTitle(cx, sessionId, task);

    const mode = replayMode();
    if (mode !== 'off') {
      const state = await loadTaskStrict(this.host, this.port, projectDir, taskId);
      await replayTaskMessages(
        sessionId,
        mode === 'tail' ? state.messages.slice(-REPLAY_TAIL_MESSAGES) : state.messages,
        cx,
      );
      // Seed the context figure from the conversation's last stored turn so the
      // header shows the window a reloaded session already occupies.
      const lastContext = lastContextTokensFrom(state.messages);
      if (lastContext !== undefined) {
        session.lastContextTokens = lastContext;
      }
    }

    await rememberSessionTask(sessionId, taskId, projectDir);

    // With replay off the conversation was never read, so the context figure is
    // only known when this process already ran a turn for the session; an empty
    // task (no stored turn) legitimately reports zero.
    await this.publishContextUsage(session, sessionId, cx, { requireKnownUsed: mode === 'off' }).catch(() => {
      // best-effort: a failed usage update must not fail the load
    });

    // A restored session is the only session most clients ever see, so its
    // commands have to be re-advertised here (see `advertiseCommands`).
    this.advertiseCommands(session, sessionId, cx);

    return {
      modes: buildModeState(session.allModes, session.mode),
      configOptions: sessionConfigOptions(session),
    };
  }

  /**
   * Resume a task (`session/resume`): bind the session to the task, adopt its
   * own settings and title, and only then — when the server left the task
   * mid-turn — ask it to continue (see `shouldResumeTask`). A client that
   * reconnects to an idle task must not spend a model turn on it.
   */
  async resumeSession(params: acp.ResumeSessionRequest, cx: acp.AgentContext): Promise<acp.ResumeSessionResponse> {
    const sessionId = params.sessionId;
    const cwd = params.cwd ?? '';
    const standingPrompt = extractStandingPrompt(params);
    this.clientContext = cx;

    let session = this.sessions.get(sessionId);
    if (!session) {
      const mappedTaskId = (await resolveSessionTask(sessionId)) ?? sessionId;
      session = await this.createSession(cwd, mappedTaskId);
      this.sessions.set(sessionId, session);
    }
    await this.applyStandingPrompt(session, sessionId, standingPrompt);

    // Same contract as `session/load`: a task that is gone has to read as a
    // missing session, and a failed list request must not look like one either.
    const projectDir = session.cwd || cwd;
    const taskId = session.taskId ?? sessionId;
    await ensureProjectOpen(this.host, this.port, projectDir);
    const tasks = await listTasksStrict(this.host, this.port, projectDir);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Session not found: ${sessionId} (no AiderDesk task "${taskId}" in ${projectDir})`);
    }

    applyTaskSettings(session, task);
    await notifySessionTitle(cx, sessionId, task);

    // Rebound above; only a task the server left mid-turn may be re-run.
    if (shouldResumeTask(task)) {
      await resumeTask(this.host, this.port, projectDir, taskId);
    }

    // `session/resume` carries no replay, so the context figure is only known
    // when this process already ran a turn for the session.
    await this.publishContextUsage(session, sessionId, cx, { requireKnownUsed: true }).catch(() => {
      // best-effort: a failed usage update must not fail the resume
    });

    // Resumed sessions are the common case for a client that restores its
    // layout, so advertise commands or `/` completion has nothing to offer.
    this.advertiseCommands(session, sessionId, cx);

    return {
      modes: buildModeState(session.allModes, session.mode),
      configOptions: sessionConfigOptions(session),
    };
  }

  /**
   * Delete a task (`session/delete`). Best-effort: tasks whose working
   * directory is unknown (loaded outside this bridge process) are left alone.
   */
  async deleteSession(params: acp.DeleteSessionRequest): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session?.cwd) {
      return;
    }
    this.cancelIdleCompaction(session);
    await deleteTask(this.host, this.port, session.cwd, params.sessionId);
    this.sessions.delete(params.sessionId);
    await forgetSessionTask(params.sessionId);
  }

  async prompt(params: acp.PromptRequest, cx: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    this.clientContext = cx;

    const abortController = new AbortController();
    session.abortController = abortController;
    this.cancelIdleCompaction(session);
    await this.awaitIdleCompaction(session);

    try {
      const { prompt: rawPrompt, images } = contentBlocksToPrompt(params.prompt);
      const promptText = this.dedupeFirstPrompt(session, params.sessionId, rawPrompt, cx);

      if (!promptText && images.length === 0) {
        return { stopReason: 'end_turn' };
      }

      const parsedCommand = parseCommandText(promptText);

      if (parsedCommand) {
        const builtInCommand = findBuiltInCommand(parsedCommand.name);
        if (builtInCommand) {
          // Built-in session control command (`/new`, `/compact`, ...):
          // translated into a direct REST call, never streamed as a prompt.
          return await this.runBuiltInCommandPrompt(
            session,
            params.sessionId,
            builtInCommand,
            parsedCommand.args,
            cx,
          );
        }
      }

      const command = parsedCommand ? findCommand(session.commands, parsedCommand.name) : undefined;

      if (parsedCommand && command?.template) {
        // File-based custom command: expand locally, then stream it through
        // the regular run-prompt flow.
        return await this.runCustomCommandPrompt(
          session,
          params.sessionId,
          command,
          parsedCommand.args,
          images,
          abortController,
          cx,
        );
      }

      if (parsedCommand && command) {
        // Extension command: only the AiderDesk server can execute it.
        // Awaited so the finally block below clears session state only after
        // the turn has fully settled.
        return await this.runExtensionCommandPrompt(session, params.sessionId, command.name, parsedCommand.args, cx);
      }

      // Regular prompt, or a "/..." text that is not a known command — in the
      // latter case it passes through untouched so nothing is lost.
      return await this.runPromptRequest(session, params.sessionId, promptText, images, abortController, cx);
    } catch (err) {
      if (abortController.signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      throw err;
    } finally {
      session.abortController = undefined;
      session.sseStream = undefined;
      if (!abortController.signal.aborted) {
        this.scheduleIdleCompaction(session, params.sessionId, cx);
      }
    }
  }

  /**
   * Send a prompt to the AiderDesk server over SSE and relay the resulting
   * events to the ACP client as session updates.
   */
  private async runPromptRequest(
    session: AcpSession,
    sessionId: string,
    promptText: string,
    images: string[],
    abortController: AbortController,
    cx: acp.AgentContext,
    options?: { autonomyMode?: string },
  ): Promise<acp.PromptResponse> {
    // A standing prompt that could not be written as a project rules file is
    // prepended once, preserving the pre-rules fallback behaviour.
    let text = promptText;
    if (session.pendingStandingPrompt) {
      text = `${session.pendingStandingPrompt}\n\n${text}`;
      session.pendingStandingPrompt = undefined;
    }

    const requestBody: Record<string, unknown> = {
      prompt: text,
      projectDir: session.cwd,
      mode: session.mode,
      autonomyMode: options?.autonomyMode ?? session.autonomyMode,
    };
    if (session.taskId) {
      requestBody.taskId = session.taskId;
    }
    if (session.agentProfileId && isAgentProfileVisible(session.mode)) {
      requestBody.agentProfileId = session.agentProfileId;
    }
    if (images.length > 0) {
      requestBody.images = images;
    }

    const sseResponse = await requestSSEStream(
      this.host,
      this.port,
      '/api/run-prompt',
      JSON.stringify(requestBody),
      abortController.signal,
    );

    if (sseResponse.taskId && !session.taskId) {
      session.taskId = sseResponse.taskId;
      await rememberSessionTask(sessionId, session.taskId, session.cwd);
    }
    session.sseStream = sseResponse.stream;

    return relaySse(this.host, this.port, session, sessionId, promptText, sseResponse.stream, cx, abortController);
  }

  /**
   * Expand a file-based custom command locally and stream it through the
   * regular run-prompt flow. Mirrors AiderDesk's server-side command
   * processing (argument substitution, `!shell` lines, required-argument
   * validation) so no server changes are needed.
   */
  private async runCustomCommandPrompt(
    session: AcpSession,
    sessionId: string,
    command: BridgeCommand,
    args: string[],
    images: string[],
    abortController: AbortController,
    cx: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    const argumentError = validateRequiredArguments(command, args);
    if (argumentError) {
      await notifyThought(cx, sessionId, argumentError);
      return { stopReason: 'end_turn' };
    }

    let expanded: string;
    try {
      expanded = await expandCommandTemplate(command, args, session.cwd);
    } catch (error) {
      const message =
        error instanceof ShellCommandError
          ? `Shell command failed: ${error.command}\n${error.stderr}`
          : String(error);
      await notifyThought(cx, sessionId, message);
      return { stopReason: 'end_turn' };
    }

    if (!expanded && images.length === 0) {
      return { stopReason: 'end_turn' };
    }

    return this.runPromptRequest(session, sessionId, expanded, images, abortController, cx, {
      autonomyMode: command.autonomyMode ?? session.autonomyMode,
    });
  }

  /**
   * Run an extension command on the AiderDesk server. Extension commands have
   * no expandable template, so the bridge creates a task when needed and then
   * asks the server to run the command — best-effort, without streaming.
   */
  private async runExtensionCommandPrompt(
    session: AcpSession,
    sessionId: string,
    commandName: string,
    args: string[],
    cx: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    try {
      if (!session.taskId) {
        session.taskId = await createTask(this.host, this.port, session.cwd, commandName);
      }
      await runCustomCommand(this.host, this.port, session.cwd, session.taskId, commandName, args, session.mode);
      await notifyThought(cx, sessionId, `Running command '/${commandName}'.`);
    } catch (error) {
      const message = String(error);
      process.stderr.write(`Extension command '/${commandName}' failed: ${message}\n`);
      await notifyThought(cx, sessionId, `Failed to run command '/${commandName}': ${message}`);
    }
    return { stopReason: 'end_turn' };
  }

  /**
   * Handle a built-in session-control command (`/new`, `/compact`,
   * `/smart-compact`, `/handoff`) by calling the corresponding AiderDesk REST
   * endpoint directly. These commands never produce a model turn, so the
   * result is always `end_turn`; feedback goes to the client as a plain
   * agent thought.
   */
  private async runBuiltInCommandPrompt(
    session: AcpSession,
    sessionId: string,
    command: BridgeCommand,
    args: string[],
    cx: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    try {
      switch (command.name) {
        case 'new': {
          const name = args.join(' ').trim() || undefined;
          const taskId = await createTask(this.host, this.port, session.cwd, name);
          session.taskId = taskId;
          session.lastContextTokens = 0;
          session.idleCompactUseless = false;
          await rememberSessionTask(sessionId, taskId, session.cwd);
          await this.publishContextUsage(session, sessionId, cx, { used: 0 }).catch(() => {
            // best-effort: the client may not render usage updates
          });
          await notifyThought(cx, sessionId, `Started a new task${name ? `: ${name}` : ''}.`);
          return { stopReason: 'end_turn' };
        }
        case 'tasks': {
          await ensureProjectOpen(this.host, this.port, session.cwd);
          const tasks = sortTasksNewestFirst(await listTasks(this.host, this.port, session.cwd));
          if (tasks.length === 0) {
            await notifyThought(cx, sessionId, 'No tasks for this project yet.');
            return { stopReason: 'end_turn' };
          }
          await notifyThought(cx, sessionId, formatTaskList(tasks));
          return { stopReason: 'end_turn' };
        }
        case 'load': {
          const target = args[0];
          if (!target) {
            await notifyThought(cx, sessionId, "Usage: /load <task id or '#number from /tasks'>");
            return { stopReason: 'end_turn' };
          }
          await ensureProjectOpen(this.host, this.port, session.cwd);
          const tasks = sortTasksNewestFirst(await listTasks(this.host, this.port, session.cwd));
          const task = resolveTask(tasks, target);
          if (!task) {
            await notifyThought(
              cx,
              sessionId,
              `No task matching '${target}'. Run /tasks to see available tasks.`,
            );
            return { stopReason: 'end_turn' };
          }
          session.taskId = task.id;
          session.lastContextTokens = 0;
          session.idleCompactUseless = false;
          await rememberSessionTask(sessionId, task.id, session.cwd);
          await notifyThought(
            cx,
            sessionId,
            `Loaded task ${formatTaskReference(task)}. A conversation is already in progress.`,
          );
          return { stopReason: 'end_turn' };
        }
        case 'compact': {
          if (!session.taskId) {
            await notifyThought(cx, sessionId, 'No conversation to compact yet. Send a message first.');
            return { stopReason: 'end_turn' };
          }
          const customInstructions = args.join(' ').trim() || undefined;
          const tokensBefore = session.lastContextTokens;
          const beforeChars = contextCharsOf(await fetchTask(this.host, this.port, session.cwd, session.taskId));
          await compactConversation(
            this.host,
            this.port,
            session.cwd,
            session.taskId,
            session.mode,
            customInstructions,
          );
          const compacted = await this.notifyCompactionResult(
            cx,
            sessionId,
            session.cwd,
            session.taskId,
            'Conversation compacted.',
            { beforeChars },
          );
          if (compacted.shrank) {
            await this.publishCompactedContext(session, sessionId, cx, beforeChars, compacted.afterChars, tokensBefore);
          }
          return { stopReason: 'end_turn' };
        }
        case 'smart-compact': {
          if (!session.taskId) {
            await notifyThought(cx, sessionId, 'No conversation to compact yet. Send a message first.');
            return { stopReason: 'end_turn' };
          }
          const tokensBefore = session.lastContextTokens;
          const beforeChars = contextCharsOf(await fetchTask(this.host, this.port, session.cwd, session.taskId));
          await smartCompactConversation(this.host, this.port, session.cwd, session.taskId);
          const compacted = await this.notifyCompactionResult(
            cx,
            sessionId,
            session.cwd,
            session.taskId,
            'Conversation smart-compacted.',
            { beforeChars },
          );
          if (compacted.shrank) {
            await this.publishCompactedContext(session, sessionId, cx, beforeChars, compacted.afterChars, tokensBefore);
          }
          return { stopReason: 'end_turn' };
        }
        case 'handoff': {
          if (!session.taskId) {
            await notifyThought(cx, sessionId, 'No conversation to hand off yet. Send a message first.');
            return { stopReason: 'end_turn' };
          }
          const focus = args.join(' ').trim() || undefined;
          const newTaskId = await handoffConversation(this.host, this.port, session.cwd, session.taskId, focus);
          if (newTaskId) {
            session.taskId = newTaskId;
            session.lastContextTokens = 0;
            session.idleCompactUseless = false;
            await rememberSessionTask(sessionId, newTaskId, session.cwd);
            await this.publishContextUsage(session, sessionId, cx, { used: 0 }).catch(() => {
              // best-effort: the client may not render usage updates
            });
            await notifyThought(cx, sessionId, 'Conversation handed off.');
          } else {
            await notifyThought(
              cx,
              sessionId,
              'Handoff did not create a new task; continuing the current conversation.',
            );
          }
          return { stopReason: 'end_turn' };
        }
        default:
          return { stopReason: 'end_turn' };
      }
    } catch (error) {
      const message = String(error);
      process.stderr.write(`Built-in command '/${command.name}' failed: ${message}\n`);
      await notifyThought(cx, sessionId, `Failed to run command '/${command.name}': ${message}`);
      return { stopReason: 'end_turn' };
    }
  }

  /**
   * After a compaction, relay the server's new compacted context summary to the
   * client so the session reflects what replaced the conversation. Returns
   * whether the context actually shrank — a compaction that changed nothing has
   * no summary to relay and must not be announced as one — together with the
   * size it shrank to, which the usage figure is derived from.
   */
  private async notifyCompactionResult(
    cx: acp.AgentContext,
    sessionId: string,
    projectDir: string,
    taskId: string,
    fallbackText: string,
    options: { beforeChars?: number; background?: boolean } = {},
  ): Promise<{ shrank: boolean; afterChars?: number }> {
    const messages = await fetchTask(this.host, this.port, projectDir, taskId);
    const afterChars = contextCharsOf(messages);
    const outcome = evaluateCompaction(options.beforeChars, afterChars);
    if (!outcome.shrank) {
      process.stderr.write(`[compaction] ${fallbackText} changed nothing (${outcome.detail})\n`);
      if (!options.background) {
        await notifyThought(cx, sessionId, `Nothing to compact: the context is unchanged (${outcome.detail}).`);
      }
      return { shrank: false };
    }

    const summary = extractCompactionSummary(messages);
    if (summary) {
      await notifyThought(cx, sessionId, `${fallbackText} The conversation was replaced by this summary:\n\n${summary}`);
      return { shrank: true, afterChars };
    }
    await notifyThought(cx, sessionId, fallbackText);
    return { shrank: true, afterChars };
  }

  /**
   * Publish the context figure a compaction left behind.
   *
   * No turn runs while the transcript is replaced, so there is no usage report
   * to read: the compacted size is estimated from the text that survived, at
   * the tokens-per-character ratio the last turn was actually billed at. With
   * no ratio to apply (no turn yet) it resets to zero — nothing has been sent
   * since the context was replaced — rather than leaving the pre-compaction
   * figure on the client's header until the next prompt.
   */
  private async publishCompactedContext(
    session: AcpSession,
    sessionId: string,
    cx: acp.AgentContext,
    beforeChars: number | undefined,
    afterChars: number | undefined,
    tokensBefore: number | undefined,
  ): Promise<void> {
    const used = estimateContextTokens(afterChars, tokensBefore, beforeChars) ?? 0;
    session.lastContextTokens = used;
    await this.publishContextUsage(session, sessionId, cx, { used }).catch(() => {
      // best-effort: the client may not render usage updates
    });
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return;
    }

    session.abortController?.abort();

    if (session.sseStream) {
      try {
        await session.sseStream.cancel();
      } catch {
        // already cancelled
      }
    }

    if (session.taskId) {
      try {
        await callInterrupt(this.host, this.port, session.cwd, session.taskId);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Raft repeats its standing prompt as the first `session/prompt`, on top of
   * `_meta.systemPromptOverride` which already became a rules file. Forwarding
   * the duplicate costs ~10k tokens on every cold start and survives every
   * compaction, so the first prompt is reduced to a stub that keeps only its
   * tail — where Raft appends state the standing text does not contain.
   *
   * Only the first prompt is considered: later messages are the user's.
   */
  private dedupeFirstPrompt(
    session: AcpSession,
    sessionId: string,
    promptText: string,
    cx: acp.AgentContext,
  ): string {
    if (session.firstPromptSent) {
      return promptText;
    }
    session.firstPromptSent = true;

    const standing = session.standingPrompt;
    if (
      !DEDUPE_STANDING_PROMPT ||
      !standing ||
      session.pendingStandingPrompt ||
      !isStandingPromptRepeat(promptText, standing)
    ) {
      return promptText;
    }

    void notifyThought(
      cx,
      sessionId,
      'First prompt repeated the standing prompt; sent a short stub instead (the full text is already system rules).',
    ).catch(() => undefined);
    return buildStandingPromptStub(promptText);
  }

  /**
   * Compact a session that has gone quiet.
   *
   * A Raft agent is woken sporadically, and the provider's prompt cache expires
   * between wakes, so the whole context is billed at input price on the first
   * turn after a pause. Compacting while idle makes that turn small; compacting
   * during an active burst would throw away a cache that is still warm, hence
   * the debounce — the next prompt cancels the pending compaction.
   */
  private scheduleIdleCompaction(session: AcpSession, sessionId: string, cx: acp.AgentContext): void {
    if (IDLE_COMPACT_TOKENS <= 0 || !session.taskId || session.idleCompactTimer || session.idleCompactUseless) {
      return;
    }
    if ((session.lastContextTokens ?? 0) < IDLE_COMPACT_TOKENS) {
      return;
    }

    const timer = setTimeout(() => {
      session.idleCompactTimer = undefined;
      void this.runIdleCompaction(session, sessionId, cx);
    }, IDLE_COMPACT_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
    session.idleCompactTimer = timer;
  }

  private cancelIdleCompaction(session: AcpSession): void {
    if (session.idleCompactTimer) {
      clearTimeout(session.idleCompactTimer);
      session.idleCompactTimer = undefined;
    }
  }

  private runIdleCompaction(session: AcpSession, sessionId: string, cx: acp.AgentContext): void {
    const taskId = session.taskId;
    if (!taskId || session.idleCompaction) {
      return;
    }

    session.idleCompaction = (async () => {
      try {
        const tokensBefore = session.lastContextTokens;
        const beforeChars = contextCharsOf(await fetchTask(this.host, this.port, session.cwd, taskId));
        await smartCompactConversation(this.host, this.port, session.cwd, taskId);
        if (beforeChars === undefined) {
          process.stderr.write('[idle-compact] context could not be read back, skipping the report\n');
          return;
        }

        const compacted = await this.notifyCompactionResult(
          cx,
          sessionId,
          session.cwd,
          taskId,
          'Compacted while idle to keep the next wake small.',
          { beforeChars, background: true },
        );
        if (compacted.shrank) {
          await this.publishCompactedContext(session, sessionId, cx, beforeChars, compacted.afterChars, tokensBefore);
          return;
        }

        // AiderDesk's smart compaction only rewrites its own `power` tool
        // results, so a session built on MCP tools never shrinks. Retrying on
        // every wake would only repeat the same no-op, so stop until the task
        // changes.
        session.idleCompactUseless = true;
        process.stderr.write('[idle-compact] disabled for this task: smart compaction cannot shrink it\n');
      } catch (error) {
        process.stderr.write(`[idle-compact] compaction failed: ${String(error)}\n`);
      }
    })().finally(() => {
      session.idleCompaction = undefined;
    });
  }

  /**
   * AiderDesk rejects a prompt for a task that is busy, so a prompt arriving
   * while the debounce already fired waits for that one summary call instead of
   * racing it. Bounded, because the message matters more than the compaction.
   */
  private async awaitIdleCompaction(session: AcpSession): Promise<void> {
    const pending = session.idleCompaction;
    if (!pending) {
      return;
    }
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 120_000);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  }
}

/**
 * Relay AiderDesk SSE events as ACP session updates until the stream ends or
 * is aborted. Used by both regular prompts and expanded custom commands.
 * Per-turn `usageReport` events are accumulated into the session so the final
 * response can carry a session-cumulative `usage` (ACP experimental field).
 */
async function relaySse(
  host: string,
  port: number,
  session: AcpSession,
  sessionId: string,
  /** What the user actually sent, echoed back on `user-message` (never the standing prompt). */
  userText: string,
  stream: ReadableStream<Uint8Array>,
  cx: acp.AgentContext,
  abortController: AbortController,
): Promise<acp.PromptResponse> {
  const eventStream = parseSSEEvents(stream);
  let streamedReasoning = '';

  for await (const event of eventStream) {
    if (abortController.signal.aborted) {
      break;
    }

    const eventData = parseEventData(event.data);
    if (!eventData) {
      continue;
    }

    switch (event.type) {
      case 'response-chunk': {
        if (eventData.reasoning) {
          streamedReasoning += eventData.reasoning;
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              ...(eventData.messageId ? { messageId: eventData.messageId } : {}),
              content: { type: 'text', text: eventData.reasoning },
            },
          });
        }
        if (eventData.chunk) {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              ...(eventData.messageId ? { messageId: eventData.messageId } : {}),
              content: { type: 'text', text: eventData.chunk },
            },
          });
        }
        break;
      }

      case 'response-completed': {
        if (eventData.reasoning) {
          const remaining = eventData.reasoning.startsWith(streamedReasoning) ? eventData.reasoning.slice(streamedReasoning.length) : eventData.reasoning;
          if (remaining) {
            await cx.notify(acp.methods.client.session.update, {
              sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                ...(eventData.messageId ? { messageId: eventData.messageId } : {}),
                content: { type: 'text', text: remaining },
              },
            });
          }
          streamedReasoning = eventData.reasoning;
        }
        if (eventData.usageReport) {
          const usage = eventData.usageReport;
          session.usage.inputTokens += usage.sentTokens ?? 0;
          session.usage.outputTokens += usage.receivedTokens ?? 0;
          session.usage.cachedReadTokens += usage.cacheReadTokens ?? 0;
          session.usage.cachedWriteTokens += usage.cacheWriteTokens ?? 0;
          // Same total the server uses for its compaction threshold: the whole
          // prompt of this turn, cached prefix included.
          const used = (usage.sentTokens ?? 0) + (usage.receivedTokens ?? 0) + (usage.cacheReadTokens ?? 0);
          session.lastContextTokens = used;
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used,
              // Context window of the model this turn ran on, so the client can
              // render `used/size (%)` instead of nothing. 0 when the provider
              // reports no window; the cost below is reported either way.
              size: contextWindowFor(session),
              ...(usage.agentTotalCost !== undefined ? { cost: { amount: usage.agentTotalCost, currency: 'USD' } } : {}),
            },
          });
        }
        break;
      }

      case 'tool': {
        const toolId = eventData.id || '';
        const toolName = eventData.toolName ?? '';

        if (eventData.finished) {
          await notifyToolCallEnd(cx, sessionId, toolId, toolName, eventData.args, eventData.response ?? '');
        } else {
          await notifyToolCallStart(cx, sessionId, toolId, toolName, eventData.args);
        }
        break;
      }

      case 'ask-question': {
        await answerPendingQuestion(host, port, session, sessionId, eventData, cx);
        break;
      }

      case 'log': {
        if (eventData.message && eventData.level !== 'loading') {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: eventData.message },
            },
          });
        }
        break;
      }

      case 'task-updated':
      case 'task-created': {
        if (eventData.name) {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              title: eventData.name,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        break;
      }

      case 'user-message': {
        if (eventData.messageId) {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              messageId: eventData.messageId,
              content: { type: 'text', text: userText },
            },
          });
        }
        break;
      }

      case 'stream-end': {
        return withUsage(session, { stopReason: 'end_turn' });
      }

      case 'error': {
        process.stderr.write(`Server error: ${eventData.error || 'Unknown error'}\n`);
        return withUsage(session, { stopReason: 'end_turn' });
      }
    }
  }

  if (abortController.signal.aborted) {
    return withUsage(session, { stopReason: 'cancelled' });
  }

  return withUsage(session, { stopReason: 'end_turn' });
}

/**
 * Notify a tool call's start: the update that carries the tool's name, kind and
 * arguments. Clients render a tool's label from it, so live relays and session
 * replays must both send it before the terminal `tool_call_update`.
 */
async function notifyToolCallStart(
  cx: acp.AgentContext,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  rawArgs: unknown,
): Promise<void> {
  const args = parseToolArgs(rawArgs);
  const filePath = extractFilePath(toolName, args);

  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: formatToolTitle(toolName, args),
      kind: inferToolKind(toolName),
      status: 'in_progress',
      ...(rawArgs !== undefined ? { rawInput: rawArgs } : {}),
      ...(filePath ? { locations: [{ path: filePath }] } : {}),
    },
  });
}

/** Notify a tool call's terminal state: its output content and completed/failed status. */
async function notifyToolCallEnd(
  cx: acp.AgentContext,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  rawArgs: unknown,
  response: string,
): Promise<void> {
  const args = parseToolArgs(rawArgs);
  const responseData = parseToolResponse(response);
  const content = buildToolCallContentArray(toolName, args, responseData);

  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: isToolFailed(toolName, responseData) ? 'failed' : 'completed',
      ...(content.length > 0 ? { content } : {}),
    },
  });
}

/**
 * Task states in which the server still owns unfinished work. Resuming a task
 * in one of them re-runs it, which is what a client reconnecting to an
 * interrupted turn wants; any other state is idle and must only be rebound.
 */
const RESUMABLE_TASK_STATES = new Set(['IN_PROGRESS', 'INTERRUPTED']);

/**
 * Whether `session/resume` should ask the server to continue the task.
 *
 * ACP `session/resume` means "reconnect without replay", not "redo": calling
 * `POST /api/project/resume-task` re-runs the conversation (`Task.resumeTask`),
 * spending a model turn with no client attached. So it is limited to tasks the
 * server left mid-turn. `AIDER_DESK_ACP_RESUME_TASK` overrides the guess:
 * `1`/`true`/`on`/`yes` always resumes, `0`/`false`/`off`/`never` never does.
 */
function shouldResumeTask(task: TaskSummary | undefined): boolean {
  const raw = (process.env.AIDER_DESK_ACP_RESUME_TASK ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') {
    return true;
  }
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'never') {
    return false;
  }
  return task?.state !== undefined && RESUMABLE_TASK_STATES.has(task.state);
}

/**
 * Mirror a task's own session settings onto the ACP session that loads or
 * resumes it, so a reloaded shell shows the profile/model/mode the task
 * actually runs with instead of the project defaults. Values the server no
 * longer offers are ignored rather than advertised as unselectable.
 */
function applyTaskSettings(session: AcpSession, task: TaskSummary | undefined): void {
  if (!task) {
    return;
  }
  if (task.currentMode && session.allModes.some((mode) => mode.id === task.currentMode)) {
    session.mode = task.currentMode;
  }
  if (task.agentProfileId && session.agentProfiles.some((profile) => profile.id === task.agentProfileId)) {
    session.agentProfileId = task.agentProfileId;
  }
  if (task.autonomyMode && AUTONOMY_MODES.some((mode) => mode.id === task.autonomyMode)) {
    session.autonomyMode = task.autonomyMode;
  }
  if (task.provider && task.model) {
    const composed = `${task.provider}/${task.model}`;
    if (session.models.some((model) => `${model.providerId}/${model.id}` === composed)) {
      session.model = composed;
    }
  }
}

/**
 * Advertise a session's config options, with the model it actually runs.
 *
 * `session.model` only holds an explicit ACP or task selection. Without one the
 * server resolves the model from the agent profile (agent modes) or the
 * project's `mainModel` (Aider modes), so the option has to report that rather
 * than the first offered model.
 */
function sessionConfigOptions(session: AcpSession): acp.SessionConfigOption[] {
  return buildConfigOptions(
    session.allModes,
    session.agentProfiles,
    session.mode,
    session.agentProfileId,
    session.autonomyMode,
    session.models,
    effectiveModelId(session),
    session.providers,
    session.preferredModelIds,
  );
}

/** Announce a task's title so a client shows the session name it restored. */
async function notifySessionTitle(
  cx: acp.AgentContext,
  sessionId: string,
  task: TaskSummary | undefined,
): Promise<void> {
  if (!task?.name) {
    return;
  }
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'session_info_update',
      title: task.name,
      updatedAt: task.updatedAt ?? new Date().toISOString(),
    },
  });
}

/**
 * Replay a task's stored conversation (`POST /api/project/tasks/load` messages)
 * to the ACP client as session updates so it can render the restored session.
 * User messages, assistant reasoning/content and tool calls map to the same
 * update kinds the live SSE relay produces. Runs inside the `session/load`
 * request, which is how ACP clients restore history.
 */
async function replayTaskMessages(
  sessionId: string,
  messages: TaskStateMessage[],
  cx: acp.AgentContext,
): Promise<void> {
  for (const message of messages) {
    switch (message.type) {
      case 'user': {
        if (message.id && message.content) {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              messageId: message.id,
              content: { type: 'text', text: message.content },
            },
          });
        }
        break;
      }
      case 'response-completed': {
        if (message.reasoning) {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              ...(message.messageId ? { messageId: message.messageId } : {}),
              content: { type: 'text', text: message.reasoning },
            },
          });
        }
        if (message.content) {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              ...(message.messageId ? { messageId: message.messageId } : {}),
              content: { type: 'text', text: message.content },
            },
          });
        }
        break;
      }
      case 'tool': {
        if (!message.id || !message.toolName) {
          break;
        }
        await notifyToolCallStart(cx, sessionId, message.id, message.toolName, message.args);
        if (message.finished === true) {
          await notifyToolCallEnd(
            cx,
            sessionId,
            message.id,
            message.toolName,
            message.args,
            message.response ?? '',
          );
        }
        break;
      }
    }
  }
}

/** Attach the session-cumulative `usage` to a prompt response when any tokens were used. */
function withUsage(session: AcpSession, base: { stopReason: acp.PromptResponse['stopReason'] }): acp.PromptResponse {
  const { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens } = session.usage;
  if (inputTokens === 0 && outputTokens === 0 && cachedReadTokens === 0 && cachedWriteTokens === 0) {
    return base;
  }
  return {
    ...base,
    usage: {
      totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
      inputTokens,
      outputTokens,
      ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
      ...(cachedWriteTokens > 0 ? { cachedWriteTokens } : {}),
    },
  };
}

/** Shorten free text for a one-line status note. */
function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Answer an AiderDesk question on behalf of a client without an approval
 * surface. The server blocks the turn on `task.askQuestion()`, so a question
 * nobody answers leaves the turn waiting for the SSE timeout.
 */
async function answerPendingQuestion(
  host: string,
  port: number,
  session: AcpSession,
  sessionId: string,
  data: EventData,
  cx: acp.AgentContext,
): Promise<void> {
  if (!autoAnswersQuestions()) {
    return;
  }

  const taskId = data.taskId ?? session.taskId;
  if (!taskId) {
    return;
  }

  const chosen = chooseQuestionAnswer(data, answerMode());
  // A question without options needs free text, which this API cannot carry.
  // Decline it instead of submitting a meaningless "y": the turn ends either
  // way, and a decline is at least honest about not having an answer.
  const answer = chosen ?? 'n';
  const questionText = data.text ?? data.question ?? data.message ?? 'question';

  try {
    await answerQuestion(host, port, data.baseDir || session.cwd, taskId, answer);
    const how = chosen
      ? `with "${answer}"`
      : `with "${answer}" (free-text question, declined: no options)`;
    await notifyThought(cx, sessionId, `Auto-answered "${truncateText(questionText, 160)}" ${how}.`);
  } catch (error) {
    process.stderr.write(`Failed to auto-answer question: ${String(error)}\n`);
  }
}

/** Send a plain-text agent thought to the client (used for local errors). */
async function notifyThought(cx: acp.AgentContext, sessionId: string, text: string): Promise<void> {
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    },
  });
}

/** Short human-readable form of an ISO timestamp (date + HH:MM in local time). */
function formatTaskDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 16);
  }
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Order tasks newest-created first, falling back to `updatedAt` for tasks the
 * server did not date (task files written before `createdAt` existed). Undated
 * tasks go last so they cannot displace real dates, and equal dates keep the
 * server's order. `/tasks`, `/load #N` and `session/list` share this order, so
 * the number a client sees is the one it can load.
 */
function sortTasksNewestFirst(tasks: TaskSummary[]): TaskSummary[] {
  const timeOf = (task: TaskSummary): number | undefined => {
    const raw = task.createdAt ?? task.updatedAt;
    const time = raw ? Date.parse(raw) : NaN;
    return Number.isNaN(time) ? undefined : time;
  };

  return [...tasks].sort((a, b) => {
    const aTime = timeOf(a);
    const bTime = timeOf(b);
    if (aTime === undefined || bTime === undefined) {
      if (aTime === bTime) {
        return 0;
      }
      return aTime === undefined ? 1 : -1;
    }
    return bTime - aTime;
  });
}

/** Numbered, human-readable listing of a project's tasks (for the /tasks command). */
function formatTaskList(tasks: TaskSummary[]): string {
  const lines = tasks.map((task, index) => {
    const state = task.state ? ` (${task.state})` : '';
    const updated = task.updatedAt ? ` — updated ${formatTaskDate(task.updatedAt)}` : '';
    return `${index + 1}. ${task.name || '(untitled)'} [${task.id}]${state}${updated}`;
  });
  return `Tasks (${tasks.length}):\n${lines.join('\n')}`;
}

/** Compact reference to a task, as used in /load feedback. */
function formatTaskReference(task: TaskSummary): string {
  return `${task.name || '(untitled)'} [${task.id}]`;
}

/**
 * Resolve a /load target to a task: an exact id, a `#N`/`N` index into the
 * listing shown by /tasks (1-based), or a unique id prefix.
 */
function resolveTask(tasks: TaskSummary[], target: string): TaskSummary | undefined {
  const direct = tasks.find((task) => task.id === target);
  if (direct) {
    return direct;
  }
  const numberMatch = target.match(/^#?(\d+)$/);
  if (numberMatch) {
    const index = parseInt(numberMatch[1], 10) - 1;
    if (index >= 0 && index < tasks.length) {
      return tasks[index];
    }
  }
  const prefix = tasks.filter((task) => task.id.startsWith(target));
  return prefix.length === 1 ? prefix[0] : undefined;
}

/**
 * Extract the compacted summary from a task's context messages: the last
 * assistant response. The server replaces the context with
 * `[user message, ...skill activations, summary]` after a compaction, so the
 * trailing `response-completed` message holds the summary text.
 */
function extractCompactionSummary(messages: TaskReadMessage[] | undefined): string | undefined {
  if (!messages) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === 'response-completed' && message.content?.trim()) {
      return message.content.trim();
    }
  }
  return undefined;
}

export { getVersion };