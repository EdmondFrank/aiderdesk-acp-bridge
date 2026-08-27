import * as acp from '@agentclientprotocol/sdk';

const TOOL_KIND_MAP: Record<string, acp.ToolKind> = {
  read: 'read',
  list: 'read',
  view: 'read',
  get: 'read',
  edit: 'edit',
  write: 'edit',
  create: 'edit',
  modify: 'edit',
  store: 'edit',
  update: 'edit',
  delete: 'delete',
  remove: 'delete',
  move: 'move',
  rename: 'move',
  search: 'search',
  find: 'search',
  grep: 'search',
  glob: 'search',
  retrieve: 'search',
  exec: 'execute',
  run: 'execute',
  command: 'execute',
  bash: 'execute',
  think: 'think',
  plan: 'think',
  fetch: 'fetch',
  download: 'fetch',
};

export function inferToolKind(toolName: string): acp.ToolKind {
  const name = toolName.toLowerCase();
  for (const [pattern, kind] of Object.entries(TOOL_KIND_MAP)) {
    if (name.includes(pattern)) {
      return kind;
    }
  }
  return 'other';
}

export type ToolArgs = {
  filePath?: string;
  searchTerm?: string;
  replacementText?: string;
  content?: string;
  mode?: string;
  query?: string;
  pattern?: string;
  filePattern?: string;
  command?: string;
  url?: string;
  [key: string]: unknown;
};

export function parseToolArgs(args: unknown): ToolArgs {
  if (args && typeof args === 'object') {
    return args as ToolArgs;
  }
  if (typeof args === 'string') {
    try {
      return JSON.parse(args) as ToolArgs;
    } catch {
      return {};
    }
  }
  return {};
}

export function extractFilePath(toolName: string, args: ToolArgs): string | undefined {
  if (args.filePath) {
    return String(args.filePath);
  }
  if (args.path) {
    return String(args.path);
  }
  if (toolName === 'bash' && args.command) {
    return undefined;
  }
  return undefined;
}

export function formatToolInputAsText(toolName: string, args: ToolArgs): string {
  const parts: string[] = [];

  if (args.filePath) {
    parts.push(`File: ${args.filePath}`);
  }
  if (args.url) {
    parts.push(`URL: ${args.url}`);
  }
  if (args.query) {
    parts.push(`Query: ${args.query}`);
  }
  if (args.pattern) {
    parts.push(`Pattern: ${args.pattern}`);
  }
  if (args.filePattern) {
    parts.push(`Files: ${args.filePattern}`);
  }
  if (args.searchTerm) {
    parts.push(`Search: ${args.searchTerm}`);
  }
  if (args.command) {
    parts.push(`Command: ${args.command}`);
  }
  if (args.type) {
    parts.push(`Type: ${args.type}`);
  }
  if (args.limit !== undefined) {
    parts.push(`Limit: ${args.limit}`);
  }

  const knownKeys = new Set([
    'filePath',
    'path',
    'url',
    'query',
    'pattern',
    'filePattern',
    'searchTerm',
    'command',
    'type',
    'limit',
    'replacementText',
    'content',
    'mode',
    'isRegex',
    'replaceAll',
    'withLines',
    'lineOffset',
    'lineLimit',
    'caseSensitive',
    'maxResults',
    'cwd',
    'ignore',
    'allowTests',
    'exact',
    'timeout',
    'language',
    'id',
  ]);

  for (const [key, value] of Object.entries(args)) {
    if (!knownKeys.has(key) && value !== undefined) {
      const valStr = typeof value === 'string' && value.length > 200 ? value.slice(0, 200) + '...' : String(value);
      parts.push(`${key}: ${valStr}`);
    }
  }

  return parts.join('\n');
}

export function formatToolTitle(toolName: string, args: ToolArgs): string {
  const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '...' : s);

  switch (toolName) {
    case 'grep':
      return args.searchTerm ? `Grep: "${truncate(args.searchTerm, 60)}"${args.filePattern ? ` in ${args.filePattern}` : ''}` : 'Grep';
    case 'glob':
      return args.pattern ? `Glob: ${truncate(args.pattern, 80)}` : 'Glob';
    case 'semantic_search':
      return args.query ? `Semantic Search: ${truncate(args.query, 80)}` : 'Semantic Search';
    case 'bash':
      return args.command ? `Bash: ${truncate(args.command, 80)}` : 'Bash';
    case 'file_read':
      return args.filePath ? `Read: ${args.filePath}` : 'Read File';
    case 'file_edit':
      return args.filePath ? `Edit: ${args.filePath}` : 'Edit File';
    case 'file_write':
      return args.filePath ? `Write: ${args.filePath}` : 'Write File';
    case 'fetch':
      return args.url ? `Fetch: ${truncate(args.url, 80)}` : 'Fetch';
    default:
      return toolName.charAt(0).toUpperCase() + toolName.slice(1);
  }
}

