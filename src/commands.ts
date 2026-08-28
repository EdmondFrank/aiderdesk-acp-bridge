import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import * as acp from '@agentclientprotocol/sdk';

import { fetchJSON } from './http';

/**
 * Slash-command support for the ACP bridge.
 *
 * AiderDesk's REST API exposes the commands available for a project via
 * `GET /api/project/commands`, which returns both file-based custom commands
 * (with their markdown templates) and extension-provided commands (without
 * templates). Custom commands are expanded by the bridge itself — argument
 * substitution (`{{1}}`, `{{2}}`, `{{ARGUMENTS}}`) and `!shell` lines — and
 * then streamed through the regular `POST /api/run-prompt` SSE flow, so no
 * server changes are required. Extension commands can only be executed by the
 * AiderDesk server, so they run best-effort through
 * `POST /api/project/custom-commands`.
 */

const SHELL_COMMAND_PREFIX = '!';
const SHELL_COMMAND_TIMEOUT = 30_000; // 30 seconds, mirrors AiderDesk
const SHELL_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB, mirrors AiderDesk
const PLACEHOLDER_PATTERN = /\{\{(\d+)\}\}/g;

interface ExecResult {
  stdout: string;
  stderr: string;
}

const execAsync = promisify(exec) as (
  command: string,
  options: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<ExecResult>;

/** A single command argument, as defined in the command's frontmatter. */
export type CommandArgument = {
  description: string;
  required?: boolean;
  options?: string[];
};

/** A command available in a project, as exposed by the AiderDesk REST API. */
export type BridgeCommand = {
  name: string;
  description: string;
  arguments: CommandArgument[];
  template?: string;
  includeContext?: boolean;
  autonomyMode?: string;
  skills?: string[];
};

export type CommandsData = {
  customCommands: BridgeCommand[];
  extensionCommands: BridgeCommand[];
};

type RawCommand = {
  name?: unknown;
  description?: unknown;
  arguments?: unknown;
  template?: unknown;
  includeContext?: unknown;
  autonomyMode?: unknown;
  skills?: unknown;
};

function normalizeCommand(raw: unknown): BridgeCommand | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const command = raw as RawCommand;
  if (typeof command.name !== 'string' || command.name === '') {
    return null;
  }

  return {
    name: command.name,
    description: typeof command.description === 'string' ? command.description : 'Not specified',
    arguments: Array.isArray(command.arguments)
      ? (command.arguments as CommandArgument[])
      : [],
    ...(typeof command.template === 'string' ? { template: command.template } : {}),
    ...(typeof command.includeContext === 'boolean' ? { includeContext: command.includeContext } : {}),
    ...(typeof command.autonomyMode === 'string' ? { autonomyMode: command.autonomyMode } : {}),
    ...(Array.isArray(command.skills) ? { skills: command.skills as string[] } : {}),
  };
}

/**
 * Fetch the commands available for a project from the AiderDesk server.
 * Returns empty lists on any failure so callers degrade gracefully.
 */
export async function fetchCommands(
  host: string,
  port: number,
  projectDir: string,
): Promise<CommandsData> {
  try {
    const response = await fetchJSON(
      host,
      port,
      `/api/project/commands?projectDir=${encodeURIComponent(projectDir)}`,
      'GET',
    );
    if (response.status !== 200) {
      return { customCommands: [], extensionCommands: [] };
    }
    const data = response.data as { customCommands?: unknown[]; extensionCommands?: unknown[] };
    return {
      customCommands: Array.isArray(data?.customCommands)
        ? data.customCommands.map(normalizeCommand).filter((c): c is BridgeCommand => c !== null)
        : [],
      extensionCommands: Array.isArray(data?.extensionCommands)
        ? data.extensionCommands.map(normalizeCommand).filter((c): c is BridgeCommand => c !== null)
        : [],
    };
  } catch {
    return { customCommands: [], extensionCommands: [] };
  }
}

/** Find a command by name across both custom and extension commands. */
export function findCommand(data: CommandsData, name: string): BridgeCommand | undefined {
  return (
    data.customCommands.find((c) => c.name === name) ??
    data.extensionCommands.find((c) => c.name === name)
  );
}

