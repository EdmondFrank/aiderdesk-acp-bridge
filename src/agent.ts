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
import { DEFAULT_AUTONOMY_MODE, DEFAULT_MODE, type ModeOption } from './constants';
import {
  callInterrupt,
  compactConversation,
  createTask,
  deleteTask,
  ensureProjectOpen,
  fetchInputHistory,
  fetchTask,
  handoffConversation,
  listTasks,
  loadTask,
  requestSSEStream,
  resumeTask,
  runCustomCommand,
  smartCompactConversation,
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
  fetchDefaultAgentProfileId,
  fetchProviderModels,
  getAllModes,
  isAgentProfileVisible,
  resolveDefaultProfileId,
  type AgentProfileInfo,
  type ModelInfo,
} from './modes';
import { parseSSEEvents } from './sse';
import {
  buildToolCallContentArray,
  contentBlocksToPrompt,
  extractFilePath,
  formatToolInputAsText,
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
  abortController?: AbortController;
  sseStream?: ReadableStream<Uint8Array>;
  mode: string;
  agentProfileId?: string;
  autonomyMode: string;
  allModes: ModeOption[];
  agentProfiles: AgentProfileInfo[];
  models: ModelInfo[];
  model?: string;
  commands: CommandsData;
  usage: AcpSessionUsage;
};

export class AcpAgent {
  private readonly sessions = new Map<string, AcpSession>();
  private lastAgentProfileId?: string;

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

    const configOptions = buildConfigOptions(
      session.allModes,
      session.agentProfiles,
      session.mode,
      session.agentProfileId,
      session.autonomyMode,
      session.models,
      session.model,
    );

    // Advertise slash commands once the session is created. The notification
    // is deferred so the session/new response is written to the client first
    // (a notification referencing an unknown session id would be dropped).
    const availableCommands = toAvailableCommands(session.commands);
    if (availableCommands.length > 0) {
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

    return {
      sessionId,
      configOptions,
      modes: buildModeState(session.allModes, session.mode),
    };
  }