export function parseToolResponse(response: string): unknown {
  if (!response) {
    return undefined;
  }
  try {
    return JSON.parse(response) as unknown;
  } catch {
    return response;
  }
}

export function isToolFailed(toolName: string, responseData: unknown): boolean {
  if (typeof responseData === 'string') {
    return (
      responseData.toLowerCase().startsWith('error') ||
      responseData.toLowerCase().includes('failed') ||
      responseData.toLowerCase().includes('denied') ||
      responseData.toLowerCase().includes('cancelled')
    );
  }
  return false;
}

export function buildToolCallContentArray(
  toolName: string,
  args: ToolArgs,
  responseData: unknown,
): acp.ToolCallContent[] {
  const content: acp.ToolCallContent[] = [];

  if (toolName === 'file_edit' && args.filePath && args.searchTerm !== undefined && args.replacementText !== undefined) {
    content.push({
      type: 'diff',
      path: args.filePath,
      oldText: args.searchTerm,
      newText: args.replacementText,
    });
    if (typeof responseData === 'string' && responseData.includes('Successfully')) {
      content.push({
        type: 'content',
        content: { type: 'text', text: responseData },
      });
    }
    return content;
  }

  if (toolName === 'file_write' && args.filePath) {
    content.push({
      type: 'diff',
      path: args.filePath,
      oldText: null,
      newText: args.content ?? '',
    });
    if (typeof responseData === 'string' && responseData.includes('Successfully')) {
      content.push({
        type: 'content',
        content: { type: 'text', text: responseData },
      });
    }
    return content;
  }

  if (toolName === 'file_read' && typeof responseData === 'string') {
    content.push({
      type: 'content',
      content: { type: 'text', text: responseData },
    });
    return content;
  }

  if (toolName === 'bash' && typeof responseData === 'string') {
    content.push({
      type: 'terminal',
      terminalId: typeof args._terminalId === 'string' ? args._terminalId : 'default',
    });
    content.push({
      type: 'content',
      content: { type: 'text', text: responseData },
    });
    return content;
  }

  if (toolName === 'grep') {
    const text =
      typeof responseData === 'string' && responseData
        ? responseData
        : typeof responseData === 'string' && responseData === ''
          ? 'No matches found.'
          : JSON.stringify(responseData, null, 2);
    content.push({
      type: 'content',
      content: { type: 'text', text },
    });
    return content;
  }

  if (toolName === 'glob') {
    let text: string;
    if (Array.isArray(responseData)) {
      if (responseData.length === 0) {
        text = 'No files found.';
      } else {
        text =
          `Found ${responseData.length} ${responseData.length === 1 ? 'file' : 'files'}:\n` +
          responseData.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
      }
    } else if (typeof responseData === 'string' && responseData) {
      text = responseData;
    } else if (typeof responseData === 'object' && responseData !== null) {
      text = JSON.stringify(responseData, null, 2);
    } else {
      text = 'No files found.';
    }
    content.push({
      type: 'content',
      content: { type: 'text', text },
    });
    return content;
  }

  if (toolName === 'semantic_search') {
    let text: string;
    if (typeof responseData === 'string' && responseData) {
      text = responseData;
    } else if (typeof responseData === 'object' && responseData !== null) {
      text = JSON.stringify(responseData, null, 2);
    } else {
      text = 'No results found.';
    }
    content.push({
      type: 'content',
      content: { type: 'text', text },
    });
    return content;
  }

  if (Array.isArray(responseData)) {
    const text = responseData.map((item) => (typeof item === 'string' ? item : JSON.stringify(item, null, 2))).join('\n');
    if (text) {
      content.push({
        type: 'content',
        content: { type: 'text', text },
      });
    }
    return content;
  }

  if (typeof responseData === 'object' && responseData !== null) {
    content.push({
      type: 'content',
      content: { type: 'text', text: JSON.stringify(responseData, null, 2) },
    });
    return content;
  }

  if (typeof responseData === 'string' && responseData) {
    content.push({
      type: 'content',
      content: { type: 'text', text: responseData },
    });
  }

  return content;
}

export type ContentBlocksResult = {
  prompt: string;
  images: string[];
};

export function contentBlocksToPrompt(blocks: acp.ContentBlock[]): ContentBlocksResult {
  const parts: string[] = [];
  const images: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'image':
        if (block.data) {
          images.push(block.data);
        }
        break;
      case 'resource': {
        const resource = block.resource;
        if (resource && 'text' in resource && resource.text) {
          parts.push(resource.text);
        }
        break;
      }
      case 'resource_link':
        parts.push(`@${block.name || block.uri}`);
        break;
    }
  }

  return { prompt: parts.join('\n\n'), images };
}

export function generateSessionId(): string {
  return `acp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}