/**
 * Session-control commands that are built into the bridge and translated into
 * AiderDesk REST calls (`/project/tasks/new`, `/project/compact-conversation`,
 * `/project/smart-compact-conversation`, `/project/handoff-conversation`).
 * They are handled before the project's custom/extension commands, so they
 * cannot be shadowed.
 */
export const BUILT_IN_COMMANDS: BridgeCommand[] = [
  {
    name: 'new',
    description: 'Start a new task',
    arguments: [{ description: 'task name', required: false }],
  },
  {
    name: 'compact',
    description: 'Compact the conversation',
    arguments: [{ description: 'custom compact instructions', required: false }],
  },
  {
    name: 'smart-compact',
    description: 'Compact the conversation with an AI-generated summary',
    arguments: [],
  },
  {
    name: 'handoff',
    description: 'Hand off the conversation with a focus note',
    arguments: [{ description: 'focus note', required: false }],
  },
  {
    name: 'tasks',
    description: 'List the tasks for the current project',
    arguments: [],
  },
  {
    name: 'load',
    description: 'Load a task (by id or the #number shown in /tasks)',
    arguments: [{ description: 'task id or task number', required: true }],
  },
];

/** Extra spellings that map to a canonical built-in command. */
const BUILT_IN_ALIASES: Record<string, string> = {
  'hand-off': 'handoff',
};

/** Find a built-in command by name, resolving aliases to their canonical name. */
export function findBuiltInCommand(name: string): BridgeCommand | undefined {
  const canonicalName = BUILT_IN_ALIASES[name] ?? name;
  return BUILT_IN_COMMANDS.find((command) => command.name === canonicalName);
}

export type ParsedCommandLine = {
  name: string;
  args: string[];
};

/**
 * Parse a prompt that looks like a slash command (`/name arg1 arg2`).
 * Returns null when the text is not a command invocation — including a bare
 * "/" or "/ " — so callers can fall through to regular prompt handling.
 */
export function parseCommandText(text: string): ParsedCommandLine | null {
  if (!text.startsWith('/')) {
    return null;
  }
  const rest = text.slice(1);
  const whitespaceIndex = rest.search(/\s/);
  const name = whitespaceIndex === -1 ? rest : rest.slice(0, whitespaceIndex);
  if (!name) {
    return null;
  }
  const argsText = whitespaceIndex === -1 ? '' : rest.slice(whitespaceIndex).trim();
  return { name, args: argsText ? argsText.split(/\s+/) : [] };
}

/** Human-readable hint describing the arguments a command expects, if any. */
export function commandHint(command: BridgeCommand): string | undefined {
  if (command.arguments.length === 0) {
    return undefined;
  }
  return command.arguments
    .map((arg, index) => `${index + 1}: ${arg.description}${arg.required === false ? ' (optional)' : ''}`)
    .join(', ');
}

/**
 * Map project commands plus the built-in session-control commands to the ACP
 * `available_commands_update` payload. Aliases (e.g. `/hand-off`) are accepted
 * when invoked but only the canonical name is advertised.
 */
