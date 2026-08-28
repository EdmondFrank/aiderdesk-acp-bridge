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
  handoffConversation,
  requestSSEStream,
  runCustomCommand,
  smartCompactConversation,
} from './http';
import {
  buildConfigOptions,
  buildModeState,
  fetchAgentProfiles,
  fetchCustomModes,
  fetchDefaultAgentProfileId,
  getAllModes,
  isAgentProfileVisible,
  resolveDefaultProfileId,
  type AgentProfileInfo,
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
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: true },
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
    const sessionId = generateSessionId();
    const cwd = params.cwd ?? '';

    const [agentProfiles, customModes, projectDefaultProfileId, commands] = await Promise.all([
      fetchAgentProfiles(this.host, this.port),
      fetchCustomModes(this.host, this.port, cwd),
      fetchDefaultAgentProfileId(this.host, this.port, cwd),
      fetchCommands(this.host, this.port, cwd),
    ]);
    const allModes = getAllModes(customModes);
    const defaultProfileId = resolveDefaultProfileId(agentProfiles, projectDefaultProfileId, this.lastAgentProfileId);

    this.sessions.set(sessionId, {
      cwd,
      mode: DEFAULT_MODE,
      agentProfileId: defaultProfileId,
      autonomyMode: DEFAULT_AUTONOMY_MODE,
      allModes,
      agentProfiles,
      commands,
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    });

    const configOptions = buildConfigOptions(
      allModes,
      agentProfiles,
      DEFAULT_MODE,
      defaultProfileId,
      DEFAULT_AUTONOMY_MODE,
    );

    // Advertise slash commands once the session is created. The notification
    // is deferred so the session/new response is written to the client first
    // (a notification referencing an unknown session id would be dropped).
    const availableCommands = toAvailableCommands(commands);
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
      modes: buildModeState(allModes, DEFAULT_MODE),
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
    }

    const configOptions = buildConfigOptions(
      session.allModes,
      session.agentProfiles,
      session.mode,
      session.agentProfileId,
      session.autonomyMode,
    );

    return { configOptions };
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
          await notifyThought(cx, sessionId, 'Conversation compacted.');
          return { stopReason: 'end_turn' };
        }
        case 'smart-compact': {
          if (!session.taskId) {
            await notifyThought(cx, sessionId, 'No conversation to compact yet. Send a message first.');
            return { stopReason: 'end_turn' };
          }
          await smartCompactConversation(this.host, this.port, session.cwd, session.taskId);
          await notifyThought(cx, sessionId, 'Conversation smart-compacted.');
          return { stopReason: 'end_turn' };
        }
        case 'handoff': {
          if (!session.taskId) {
            await notifyThought(cx, sessionId, 'No conversation to hand off yet. Send a message first.');
            return { stopReason: 'end_turn' };
          }
          const focus = args.join(' ').trim() || undefined;
          await handoffConversation(this.host, this.port, session.cwd, session.taskId, focus);
          await notifyThought(cx, sessionId, 'Conversation handed off.');
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

export { getVersion };