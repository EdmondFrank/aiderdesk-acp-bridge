import * as acp from '@agentclientprotocol/sdk';

/**
 * Tool names that name an ACP `ToolKind` outright.
 *
 * AiderDesk's own tools are spelled `snake_case` (`read_file`, `code_mode`), so
 * they are listed here; MCP-served tools carry a server prefix
 * (`desktop.read_file`) and fall through to the word match below.  `code_mode`
 * runs code in a sandbox, which ACP calls `execute`.
 */
const EXACT_TOOL_KINDS: Record<string, acp.ToolKind> = {
  file_read: 'read',
  read_file: 'read',
  file_edit: 'edit',
  edit_block: 'edit',
  file_write: 'edit',
  write_file: 'edit',
  file_delete: 'delete',
  file_move: 'move',
  execute_command: 'execute',
  bash: 'execute',
  code_mode: 'execute',
  grep: 'search',
  glob: 'search',
  search_files: 'search',
  semantic_search: 'search',
  fetch: 'fetch',
  think: 'think',
};

/**
 * Verbs that name an ACP `ToolKind` when they appear as a whole word.
 *
 * Whole words, not substrings: `name.includes('get')` reads `budget` as a read,
 * and `includes('run')` reads `prune` as an execute.  A name's later words are
 * more specific (`desktop.read_file` is a read, `file_delete` a delete).
 */
const KIND_WORDS: Record<string, acp.ToolKind> = {
  read: 'read',
  view: 'read',
  list: 'read',
  get: 'read',
  edit: 'edit',
  write: 'edit',
  patch: 'edit',
  create: 'edit',
  modify: 'edit',
  delete: 'delete',
  remove: 'delete',
  move: 'move',
  rename: 'move',
  search: 'search',
  find: 'search',
  grep: 'search',
  glob: 'search',
  query: 'search',
  retrieve: 'search',
  exec: 'execute',
  run: 'execute',
  command: 'execute',
  shell: 'execute',
  bash: 'execute',
  think: 'think',
  plan: 'think',
  fetch: 'fetch',
  download: 'fetch',
  http: 'fetch',
};

export function inferToolKind(toolName: string): acp.ToolKind {
  const name = toolName.toLowerCase();
  const exact = EXACT_TOOL_KINDS[name];
  if (exact) {
    return exact;
  }
  // `_`, `.` and `-` separate a name's words, so `todo.get_items` splits into
  // todo/get/items.
  const words = name.split(/[^a-z0-9]+/).filter(Boolean).reverse();
  for (const word of words) {
    const kind = KIND_WORDS[word];
    if (kind) {
      return kind;
    }
  }
  return 'other';
}

export type ToolArgs = {
  filePath?: string;
  /** AiderDesk's own spelling of `filePath'. */
  file_path?: string;
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
  if (args.file_path) {
    return String(args.file_path);
  }
  if (args.path) {
    return String(args.path);
  }
  if (toolName === 'bash' && args.command) {
    return undefined;
  }
  return undefined;
}

/**
 * Arguments that best say what a call is doing, most specific first.
 *
 * AiderDesk tool names are open-ended — MCP servers add their own — so a title
 * cannot come from a table of names alone. Clients render the title while the
 * call runs, and a generic one ("Code_mode", "Execute_command") leaves the user
 * with no idea what is actually being run.
 */
const PRIMARY_ARG_KEYS = [
  'command',
  'filePath',
  'file_path',
  'query',
  'pattern',
  'searchTerm',
  'url',
  'path',
  'code',
  'expression',
  'prompt',
  'content',
];

/** Shorten TEXT to MAX characters, marking the cut with a single `…`. */
function truncate(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}

/** Commands and code snippets span lines; a title or a summary cannot. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A call's most descriptive argument, on one line and shortened for a title. */
export function summarizeToolArgs(args: ToolArgs, maxLength = 80): string | undefined {
  const candidates: string[] = [];
  for (const key of PRIMARY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string') {
      candidates.push(value);
    }
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string') {
      candidates.push(value);
    }
  }

  for (const candidate of candidates) {
    const line = oneLine(candidate);
    if (line.length > 0) {
      return truncate(line, maxLength);
    }
  }
  return undefined;
}