  /**
   * Build a fresh AcpSession for the given working directory, fetching agent
   * profiles, custom modes, the project default profile, provider models and
   * slash commands. `taskId` is the server task the session is bound to (its
   * ACP session id).
   */
  private async createSession(cwd: string, taskId: string | undefined): Promise<AcpSession> {
    const [agentProfiles, customModes, projectDefaultProfileId, commands, models] = await Promise.all([
      fetchAgentProfiles(this.host, this.port),
      fetchCustomModes(this.host, this.port, cwd),
      fetchDefaultAgentProfileId(this.host, this.port, cwd),
      fetchCommands(this.host, this.port, cwd),
      fetchProviderModels(this.host, this.port),
    ]);
    const allModes = getAllModes(customModes);
    const defaultProfileId = resolveDefaultProfileId(agentProfiles, projectDefaultProfileId, this.lastAgentProfileId);

    return {
      cwd,
      taskId,
      mode: DEFAULT_MODE,
      agentProfileId: defaultProfileId,
      autonomyMode: DEFAULT_AUTONOMY_MODE,
      allModes,
      agentProfiles,
      models,
      commands,
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    };
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
        break;
      case 'autonomy_mode':
        session.autonomyMode = value;
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

    const configOptions = buildConfigOptions(
      session.allModes,
      session.agentProfiles,
      session.mode,
      session.agentProfileId,
      session.autonomyMode,
      session.models,
      session.model,
    );

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
   * Archived tasks are hidden; failures degrade to an empty list.
   */
  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const cwd = params.cwd ?? '';
    await ensureProjectOpen(this.host, this.port, cwd);
    const tasks = await listTasks(this.host, this.port, cwd);
    return {
      sessions: tasks
        .filter((task) => task.archived !== true)
        .map((task) => ({
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
   * creates a session bound to that task. The stored conversation is replayed
   * to the client as session updates so it can render the restored history.
   */
  async loadSession(params: acp.LoadSessionRequest, cx: acp.AgentContext): Promise<acp.LoadSessionResponse> {
    const sessionId = params.sessionId;
    const cwd = params.cwd ?? '';

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = await this.createSession(cwd, sessionId);
      this.sessions.set(sessionId, session);
    }

    const state = await loadTask(this.host, this.port, session.cwd || cwd, sessionId);
    if (state) {
      await replayTaskMessages(sessionId, state.messages, cx);
    }

    return {
      modes: buildModeState(session.allModes, session.mode),
      configOptions: buildConfigOptions(
        session.allModes,
        session.agentProfiles,
        session.mode,
        session.agentProfileId,
        session.autonomyMode,
        session.models,
        session.model,
      ),
    };
  }

  /**
   * Resume a task (`session/resume`): bind the session to the task and ask the
   * server to re-run the response to its last user message (best-effort).
   */
  async resumeSession(params: acp.ResumeSessionRequest, cx: acp.AgentContext): Promise<acp.ResumeSessionResponse> {
    const sessionId = params.sessionId;
    const cwd = params.cwd ?? '';

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = await this.createSession(cwd, sessionId);
      this.sessions.set(sessionId, session);
    }

    await resumeTask(this.host, this.port, session.cwd || cwd, sessionId);

    return {
      modes: buildModeState(session.allModes, session.mode),
      configOptions: buildConfigOptions(
        session.allModes,
        session.agentProfiles,
        session.mode,
        session.agentProfileId,
        session.autonomyMode,
        session.models,
        session.model,
      ),
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
    await deleteTask(this.host, this.port, session.cwd, params.sessionId);
    this.sessions.delete(params.sessionId);
  }

  async prompt(params: acp.PromptRequest, cx: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    const abortController = new AbortController();
    session.abortController = abortController;

    try {
      const { prompt: promptText, images } = contentBlocksToPrompt(params.prompt);

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
    const requestBody: Record<string, unknown> = {
      prompt: promptText,
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
    }
    session.sseStream = sseResponse.stream;

    return relaySse(session, sessionId, promptText, sseResponse.stream, cx, abortController);
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
          await notifyThought(cx, sessionId, `Started a new task${name ? `: ${name}` : ''}.`);
          return { stopReason: 'end_turn' };
        }
        case 'tasks': {
          await ensureProjectOpen(this.host, this.port, session.cwd);
          const tasks = await listTasks(this.host, this.port, session.cwd);
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
          const tasks = await listTasks(this.host, this.port, session.cwd);
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
          await compactConversation(
            this.host,
            this.port,
            session.cwd,
            session.taskId,
            session.mode,
            customInstructions,
          );
          await this.notifyCompactionResult(cx, sessionId, session.cwd, session.taskId, 'Conversation compacted.');
          return { stopReason: 'end_turn' };
        }
        case 'smart-compact': {
          if (!session.taskId) {
            await notifyThought(cx, sessionId, 'No conversation to compact yet. Send a message first.');
            return { stopReason: 'end_turn' };
          }
          await smartCompactConversation(this.host, this.port, session.cwd, session.taskId);
          await this.notifyCompactionResult(cx, sessionId, session.cwd, session.taskId, 'Conversation smart-compacted.');
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
   * After a compaction, relay the server's new compacted context summary to
   * the client so the session reflects what replaced the conversation.
   * Best-effort: falls back to the plain confirmation note when the summary
   * can't be fetched.
   */
  private async notifyCompactionResult(
    cx: acp.AgentContext,
    sessionId: string,
    projectDir: string,
    taskId: string,
    fallbackText: string,
  ): Promise<void> {
    const summary = extractCompactionSummary(await fetchTask(this.host, this.port, projectDir, taskId));
    if (summary) {
      await notifyThought(cx, sessionId, `${fallbackText} The conversation was replaced by this summary:\n\n${summary}`);
      return;
    }
    await notifyThought(cx, sessionId, fallbackText);
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
}

/**
 * Relay AiderDesk SSE events as ACP session updates until the stream ends or
 * is aborted. Used by both regular prompts and expanded custom commands.
 * Per-turn `usageReport` events are accumulated into the session so the final
 * response can carry a session-cumulative `usage` (ACP experimental field).
 */
async function relaySse(
  session: AcpSession,
  sessionId: string,
  promptText: string,
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
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used: (usage.sentTokens ?? 0) + (usage.receivedTokens ?? 0) + (usage.cacheReadTokens ?? 0),
              size: 0,
              ...(usage.agentTotalCost !== undefined ? { cost: { amount: usage.agentTotalCost, currency: 'USD' } } : {}),
            },
          });
        }
        break;
      }

      case 'tool': {
        const toolId = eventData.id || '';

        if (!eventData.finished) {
          const args = parseToolArgs(eventData.args);
          const filePath = extractFilePath(eventData.toolName ?? '', args);
          const inputText = formatToolInputAsText(eventData.toolName ?? '', args);
          const title = formatToolTitle(eventData.toolName ?? '', args);

          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: toolId,
              title,
              kind: inferToolKind(eventData.toolName ?? ''),
              status: 'in_progress',
              ...(eventData.args ? { rawInput: eventData.args } : {}),
              ...(filePath ? { locations: [{ path: filePath }] } : {}),
              ...(inputText
                ? {
                    content: [{ type: 'content' as const, content: { type: 'text' as const, text: inputText } }],
                  }
                : {}),
            },
          });
        } else {
          const args = parseToolArgs(eventData.args);
          const responseData = parseToolResponse(eventData.response ?? '');
          const failed = isToolFailed(eventData.toolName ?? '', responseData);
          const contentArray = buildToolCallContentArray(eventData.toolName ?? '', args, responseData);
          const inputText = formatToolInputAsText(eventData.toolName ?? '', args);

          const fullContent: acp.ToolCallContent[] = [];
          if (inputText) {
            fullContent.push({
              type: 'content',
              content: { type: 'text', text: inputText },
            });
          }
          fullContent.push(...contentArray);

          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: toolId,
              status: failed ? 'failed' : 'completed',
              ...(fullContent.length > 0 ? { content: fullContent } : {}),
            },
          });
        }
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
              content: { type: 'text', text: promptText },
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
        const args = parseToolArgs(message.args);
        const filePath = extractFilePath(message.toolName, args);
        const inputText = formatToolInputAsText(message.toolName, args);
        const title = formatToolTitle(message.toolName, args);

        if (message.finished !== true) {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: message.id,
              title,
              kind: inferToolKind(message.toolName),
              status: 'in_progress',
              ...(message.args !== undefined ? { rawInput: message.args } : {}),
              ...(filePath ? { locations: [{ path: filePath }] } : {}),
              ...(inputText
                ? { content: [{ type: 'content' as const, content: { type: 'text' as const, text: inputText } }] }
                : {}),
            },
          });
          break;
        }

        const responseData = parseToolResponse(message.response ?? '');
        const failed = isToolFailed(message.toolName, responseData);
        const contentArray = buildToolCallContentArray(message.toolName, args, responseData);
        const fullContent: acp.ToolCallContent[] = [];
        if (inputText) {
          fullContent.push({ type: 'content', content: { type: 'text', text: inputText } });
        }
        fullContent.push(...contentArray);

        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: message.id,
            status: failed ? 'failed' : 'completed',
            ...(fullContent.length > 0 ? { content: fullContent } : {}),
          },
        });
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