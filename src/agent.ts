import * as acp from '@agentclientprotocol/sdk';

import pkg from '../package.json';
import { DEFAULT_AUTONOMY_MODE, DEFAULT_MODE, type ModeOption } from './constants';
import { callInterrupt, requestSSEStream } from './http';
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

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = generateSessionId();
    const cwd = params.cwd ?? '';

    const [agentProfiles, customModes, projectDefaultProfileId] = await Promise.all([
      fetchAgentProfiles(this.host, this.port),
      fetchCustomModes(this.host, this.port, cwd),
      fetchDefaultAgentProfileId(this.host, this.port, cwd),
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
    });

    const configOptions = buildConfigOptions(
      allModes,
      agentProfiles,
      DEFAULT_MODE,
      defaultProfileId,
      DEFAULT_AUTONOMY_MODE,
    );

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

      const requestBody: Record<string, unknown> = {
        prompt: promptText,
        projectDir: session.cwd,
        mode: session.mode,
        autonomyMode: session.autonomyMode,
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

      const sseResponse = await requestSSEStream(this.host, this.port, JSON.stringify(requestBody), abortController.signal);

      if (sseResponse.taskId && !session.taskId) {
        session.taskId = sseResponse.taskId;
      }
      session.sseStream = sseResponse.stream;

      const eventStream = parseSSEEvents(sseResponse.stream);
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
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  ...(eventData.messageId ? { messageId: eventData.messageId } : {}),
                  content: { type: 'text', text: eventData.reasoning },
                },
              });
            }
            if (eventData.chunk) {
              await cx.notify(acp.methods.client.session.update, {
                sessionId: params.sessionId,
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
                  sessionId: params.sessionId,
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
              await cx.notify(acp.methods.client.session.update, {
                sessionId: params.sessionId,
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
                sessionId: params.sessionId,
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
                sessionId: params.sessionId,
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
                sessionId: params.sessionId,
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
                sessionId: params.sessionId,
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
                sessionId: params.sessionId,
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
            return { stopReason: 'end_turn' };
          }

          case 'error': {
            process.stderr.write(`Server error: ${eventData.error || 'Unknown error'}\n`);
            return { stopReason: 'end_turn' };
          }
        }
      }

      if (abortController.signal.aborted) {
        return { stopReason: 'cancelled' };
      }

      return { stopReason: 'end_turn' };
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

export { getVersion };