export function formatToolTitle(toolName: string, args: ToolArgs): string {
  const path = args.filePath ?? args.file_path;

  switch (toolName) {
    case 'grep':
      return args.searchTerm ? `Grep: "${truncate(args.searchTerm, 60)}"${args.filePattern ? ` in ${args.filePattern}` : ''}` : 'Grep';
    case 'glob':
      return args.pattern ? `Glob: ${truncate(args.pattern, 80)}` : 'Glob';
    case 'semantic_search':
      return args.query ? `Semantic Search: ${truncate(args.query, 80)}` : 'Semantic Search';
    case 'search_files':
      return args.query
        ? `Search: ${truncate(oneLine(args.query), 80)}`
        : args.pattern
          ? `Search: ${truncate(args.pattern, 80)}`
          : 'Search';
    case 'bash':
    case 'execute_command':
      return args.command ? `Bash: ${truncate(oneLine(args.command), 80)}` : 'Bash';
    case 'file_read':
    case 'read_file':
      return path ? `Read: ${path}` : 'Read File';
    case 'file_edit':
    case 'edit_block':
      return path ? `Edit: ${path}` : 'Edit File';
    case 'file_write':
    case 'write_file':
      return path ? `Write: ${path}` : 'Write File';
    case 'fetch':
      return args.url ? `Fetch: ${truncate(args.url, 80)}` : 'Fetch';
    default: {
      // Every tool the cases above miss still gets a usable title: the name
      // alone when its arguments say nothing, otherwise name plus the one
      // argument that identifies the work.
      const name = toolName.charAt(0).toUpperCase() + toolName.slice(1);
      const summary = summarizeToolArgs(args);
      return summary ? `${name}: ${summary}` : name;
    }
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

/**
 * A response in the shape an MCP server returns: a `content` array plus an
 * `isError` flag.  AiderDesk hands MCP results through this shape, so a bridge
 * that forwards them verbatim makes clients render JSON instead of output.
 */
export type CallToolResultLike = {
  content: Record<string, unknown>[];
  isError?: boolean;
};

/** Return RESPONSE as a `CallToolResultLike`, or undefined for any other shape. */
export function asCallToolResult(responseData: unknown): CallToolResultLike | undefined {
  if (!responseData || typeof responseData !== 'object' || Array.isArray(responseData)) {
    return undefined;
  }
  const candidate = responseData as { content?: unknown };
  if (!Array.isArray(candidate.content)) {
    return undefined;
  }
  if (!candidate.content.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    return undefined;
  }
  return candidate as CallToolResultLike;
}

/** ANSI SGR sequences carry colour; ACP text content has no styling to apply. */
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, '');
}

/** The text of one MCP content block, falling back to its JSON shape. */
function mcpBlockText(block: Record<string, unknown>): string {
  if (typeof block.text === 'string') {
    return stripAnsi(block.text);
  }
  return JSON.stringify(block, null, 2);
}

/**
 * Return RESPONSE as the text a user reads, unwrapping an MCP result.
 *
 * Text blocks keep their own text, other blocks their JSON shape, and a plain
 * string is passed through: a client shows this, so escaped JSON is only noise.
 */
export function toolResultText(responseData: unknown): string {
  const result = asCallToolResult(responseData);
  if (result) {
    return result.content
      .map(mcpBlockText)
      .filter((text) => text.length > 0)
      .join('\n\n');
  }
  if (typeof responseData === 'string') {
    return stripAnsi(responseData);
  }
  if (Array.isArray(responseData)) {
    return responseData
      .map((item) => (typeof item === 'string' ? stripAnsi(item) : JSON.stringify(item, null, 2)))
      .join('\n');
  }
  if (responseData === undefined || responseData === null) {
    return '';
  }
  return JSON.stringify(responseData, null, 2);
}