export function toAvailableCommands(data: CommandsData): acp.AvailableCommand[] {
  const commands = [...data.customCommands, ...data.extensionCommands, ...BUILT_IN_COMMANDS];
  return commands
    .map((command) => {
      const hint = commandHint(command);
      return {
        name: command.name,
        description: command.description,
        ...(hint ? { input: { hint } } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validate that enough arguments were supplied for a command's required
 * arguments. Returns a human-readable error message, or undefined when valid.
 */
export function validateRequiredArguments(
  command: BridgeCommand,
  args: string[],
): string | undefined {
  const requiredCount = command.arguments.filter((arg) => arg.required !== false).length;
  if (args.length >= requiredCount) {
    return undefined;
  }
  return (
    `Not enough arguments for command '${command.name}'. Expected arguments:\n` +
    command.arguments
      .map((arg, index) => `${index + 1}: ${arg.description}${arg.required === false ? ' (optional)' : ''}`)
      .join('\n')
  );
}

/**
 * Expand a command's template, substituting `{{ARGUMENTS}}`, positional
 * placeholders (`{{1}}`, `{{2}}`, ...) and dropping optional placeholders that
 * were not supplied. Mirrors AiderDesk's CustomCommandManager.
 */
export function substituteArguments(
  template: string,
  args: string[],
  commandArgs: CommandArgument[],
): string {
  let prompt = template;

  if (template.includes('{{ARGUMENTS}}')) {
    prompt = prompt.replaceAll('{{ARGUMENTS}}', args.join(' '));
  }

  for (let i = 0; i < args.length; i++) {
    const value = args[i] !== undefined ? args[i] : '';
    prompt = prompt.replaceAll(`{{${i + 1}}}`, value);
  }

  for (const placeholderIndex of findUnreplacedPlaceholders(template, args.length)) {
    const isOptional = commandArgs[placeholderIndex - 1]?.required === false;
    if (isOptional) {
      prompt = prompt.replaceAll(`{{${placeholderIndex}}}`, '');
    }
  }

  return prompt;
}

function findUnreplacedPlaceholders(template: string, argsLength: number): number[] {
  const unreplaced: number[] = [];
  const pattern = new RegExp(PLACEHOLDER_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    const placeholderIndex = parseInt(match[1], 10);
    if (placeholderIndex > argsLength) {
      unreplaced.push(placeholderIndex);
    }
  }
  return unreplaced;
}

/** Error raised when a `!shell` line in a command template fails. */
export class ShellCommandError extends Error {
  readonly command: string;
  readonly stderr: string;
  readonly exitCode?: number;

  constructor(message: string, command: string, stderr: string, exitCode?: number) {
    super(message);
    this.name = 'ShellCommandError';
    this.command = command;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Execute `!shell` lines embedded in an expanded command template, replacing
 * each with its output wrapped in AiderDesk's `<custom-command-bash>` markup.
 * Mirrors AiderDesk's CustomCommandManager.
 */
export async function executeShellCommands(prompt: string, cwd?: string): Promise<string> {
  const lines = prompt.split('\n');
  const finalPrompt: string[] = [];

  for (const line of lines) {
    if (!line.startsWith(SHELL_COMMAND_PREFIX)) {
      finalPrompt.push(line);
      continue;
    }

    const commandPortion = line.slice(SHELL_COMMAND_PREFIX.length).trim();
    if (!commandPortion) {
      // A line with just "!" is left as-is.
      finalPrompt.push(line);
      continue;
    }

    try {
      const { stdout } = await execAsync(commandPortion, {
        cwd,
        timeout: SHELL_COMMAND_TIMEOUT,
        maxBuffer: SHELL_MAX_BUFFER,
      });
      finalPrompt.push(...formatShellOutput(commandPortion, stdout.trim()));
    } catch (error) {
      const { stderr, exitCode } = extractErrorDetails(error);
      throw new ShellCommandError(
        `Shell command failed: ${commandPortion}`,
        commandPortion,
        stderr,
        exitCode,
      );
    }
  }

  return finalPrompt.join('\n');
}

type ShellExecError = Error & { stderr?: string; stdout?: string; code?: number };

function extractErrorDetails(error: unknown): { stderr: string; exitCode?: number } {
  if (error && typeof error === 'object' && 'stderr' in error && 'code' in error) {
    const execError = error as ShellExecError;
    return {
      stderr: execError.stderr || execError.message || String(error),
      exitCode: typeof execError.code === 'number' ? execError.code : undefined,
    };
  }
  return { stderr: error instanceof Error ? error.message : String(error) };
}

function formatShellOutput(command: string, output: string): string[] {
  return [
    '<custom-command-bash>',
    `<command>${command}</command>`,
    '<output>',
    output,
    '</output>',
    '</custom-command-bash>',
  ];
}

/**
 * Fully expand a file-based command: substitute arguments, then run any
 * `!shell` lines. Throws ShellCommandError when a shell line fails.
 */
export async function expandCommandTemplate(
  command: BridgeCommand,
  args: string[],
  cwd?: string,
): Promise<string> {
  if (!command.template) {
    throw new Error(`Command '${command.name}' has no template to expand`);
  }
  let prompt = substituteArguments(command.template, args, command.arguments);
  prompt = await executeShellCommands(prompt, cwd);
  return prompt;
}