/** Convert an MCP result's blocks to ACP tool-call content, keeping images. */
function mcpBlocksToToolCallContent(blocks: Record<string, unknown>[]): acp.ToolCallContent[] {
  const content: acp.ToolCallContent[] = [];
  for (const block of blocks) {
    if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      content.push({
        type: 'content',
        content: { type: 'image', data: block.data, mimeType: block.mimeType },
      });
    } else if (block.type === 'resource' && block.resource) {
      content.push({
        type: 'content',
        content: { type: 'resource', resource: block.resource },
      } as acp.ToolCallContent);
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      const name = typeof block.name === 'string' ? block.name : block.uri;
      content.push({
        type: 'content',
        content: { type: 'resource_link', uri: block.uri, name },
      } as acp.ToolCallContent);
    } else if (typeof block.text === 'string' && block.text.length > 0) {
      content.push({ type: 'content', content: { type: 'text', text: stripAnsi(block.text) } });
    }
  }
  return content;
}

/**
 * Whether a tool call failed.
 *
 * An MCP result states it (`isError`) and that answer is trusted as-is.  Plain
 * text counts only when it *starts* with a failure word: `includes` marked a
 * call failed whose output merely mentioned "failed" -- a file, say, that
 * contains the word.
 */
export function isToolFailed(_toolName: string, responseData: unknown): boolean {
  const result = asCallToolResult(responseData);
  if (result) {
    return result.isError === true;
  }
  if (typeof responseData !== 'string') {
    return false;
  }
  const text = responseData.trim();
  if (/^(?:error|failed|failure|denied)\b/i.test(text)) {
    return true;
  }
  return /\b(?:permission denied|action cancell?ed|operation not permitted)\b/i.test(text);
}

/**
 * The content a completed tool call reports: its output, never its input.
 *
 * ACP carries a call's arguments in `rawInput` and its *output* in `content`;
 * echoing the arguments here made every client render them as the result.  MCP
 * results are unwrapped so a client shows the text the tool produced rather
 * than a JSON envelope, and bash output is sent as text only: the bridge never
 * creates an ACP terminal, so a `terminal` block would name one the client
 * cannot show.
 */
export function buildToolCallContentArray(
  toolName: string,
  args: ToolArgs,
  responseData: unknown,
): acp.ToolCallContent[] {
  const text = toolResultText(responseData);
  const textBlock = (value: string): acp.ToolCallContent => ({
    type: 'content',
    content: { type: 'text', text: value },
  });

  if (toolName === 'file_edit' && args.filePath && args.searchTerm !== undefined && args.replacementText !== undefined) {
    const content: acp.ToolCallContent[] = [
      { type: 'diff', path: args.filePath, oldText: args.searchTerm, newText: args.replacementText },
    ];
    if (text) {
      content.push(textBlock(text));
    }
    return content;
  }

  if (toolName === 'file_write' && args.filePath) {
    const content: acp.ToolCallContent[] = [
      { type: 'diff', path: args.filePath, oldText: null, newText: args.content ?? '' },
    ];
    if (text) {
      content.push(textBlock(text));
    }
    return content;
  }

  if (toolName === 'glob') {
    if (Array.isArray(responseData)) {
      const files = responseData.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
      const heading =
        files.length === 0
          ? 'No files found.'
          : `Found ${files.length} ${files.length === 1 ? 'file' : 'files'}:\n${files.join('\n')}`;
      return [textBlock(heading)];
    }
    return [textBlock(text || 'No files found.')];
  }

  if (toolName === 'grep') {
    return [textBlock(text || 'No matches found.')];
  }

  if (toolName === 'semantic_search') {
    return [textBlock(text || 'No results found.')];
  }

  const result = asCallToolResult(responseData);
  if (result) {
    const content = mcpBlocksToToolCallContent(result.content);
    if (content.length > 0) {
      return content;
    }
  }
  return text ? [textBlock(text)] : [];
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